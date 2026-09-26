-- Mark synthetic trade_logs rows so dashboards and reports stop counting them (2026-09-26).
--   * 1,275 mock-simulation rows from 2026-09-21 17:42-21:18 UTC, each a fixed +$12.30.
--   * 2 test rows with the placeholder tx_hash '0xhash' (2026-09-20).
-- The original rows are copied to trade_logs_synthetic_backup_20260926 first.
-- Undo: UPDATE trade_logs t SET status = b.status
--       FROM trade_logs_synthetic_backup_20260926 b WHERE t.id = b.id;

BEGIN;

CREATE TABLE IF NOT EXISTS trade_logs_synthetic_backup_20260926 AS
    SELECT * FROM trade_logs WHERE FALSE;

INSERT INTO trade_logs_synthetic_backup_20260926
    SELECT * FROM trade_logs
    WHERE status <> 'INVALID_SYNTHETIC'
      AND (
            (action = 'FLASHLOAN_ARBITRAGE_UNISWAP_V3_SUSHISWAP'
             AND status = 'SIMULATED_SUCCESS'
             AND ROUND(amount_out - amount_in, 2) = 12.30
             AND created_at >= '2026-09-21' AND created_at < '2026-09-22')
         OR tx_hash = '0xhash'
      );

UPDATE trade_logs SET status = 'INVALID_SYNTHETIC'
    WHERE id IN (SELECT id FROM trade_logs_synthetic_backup_20260926)
      AND status <> 'INVALID_SYNTHETIC';

COMMIT;
