// Keeps Freqtrade paused while trading is halted, e.g. after it restarts in its initial
// "running" state. Checks every 30 s.
function startHaltGuard({ control, freqtrade, log, intervalMs = 30000 }) {
  const timer = setInterval(async () => {
    try {
      const ctl = await control.state();
      if (!ctl.installed || !ctl.halted) return;
      const cfg = await freqtrade.api('GET', '/show_config');
      if (String(cfg.state).toLowerCase() === 'running') {
        await freqtrade.api('POST', '/pause');
        log.warn('trading halted: re-paused Freqtrade after it reported state "running"');
      }
    } catch (e) {
      log.debug({ error: e.message }, 'halt guard check failed');
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

module.exports = { startHaltGuard };
