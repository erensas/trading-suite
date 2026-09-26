// Per-provider request budget and circuit breaker.
//
// Every call to a market data provider goes through ProviderGuard.run(provider, fn):
//   - a token bucket limits the requests per minute (the kind's ratePerMin, or
//     config.rate_limit_per_min on the provider row); a caller waits up to maxWaitMs for a
//     token, then gets a 429 instead of piling up;
//   - a circuit breaker opens after `failureThreshold` transient failures in a row
//     (network error, timeout, HTTP 5xx or 429; see ProviderError.transient) and fails fast
//     for `cooldownMs`. Then one trial call is let through (half-open): success closes the
//     circuit, failure opens it again with twice the cooldown, up to maxCooldownMs.

const { KINDS, ProviderError } = require('./providers');

class TokenBucket {
  constructor({ perMinute, burst, now = Date.now }) {
    this.capacity = Math.max(1, burst || Math.ceil(perMinute / 6));
    this.ratePerMs = perMinute / 60000;
    this.tokens = this.capacity;
    this.updated = now();
    this.now = now;
  }

  refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.updated) * this.ratePerMs);
    this.updated = t;
  }

  // Reserves a token and returns how long the caller has to wait for it (0 = now).
  reserve() {
    this.refill();
    this.tokens -= 1;
    return this.tokens >= 0 ? 0 : Math.ceil(-this.tokens / this.ratePerMs);
  }

  release() {
    this.tokens = Math.min(this.capacity, this.tokens + 1);
  }
}

class CircuitBreaker {
  constructor({ failureThreshold = 5, cooldownMs = 30000, maxCooldownMs = 300000, now = Date.now } = {}) {
    Object.assign(this, { failureThreshold, baseCooldownMs: cooldownMs, maxCooldownMs, now });
    this.state = 'closed';
    this.failures = 0;
    this.cooldownMs = cooldownMs;
    this.openUntil = 0;
    this.trialInFlight = false;
    this.lastError = null;
  }

  // Throws when the circuit is open; otherwise returns and the caller may proceed.
  check(name) {
    if (this.state === 'open') {
      const left = this.openUntil - this.now();
      if (left > 0) {
        throw new ProviderError(`${name} is paused after ${this.failures} failures in a row (${this.lastError}); retry in ${Math.ceil(left / 1000)} s`, {
          status: 503,
          code: 'circuit_open',
        });
      }
      this.state = 'half-open';
    }
    if (this.state === 'half-open') {
      if (this.trialInFlight) throw new ProviderError(`${name} is being retried; try again shortly`, { status: 503, code: 'circuit_open' });
      this.trialInFlight = true;
    }
  }

  success() {
    this.state = 'closed';
    this.failures = 0;
    this.cooldownMs = this.baseCooldownMs;
    this.trialInFlight = false;
    this.lastError = null;
  }

  failure(err) {
    this.failures += 1;
    this.lastError = String((err && err.message) || err).slice(0, 160);
    const wasTrial = this.state === 'half-open';
    this.trialInFlight = false;
    if (wasTrial) this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
    if (wasTrial || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openUntil = this.now() + this.cooldownMs;
    }
  }

  // The call never reached the provider (local rate limit): free the trial slot only.
  releaseTrial() {
    this.trialInFlight = false;
  }

  // The provider answered, but with an error about this request (e.g. unknown symbol):
  // it is up, so a half-open circuit closes.
  neutral() {
    if (this.state === 'half-open') {
      this.trialInFlight = false;
      this.state = 'closed';
      this.failures = 0;
      this.cooldownMs = this.baseCooldownMs;
    }
  }

  snapshot() {
    const retryInS = this.state === 'open' ? Math.max(0, Math.ceil((this.openUntil - this.now()) / 1000)) : 0;
    return { state: this.state, failures: this.failures, retryInS, lastError: this.lastError };
  }
}

const isFailure = (err) => !!(err && err.transient === true);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ProviderGuard {
  constructor({ maxWaitMs = 5000, breaker = {}, now = Date.now, kinds = KINDS } = {}) {
    Object.assign(this, { maxWaitMs, breakerOptions: breaker, now, kinds });
    this.entries = new Map();
  }

  static keyOf(provider) {
    return provider.id !== undefined && provider.id !== null ? `id:${provider.id}` : `${provider.kind}|${provider.base_url}`;
  }

  ratePerMin(provider) {
    const configured = Number(provider.config && provider.config.rate_limit_per_min);
    if (Number.isFinite(configured) && configured > 0) return configured;
    const kind = this.kinds[provider.kind];
    return kind && kind.ratePerMin ? kind.ratePerMin : null;
  }

  entry(provider) {
    const key = ProviderGuard.keyOf(provider);
    const rate = this.ratePerMin(provider);
    let e = this.entries.get(key);
    if (!e || e.rate !== rate) {
      e = {
        rate,
        bucket: rate ? new TokenBucket({ perMinute: rate, now: this.now }) : null,
        breaker: (e && e.breaker) || new CircuitBreaker({ ...this.breakerOptions, now: this.now }),
      };
      this.entries.set(key, e);
    }
    return e;
  }

  async run(provider, fn) {
    const name = provider.name || provider.kind;
    const { bucket, breaker } = this.entry(provider);
    breaker.check(name);
    if (bucket) {
      const wait = bucket.reserve();
      if (wait > this.maxWaitMs) {
        bucket.release();
        breaker.releaseTrial();
        throw new ProviderError(`${name}: request budget of ${this.ratePerMin(provider)}/min used up; retry in ${Math.ceil(wait / 1000)} s`, {
          status: 429,
          code: 'rate_limited',
        });
      }
      if (wait) await sleep(wait);
    }
    try {
      const result = await fn();
      breaker.success();
      return result;
    } catch (err) {
      if (isFailure(err)) breaker.failure(err);
      else breaker.neutral();
      throw err;
    }
  }

  status(provider) {
    const e = this.entries.get(ProviderGuard.keyOf(provider));
    const circuit = e ? e.breaker.snapshot() : { state: 'closed', failures: 0, retryInS: 0, lastError: null };
    return { ...circuit, ratePerMin: this.ratePerMin(provider) };
  }

  forget(provider) {
    this.entries.delete(ProviderGuard.keyOf(provider));
  }
}

module.exports = { TokenBucket, CircuitBreaker, ProviderGuard, isFailure };
