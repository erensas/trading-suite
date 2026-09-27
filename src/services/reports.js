// Read-only views over trade_db: overview KPIs, chart markers, trade tables, export.
// Synthetic Web3 rows (status INVALID_SYNTHETIC, db/migrations/002) are left out.
const { ifInstalled } = require('../db');

const toUnix = (d) => Math.floor(new Date(d).getTime() / 1000);

function createReports({ db, freqtrade, control, instruments, settings }) {
  async function overview() {
    const tradeLogs = await db.query(
      "SELECT count(*), COALESCE(sum(amount_out - amount_in), 0) AS net_pnl FROM trade_logs WHERE status IS DISTINCT FROM 'INVALID_SYNTHETIC'"
    );
    const dexStats = tradeLogs.rows[0] || { count: 0, net_pnl: 0 };

    const ft = await ifInstalled(
      db.query(`
        SELECT count(*) FILTER (WHERE is_open) AS open_cnt,
               count(*) FILTER (WHERE NOT is_open) AS closed_cnt,
               COALESCE(sum(close_profit_abs) FILTER (WHERE NOT is_open), 0) AS pnl,
               count(*) FILTER (WHERE NOT is_open AND close_profit_abs > 0) AS wins
        FROM trades`),
      { rows: [{}] }
    );
    const openTradesCount = parseInt(ft.rows[0].open_cnt || 0, 10);
    const closedTradesCount = parseInt(ft.rows[0].closed_cnt || 0, 10);
    const freqPnl = parseFloat(ft.rows[0].pnl || 0);
    const closedWins = parseInt(ft.rows[0].wins || 0, 10);

    let capital = null;
    try {
      const bal = await freqtrade.api('GET', '/balance');
      capital = { value: Number(bal.total), currency: bal.stake || 'USDT', source: 'freqtrade', dryRun: true };
      const cfg = await freqtrade.api('GET', '/show_config');
      capital.dryRun = !!cfg.dry_run;
    } catch (e) {}

    const ctl = await control.state().catch(() => ({ installed: false }));
    const score = await db.query('SELECT round(avg(profit_score), 1) AS avg FROM economist_signals').catch(() => ({ rows: [{}] }));
    const avgScore = score.rows[0].avg;

    return {
      totalRealizedPnlUsd: (parseFloat(dexStats.net_pnl || 0) + freqPnl).toFixed(2),
      capital,
      winRatePercent: closedTradesCount > 0 ? ((closedWins / closedTradesCount) * 100).toFixed(1) : null,
      profitScore: avgScore !== undefined && avgScore !== null ? Number(avgScore) : null,
      openTradesCount,
      totalExecutedTrades: parseInt(dexStats.count, 10) + closedTradesCount,
      systemStatus: !ctl.installed ? 'CONTROL PLANE NOT INSTALLED' : ctl.halted ? 'HALTED' : 'ACTIVE',
      profitGuardThresholdUsd: settings.values.profitGuardThresholdUsd,
    };
  }

  async function chartMarkers(symbol) {
    const markers = [];
    const found = await instruments.get(symbol).catch(() => null);
    const contract = found && found.inst.contract_address ? found.inst.contract_address.toLowerCase() : null;

    // Web3 executions are matched by token address; they carry no pair symbol.
    if (contract) {
      const dex = await db.query(
        `SELECT id, created_at, action, amount_in, amount_out, status FROM trade_logs
         WHERE lower(token_address) = $1 AND status IS DISTINCT FROM 'INVALID_SYNTHETIC'
         ORDER BY id DESC LIMIT 200`,
        [contract]
      );
      for (const r of dex.rows) {
        const pnl = (parseFloat(r.amount_out || 0) - parseFloat(r.amount_in || 0)).toFixed(4);
        markers.push({
          id: `dex_${r.id}`, time: toUnix(r.created_at), position: 'aboveBar',
          color: '#a855f7', shape: 'circle', text: `DEX ${r.action || ''} PnL ${pnl}`.trim(), kind: 'dex',
        });
      }
    }

    const ft = await ifInstalled(
      db.query(
        `SELECT id, pair, open_rate, close_rate, open_date, close_date, realized_profit, close_profit_abs, is_open
         FROM trades WHERE pair = $1 ORDER BY id DESC LIMIT 200`,
        [symbol]
      ),
      { rows: [] }
    );
    for (const t of ft.rows) {
      markers.push({
        id: `ft_open_${t.id}`, time: toUnix(t.open_date), position: 'belowBar',
        color: '#3b82f6', shape: 'arrowUp', text: `FT buy ${Number(t.open_rate)}`, kind: 'freqtrade',
      });
      if (!t.is_open && t.close_date) {
        const pnl = parseFloat(t.close_profit_abs ?? t.realized_profit ?? 0);
        markers.push({
          id: `ft_close_${t.id}`, time: toUnix(t.close_date), position: 'aboveBar',
          color: pnl >= 0 ? '#10b981' : '#f43f5e', shape: 'arrowDown',
          text: `FT sell ${Number(t.close_rate)} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)})`, kind: 'freqtrade',
        });
      }
    }

    const manual = await db.query('SELECT id, side, amount, price, created_at FROM manual_orders WHERE symbol = $1 ORDER BY id DESC LIMIT 100', [symbol]);
    for (const m of manual.rows) {
      const isBuy = m.side === 'BUY';
      markers.push({
        id: `manual_${m.id}`, time: toUnix(m.created_at), position: isBuy ? 'belowBar' : 'aboveBar',
        color: '#f59e0b', shape: isBuy ? 'arrowUp' : 'arrowDown', text: `Test ${m.side} ${Number(m.amount)}`, kind: 'manual',
      });
    }

    return markers.sort((a, b) => a.time - b.time);
  }

  async function economist(symbol) {
    const r = await db.query('SELECT * FROM economist_signals WHERE symbol = $1 LIMIT 1', [symbol]);
    return r.rows[0] || null;
  }

  async function recordOrder(o) {
    const r = await db.query(
      `INSERT INTO manual_orders (symbol, side, order_type, amount, price, status, pnl_usd)
       VALUES ($1, $2, $3, $4, $5, 'SIMULATED', 0.00) RETURNING *`,
      [o.symbol, o.side, o.order_type, o.amount, o.price]
    );
    return r.rows[0];
  }

  async function dexTrades() {
    const r = await db.query(`
      SELECT id, created_at, action, token_address, amount_in, amount_out, gas_used, status,
             (CAST(amount_out AS NUMERIC) - CAST(amount_in AS NUMERIC)) AS pnl_usd
      FROM trade_logs WHERE status IS DISTINCT FROM 'INVALID_SYNTHETIC'
      ORDER BY created_at DESC LIMIT 50`);
    return r.rows;
  }

  async function freqtradeTrades() {
    const r = await db.query(`
      SELECT id, pair, open_rate, close_rate, stake_amount, open_date, close_date,
             realized_profit, close_profit_abs, is_open, strategy, enter_tag, exit_reason
      FROM trades ORDER BY open_date DESC LIMIT 50`);
    return r.rows;
  }

  async function exportTradeLogs(limit) {
    const r = await db.query('SELECT * FROM trade_logs ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows;
  }

  return { overview, chartMarkers, economist, recordOrder, dexTrades, freqtradeTrades, exportTradeLogs };
}

const CSV_HEADER = 'id,tx_hash,token_address,action,amount_in,amount_out,gas_used,status,created_at';
function toCsv(rows) {
  if (!rows.length) return `${CSV_HEADER}\n`;
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') {
      // Quote, and defuse spreadsheet formulas (=, +, -, @ at the start of a cell); numeric
      // columns arrive as strings from pg, so plain numbers such as "-1.5" stay as they are.
      const formula = /^[=+\-@\t\r]/.test(v) && !/^[-+]?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(v);
      const safe = formula ? `'${v}` : v;
      return `"${safe.replace(/"/g, '""')}"`;
    }
    return v;
  };
  return [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(cell).join(','))].join('\n');
}

module.exports = { createReports, toCsv };
