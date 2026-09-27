-- Mark the Web3 scanner's mispriced flash-loan signals so reports stop counting them (2026-09-27).
--   From 17:31 UTC on 2026-09-27 the scanner (web3-dex-bot 2c73d4e..11aabdd) read UNI/USDC pools
--   in the wrong token order and logged a dry-run "opportunity" of about $1,850 net every
--   minute; fixed in web3-dex-bot 86626f9. A real DEX round trip does not return more than a
--   few percent, so every scanner signal whose return exceeds 5 % of its capital is marked.
-- The original rows are copied to trade_logs_synthetic_backup_20260927 first.
-- Undo: UPDATE trade_logs t SET status = b.status
--       FROM trade_logs_synthetic_backup_20260927 b WHERE t.id = b.id;

CREATE TABLE IF NOT EXISTS trade_logs_synthetic_backup_20260927 AS
    SELECT * FROM trade_logs WHERE FALSE;

INSERT INTO trade_logs_synthetic_backup_20260927
    SELECT * FROM trade_logs
    WHERE status IS DISTINCT FROM 'INVALID_SYNTHETIC'
      AND tx_hash LIKE 'FLASHLOAN_SIGNAL_%'
      AND amount_in > 0
      AND amount_out - amount_in > 0.05 * amount_in
      AND id NOT IN (SELECT id FROM trade_logs_synthetic_backup_20260927);

UPDATE trade_logs SET status = 'INVALID_SYNTHETIC'
    WHERE id IN (SELECT id FROM trade_logs_synthetic_backup_20260927)
      AND status IS DISTINCT FROM 'INVALID_SYNTHETIC';
