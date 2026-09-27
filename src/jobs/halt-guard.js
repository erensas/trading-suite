// Keeps every Freqtrade bot paused while trading is halted, e.g. after one restarts in its
// initial "running" state. Checks every 30 s.
function startHaltGuard({ control, bots, freqtrade, log, intervalMs = 30000 }) {
  const timer = setInterval(async () => {
    try {
      const ctl = await control.state();
      if (!ctl.installed || !ctl.halted) return;
      if (bots) return await bots.repauseRunning();
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
