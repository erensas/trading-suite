// Request schemas (zod). Routes validate with src/http/middleware.js validate(); services
// can assume the shapes below.
const { z } = require('zod');
const { KINDS, TIMEFRAMES } = require('../lib/providers');

// HTML forms and query strings send strings; JSON callers send real types. Accept both.
const boolish = z.union([z.boolean(), z.enum(['true', 'false', '1', '0', 'on', 'off'])]).transform((v) => v === true || v === 'true' || v === '1' || v === 'on');
const emptyToNull = (v) => (v === '' || v === undefined ? null : v);
const optionalText = (max) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().max(max, `must be at most ${max} characters`).nullish()).transform((v) => v || null);

// ---- settings --------------------------------------------------------------------------
const SETTING_RULES = {
  profitGuardThresholdUsd: { type: 'number', min: 0, max: 10000, default: 1.0 },
  maxSlippagePct: { type: 'number', min: 0, max: 50, default: 1.0 },
  maxDrawdownLimitUsd: { type: 'number', min: 0, max: 1000000, default: 50.0 },
  defaultSymbol: { type: 'string', default: 'BTC/USDT' },
  defaultTimeframe: { type: 'enum', values: TIMEFRAMES, default: '15m' },
  candleLimit: { type: 'number', min: 50, max: 1000, integer: true, default: 300 },
  tickerRefreshSeconds: { type: 'number', min: 15, max: 3600, integer: true, default: 60 },
  showTradeMarkers: { type: 'boolean', default: true },
  showVolume: { type: 'boolean', default: true },
};

function settingSchema(rule) {
  if (rule.type === 'number') {
    const n = z.coerce
      .number({ error: 'must be a number' })
      .refine((v) => Number.isFinite(v) && v >= rule.min && v <= rule.max, `must be between ${rule.min} and ${rule.max}`);
    return rule.integer ? n.transform((v) => Math.round(v)) : n;
  }
  if (rule.type === 'boolean') return boolish;
  if (rule.type === 'enum') return z.enum(rule.values, { error: `must be one of ${rule.values.join(', ')}` });
  return z.string().trim().min(1, 'must be 1-50 characters').max(50, 'must be 1-50 characters');
}

const SETTING_SCHEMAS = Object.fromEntries(Object.entries(SETTING_RULES).map(([k, r]) => [k, settingSchema(r)]));
// Unknown keys are dropped; every known key is optional (a partial update).
const settingsPatch = z.object(SETTING_SCHEMAS).partial();

// ---- providers ---------------------------------------------------------------------------
const CREDENTIAL_ENV = /^[A-Z][A-Z0-9_]{1,63}$/;
const jsonObject = z
  .preprocess((v) => {
    if (typeof v !== 'string') return v;
    if (!v.trim()) return {};
    try {
      return JSON.parse(v);
    } catch (e) {
      return Symbol.for('invalid-json');
    }
  }, z.any())
  .superRefine((v, ctx) => {
    if (v === Symbol.for('invalid-json')) ctx.addIssue({ code: 'custom', message: 'config is not valid JSON' });
    else if (!v || typeof v !== 'object' || Array.isArray(v)) ctx.addIssue({ code: 'custom', message: 'config must be a JSON object' });
  });

const provider = z.object({
  name: z.string().trim().min(1, 'name must be 1-60 characters').max(60, 'name must be 1-60 characters'),
  kind: z.enum(Object.keys(KINDS), { error: `kind must be one of ${Object.keys(KINDS).join(', ')}` }),
  base_url: z.preprocess((v) => (typeof v === 'string' ? v.trim().replace(/\/+$/, '') : v), z.string().max(300).nullish()),
  enabled: boolish.default(true),
  config: jsonObject.default({}),
  credential_env: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z
      .string()
      .regex(CREDENTIAL_ENV, 'credential_env must be an UPPER_SNAKE_CASE variable name (the value goes in ~/.openclaw/credentials/market-providers.env)')
      .or(z.literal(''))
      .nullish()
      .transform((v) => v || null)
  ),
});
// PUT sends only what changed. The service merges it over the stored row and validates
// the result with the full schema (a zod .partial() would re-apply defaults such as
// enabled: true to fields the caller left out).
const patch = z.record(z.string(), z.unknown(), { error: 'body must be a JSON object' });

