// Loaded first: sends script errors, and a note when the app has not started after 15 s,
// to the server log (journalctl -u trading-suite), so problems on a phone or another
// browser can be seen without its developer tools. Plain ES5 on purpose.
(function () {
  var sent = 0;
  var errors = [];
  function report(kind, detail) {
    if (sent >= 10) return;
    sent++;
    try {
      var body = JSON.stringify({ kind: kind, detail: detail, url: location.pathname + location.hash, ua: navigator.userAgent, secure: !!window.isSecureContext });
      fetch('api/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    var d = { message: String(e.message || (e.target && e.target.src ? 'failed to load ' + e.target.src : 'error')), source: e.filename || (e.target && e.target.src) || '', line: e.lineno || 0, col: e.colno || 0 };
    errors.push(d);
    report('error', d);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason || {};
    var d = { message: String(r.message || r), stack: String(r.stack || '').slice(0, 800) };
    errors.push(d);
    report('rejection', d);
  });
  window.__tsBooted = false;
  setTimeout(function () {
    if (window.__tsBooted) return;
    var TS = window.TS || {};
    report('not started', { errors: errors.length, hasTS: !!window.TS, candles: (TS.candles || []).length, symbol: TS.activeSymbol || null, pairs: (TS.pairs || []).length, scripts: Array.prototype.map.call(document.scripts, function (s) { return (s.src || '').split('/').pop(); }).join(',') });
  }, 15000);
})();
