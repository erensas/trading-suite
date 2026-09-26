// Structured JSON logs (one object per line) on stdout, collected by journald:
//   journalctl -u trading-suite -o cat | jq 'select(.level >= 40)'
const pino = require('pino');

function createLogger(level = 'info') {
  return pino({
    level,
    base: { service: 'trading-suite' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: ['headers.authorization', 'headers.cookie'],
  });
}

module.exports = { createLogger };