const idParam = z.object({ id: z.coerce.number({ error: 'id must be a number' }).int().positive('id must be a positive integer') });

// ---- instruments -------------------------------------------------------------------------
const INSTRUMENT_CATEGORIES = ['CEX', 'CEX_FUTURES', 'DEX', 'TRADFI'];
// BASE/QUOTE, BASE/QUOTE:SETTLE (futures, as ccxt and Freqtrade write them), or a ticker.
const SYMBOL = /^[A-Z0-9._₮^-]{1,24}(\/[A-Z0-9._₮-]{1,24}(:[A-Z0-9₮]{1,12})?)?$/iu;
const upperText = (max) => optionalText(max).transform((v) => (v ? v.toUpperCase() : null));

const instrument = z
  .object({
    symbol: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.string().regex(SYMBOL, 'symbol must look like BASE/QUOTE (or a ticker such as SPY)')),
    name: optionalText(100),
    category: z
      .string()
      .transform((v) => v.toUpperCase())
      .pipe(z.enum(INSTRUMENT_CATEGORIES, { error: `category must be one of ${INSTRUMENT_CATEGORIES.join(', ')}` })),
    base_asset: upperText(20),
    quote_asset: upperText(20),
    exchange: optionalText(50),
    contract_address: optionalText(120),
    network: optionalText(40).transform((v) => (v ? v.toLowerCase() : null)),
    provider_id: z.preprocess(emptyToNull, z.coerce.number().int().positive('provider_id must be a provider id').nullable()),
    provider_symbol: optionalText(120),
    is_active: boolish.default(true),
  })
  .transform((i) => {
    const [b, rest] = i.symbol.split('/');
    const q = rest ? rest.split(':')[0] : null;
    return { ...i, base_asset: i.base_asset || b, quote_asset: i.quote_asset || q || 'USD' };
  });

const symbolParam = z.object({ symbol: z.string().min(1).max(60) });

// ---- listings (several providers per instrument) --------------------------------------------
const listing = z.object({
  provider_id: z.coerce.number({ error: 'provider_id is required' }).int().positive('provider_id must be a provider id'),
  provider_symbol: optionalText(120),
  network: optionalText(40).transform((v) => (v ? v.toLowerCase() : null)),
  priority: z.coerce.number().int().min(0).max(1000).optional(),
  enabled: boolish.default(true),
});
const reorderIds = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(50) });

const importInstrument = z.object({
  symbol: z.string().trim().min(1).max(50),
  category: z.string(),
  name: z.string().max(200).nullish(),
  base_asset: z.string().max(20).nullish(),
  quote_asset: z.string().max(20).nullish(),
  exchange: z.string().max(50).nullish(),
  contract_address: z.string().max(120).nullish(),
  network: z.string().max(40).nullish(),
  listings: z.array(listing).min(1, 'at least one provider is required').max(10),
  watchlist_id: z.coerce.number().int().positive().nullish(),
});

// ---- watchlists ------------------------------------------------------------------------------
const WATCHLIST_COLUMNS = ['price', 'change', 'volume', 'provider', 'score', 'updated'];
const WATCHLIST_SORTS = ['manual', 'symbol', 'price', 'change', 'volume'];
const watchlist = z.object({
  name: z.string().trim().min(1, 'name must be 1-60 characters').max(60, 'name must be 1-60 characters'),
  columns: z.array(z.enum(WATCHLIST_COLUMNS, { error: `columns: one of ${WATCHLIST_COLUMNS.join(', ')}` })).max(WATCHLIST_COLUMNS.length).default(['price', 'change', 'volume']),
  sort: z.object({ by: z.enum(WATCHLIST_SORTS).default('manual'), dir: z.enum(['asc', 'desc']).default('asc') }).default({ by: 'manual', dir: 'asc' }),
  is_default: boolish.default(false),
  position: z.coerce.number().int().min(0).max(1000).optional(),
});
const watchlistItem = z.object({ symbol: z.string().trim().min(1).max(60) });
const reorderSymbols = z.object({ symbols: z.array(z.string().min(1).max(60)).max(1000) });
const watchlistItemParams = z.object({ id: z.coerce.number().int().positive(), symbol: z.string().min(1).max(60) });

