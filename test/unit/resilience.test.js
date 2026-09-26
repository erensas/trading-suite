const test = require('node:test');
const assert = require('node:assert/strict');
const { TokenBucket, CircuitBreaker, ProviderGuard } = require('../../lib/resilience');
const { ProviderError } = require('../../lib/providers');

const clock = (start = 1_000_000) => {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
};
const transient = (msg = 'HTTP 503') => new ProviderError(msg, { transient: true });

test('token bucket: burst, then waits at the configured rate', () => {
  const now = clock();
  const b = new TokenBucket({ perMinute: 60, burst: 2, now });
  assert.equal(b.reserve(), 0);
  assert.equal(b.reserve(), 0);
  assert.equal(b.reserve(), 1000); // third call waits one token interval (1/s)
  now.advance(3000);
  assert.equal(b.reserve(), 0);
});

test('circuit breaker opens after the threshold, half-opens after the cooldown, closes on success', () => {
  const now = clock();
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now });
  for (let i = 0; i < 3; i++) {
    cb.check('P');
    cb.failure(transient());
  }
  assert.equal(cb.state, 'open');
  assert.throws(() => cb.check('P'), (e) => e.code === 'circuit_open' && e.status === 503);
  now.advance(1001);
  cb.check('P'); // the trial call
  assert.equal(cb.state, 'half-open');
  assert.throws(() => cb.check('P'), /being retried/); // only one trial at a time
  cb.success();
  assert.equal(cb.state, 'closed');
  assert.equal(cb.failures, 0);
});

test('circuit breaker doubles the cooldown when the trial fails, up to the maximum', () => {
  const now = clock();
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, maxCooldownMs: 3000, now });
  cb.check('P');
  cb.failure(transient());
  now.advance(1001);
  cb.check('P');
  cb.failure(transient());
  assert.equal(cb.state, 'open');
  assert.equal(cb.cooldownMs, 2000);
  now.advance(2001);
  cb.check('P');
  cb.failure(transient());
  assert.equal(cb.cooldownMs, 3000);
});

test('guard: only transient errors count as failures', async () => {
  const now = clock();
  const guard = new ProviderGuard({ breaker: { failureThreshold: 2, cooldownMs: 60000 }, now });
  const p = { id: 1, name: 'Test', kind: 'freqtrade', config: {} };
  const notFound = new ProviderError('unknown symbol');
  for (let i = 0; i < 5; i++) await assert.rejects(guard.run(p, async () => Promise.reject(notFound)), /unknown symbol/);
  assert.equal(guard.status(p).state, 'closed');
  await assert.rejects(guard.run(p, async () => Promise.reject(transient())));
  await assert.rejects(guard.run(p, async () => Promise.reject(transient())));
  assert.equal(guard.status(p).state, 'open');
  let called = false;
  await assert.rejects(
    guard.run(p, async () => {
      called = true;
    }),
    (e) => e.code === 'circuit_open'
  );
  assert.equal(called, false, 'an open circuit does not call the provider');
});

test('guard: request budget from config.rate_limit_per_min, 429 when the wait is too long', async () => {
  const now = clock();
  const guard = new ProviderGuard({ maxWaitMs: 500, now });
  const p = { id: 2, name: 'Slow API', kind: 'rest_template', config: { rate_limit_per_min: 6 } };
  assert.equal(guard.status(p).ratePerMin, 6);
  await guard.run(p, async () => 'ok'); // burst of 1 (6/min / 6)
  await assert.rejects(guard.run(p, async () => 'ok'), (e) => e.code === 'rate_limited' && e.status === 429);
});

test('guard: kinds without a budget (GeckoTerminal, Freqtrade) are not rate limited here', () => {
  const guard = new ProviderGuard();
  assert.equal(guard.status({ id: 3, kind: 'geckoterminal', config: {} }).ratePerMin, null);
  assert.equal(guard.status({ id: 4, kind: 'binance', config: {} }).ratePerMin, 300);
});
