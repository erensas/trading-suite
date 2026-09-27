// Runs fn every intervalMs (first run after one interval), one run at a time; errors are logged.
function startInterval(name, intervalMs, fn, log) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      log.warn({ job: name, error: e.message }, 'job failed');
    } finally {
      running = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

module.exports = { startInterval };