const searchQuery = z.object({
  q: z.string().trim().min(1, 'q is required').max(60),
  providers: z.string().max(200).optional(),
});

// ---- market data and reports ---------------------------------------------------------------
const symbolQuery = z.object({ symbol: z.string().trim().min(1).max(60).optional() });
const candlesQuery = symbolQuery.extend({
  tf: z.enum(TIMEFRAMES, { error: `tf must be one of ${TIMEFRAMES.join(', ')}` }).optional(),
  limit: z.coerce.number({ error: 'limit must be a number' }).int().min(1).max(5000).optional(),
  listing: z.coerce.number().int().positive().optional(),
});
const pairsQuery = z.object({ all: z.enum(['0', '1']).optional() });
const exportQuery = z.object({
  format: z.enum(['json', 'csv'], { error: 'format must be json or csv' }).default('json'),
  limit: z.coerce.number().int().min(1).max(10000).default(500),
});
const binanceBookQuery = z.object({ symbol: z.string().trim().max(30).regex(/^[A-Za-z0-9/]+$/, 'symbol must be letters and digits').optional() });

const order = z.object({
  symbol: z.string({ error: 'symbol is required' }).trim().min(1, 'symbol is required').max(50),
  side: z
    .string({ error: 'side is required (BUY or SELL)' })
    .transform((v) => v.toUpperCase())
    .pipe(z.enum(['BUY', 'SELL'], { error: 'side must be BUY or SELL' })),
  amount: z.coerce.number({ error: 'amount must be a number' }).positive('amount must be positive').max(1e12),
  price: z.preprocess(emptyToNull, z.coerce.number().positive('price must be positive').max(1e12).nullable().default(null)),
  order_type: z
    .string()
    .transform((v) => v.toUpperCase())
    .pipe(z.enum(['MARKET', 'LIMIT'], { error: 'order_type must be MARKET or LIMIT' }))
    .default('MARKET'),
});

// ---- chart layouts and alerts -----------------------------------------------------------------
const Indicators = require('../public/indicators');
const INDICATOR_IDS = Object.keys(Indicators.DEFS);
const HEX = /^#[0-9a-fA-F]{6}$/;
const indicatorRef = z.object({
  id: z.enum(INDICATOR_IDS, { error: `indicator must be one of ${INDICATOR_IDS.join(', ')}` }),
  params: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
});
const chartLayout = z.object({
  scope: z.string().trim().min(1).max(60).default('default'),
  layout: z.object({
    indicators: z
      .array(
        indicatorRef.extend({
          uid: z.string().regex(/^[a-z0-9]{1,20}$/i),
          colors: z.record(z.string(), z.string().regex(HEX, 'colors must be #rrggbb')).default({}),
          visible: z.boolean().default(true),
        })
      )
      .max(20, 'at most 20 indicators per chart'),
    showVolume: z.boolean().default(true),
  }),
});
const ALERT_KINDS = ['price_above', 'price_below', 'change_above', 'change_below', 'indicator_above', 'indicator_below'];
const alert = z
  .object({
    symbol: z.string().trim().min(1).max(60),
    kind: z.enum(ALERT_KINDS, { error: `kind must be one of ${ALERT_KINDS.join(', ')}` }),
    value: z.coerce.number({ error: 'value must be a number' }).refine(Number.isFinite, 'value must be a number'),
    indicator: indicatorRef.extend({ output: z.string().max(20).optional() }).nullish(),
    timeframe: z.enum(TIMEFRAMES).nullish(),
    note: optionalText(200),
    repeat: boolish.default(false),
    enabled: boolish.default(true),
  })
  .superRefine((a, ctx) => {
    if (a.kind.startsWith('indicator_')) {
      if (!a.indicator) ctx.addIssue({ code: 'custom', path: ['indicator'], message: 'indicator alerts need an indicator' });
      if (!a.timeframe) ctx.addIssue({ code: 'custom', path: ['timeframe'], message: 'indicator alerts need a timeframe' });
      if (a.indicator && a.indicator.output && !Indicators.DEFS[a.indicator.id].outputs.some((o) => o.key === a.indicator.output)) {
        ctx.addIssue({ code: 'custom', path: ['indicator', 'output'], message: `output must be one of ${Indicators.DEFS[a.indicator.id].outputs.map((o) => o.key).join(', ')}` });
      }
    }
  });
const alertEventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50) });
const alertsSeen = z.object({ ids: z.array(z.coerce.number().int().positive()).max(500).optional(), all: z.boolean().optional() });

// ---- control plane -------------------------------------------------------------------------
const halt = z.object({ reason: z.string().trim().max(200).optional() });
const resume = z.object({ confirm: z.literal('RESUME', { error: 'Type RESUME to confirm' }) });
const serviceParams = z.object({ id: z.string().max(100), action: z.string().max(20) });

// ---- strategy center ------------------------------------------------------------------------
const STRATEGY_NAME = /^[A-Za-z_][A-Za-z0-9_]{2,60}$/;
const BOT_NAME = /^[a-z0-9][a-z0-9-]{1,29}$/;
const strategyParam = z.object({ name: z.string().regex(STRATEGY_NAME, 'name must be a Python class name') });
const botParam = z.object({ name: z.string().regex(BOT_NAME, 'unknown bot name') });
const strategySource = z.object({ source: z.string().min(1).max(210000), description: optionalText(200), origin: z.enum(['editor', 'upload', 'pine']).optional() });
const strategyImport = z.object({ kind: z.enum(['template', 'main']), name: z.string().regex(STRATEGY_NAME) });
const versionParams = strategyParam.extend({ id: z.coerce.number().int().positive() });
const BOT_ACTIONS = ['start', 'stop', 'pause', 'reload', 'start_process', 'stop_process', 'restart_process'];
const botAction = z.object({ action: z.enum(BOT_ACTIONS, { error: `action must be one of ${BOT_ACTIONS.join(', ')}` }) });
const botStrategy = z.object({ strategy: z.string().regex(STRATEGY_NAME, 'strategy must be a class name') });
const botDelete = z.object({ confirm: z.string().max(40) });
const journalQuery = z.object({ lines: z.coerce.number().int().min(10).max(2000).default(200) });
const goLive = z.object({ confirm: z.string().max(60) });
const exchangeKeys = z.object({ key: z.string().max(256), secret: z.string().max(256), password: z.string().max(128).nullish() });
const capitalLimit = z.object({ amount: z.coerce.number().positive().max(1e7) });
const venueRef = z.object({ venueId: z.coerce.number().int().positive() });
const backtestsQuery = z.object({ strategy: z.string().regex(STRATEGY_NAME).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

module.exports = {
  strategyParam,
  botParam,
  strategySource,
  strategyImport,
  versionParams,
  BOT_ACTIONS,
  botAction,
  botStrategy,
  botDelete,
  journalQuery,
  goLive,
  exchangeKeys,
  capitalLimit,
  backtestsQuery,
  venueRef,
  SETTING_RULES,
  SETTING_SCHEMAS,
  settingsPatch,
  provider,
  patch,
  idParam,
  INSTRUMENT_CATEGORIES,
  instrument,
  symbolParam,
  listing,
  reorderIds,
  importInstrument,
  WATCHLIST_COLUMNS,
  watchlist,
  watchlistItem,
  reorderSymbols,
  watchlistItemParams,
  searchQuery,
  symbolQuery,
  candlesQuery,
  pairsQuery,
  exportQuery,
  binanceBookQuery,
  order,
  halt,
  resume,
  serviceParams,
  chartLayout,
  ALERT_KINDS,
  alert,
  alertEventsQuery,
  alertsSeen,
};
