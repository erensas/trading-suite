const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed, buildTagger, tone, cleanText, assetOf } = require('../../src/services/news');
const Insights = require('../../public/insights');

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE rss [<!ENTITY boom "boom">]>
<rss version="2.0"><channel><title>t</title>
<item><title><![CDATA[Bitcoin surges past $100K as ETFs see inflows]]></title><link>https://example.com/a</link>
<guid isPermaLink="false">id-1</guid><pubDate>Sat, 26 Sep 2026 10:00:00 +0000</pubDate>
<description><![CDATA[<p>BTC &amp; ETH <b>rally</b>&nbsp;&#8212; more</p>]]></description></item>
<item><title>Exchange hacked; SOL and ONE tokens plunge</title><link>https://example.com/b</link><pubDate>bad date</pubDate></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Apple &amp;amp; Nvidia lead gains</title>
<link rel="alternate" href="https://example.com/c"/><id>tag:c</id><updated>2026-09-26T11:00:00Z</updated><summary>AAPL, NVDA</summary></entry></feed>`;

test('parseFeed: RSS with CDATA and entities, Atom, bad dates, no DOCTYPE expansion', () => {
  const rss = parseFeed(RSS);
  assert.equal(rss.length, 2);
  assert.equal(rss[0].title, 'Bitcoin surges past $100K as ETFs see inflows');
  assert.equal(rss[0].guid, 'id-1');
  assert.equal(rss[0].url, 'https://example.com/a');
  assert.equal(rss[0].summary, 'BTC & ETH rally — more');
  assert.equal(rss[0].published.toISOString(), '2026-09-26T10:00:00.000Z');
  assert.equal(rss[1].published, null);
  assert.equal(rss[1].guid, 'https://example.com/b');
  const atom = parseFeed(ATOM);
  assert.equal(atom[0].title, 'Apple & Nvidia lead gains');
  assert.equal(atom[0].url, 'https://example.com/c');
  assert.throws(() => parseFeed('<html><body>nope</body></html>'), /not an RSS or Atom feed/);
});

test('tagger: tickers in capitals, coin and company names, word tickers only by name', () => {
  const tag = buildTagger([
    { symbol: 'BTC/USDT', category: 'CEX', base_asset: 'BTC' },
    { symbol: 'BTC/USDT:USDT', category: 'CEX_FUTURES', base_asset: 'BTC' },
    { symbol: 'SOL/USDT', category: 'CEX', base_asset: 'SOL' },
    { symbol: 'ONE/USDT', category: 'CEX', base_asset: 'ONE' },
    { symbol: 'AAPL', category: 'TRADFI', name: 'Apple Inc.' },
    { symbol: 'NVDA', category: 'TRADFI', name: 'NVIDIA Corporation' },
    { symbol: 'F', category: 'TRADFI', name: 'Ford Motor Company' },
  ]);
  assert.deepEqual(tag('Bitcoin surges', ''), ['BTC']);
  assert.deepEqual(tag('Exchange hacked; SOL and ONE tokens plunge'), ['SOL']);
  assert.deepEqual(tag('Apple & Nvidia lead gains', 'AAPL, NVDA'), ['AAPL', 'NVDA']);
  assert.deepEqual(tag('Ford recalls cars; F shares fall'), ['F']);
  assert.deepEqual(tag('A sol-gel process and a stop order'), []);
  assert.deepEqual(tag('$SOL rallies'), ['SOL']);
});

test('tone, cleanText, assetOf', () => {
  assert.equal(tone('Bitcoin surges to a record high'), 1);
  assert.equal(tone('Exchange hacked, prices plunge'), -1);
  assert.equal(tone('Bitcoin trades sideways'), 0);
  assert.equal(cleanText('<script>x()</script><p>a&nbsp;&amp;&nbsp;b</p>'), 'a & b');
  assert.equal(cleanText('x'.repeat(500)).length, 400);
  assert.equal(assetOf('BTC/USDT:USDT', 'CEX_FUTURES'), 'BTC');
  assert.equal(assetOf('AAPL', 'TRADFI'), 'AAPL');
});

test('insights: regimes from candles', () => {
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const make = (f) => {
    let p = 100;
    return Array.from({ length: 300 }, (_, i) => {
      const o = p;
      p = f(p, i);
      return { time: 1_700_000_000 + i * 3600, open: o, high: Math.max(o, p) * 1.004, low: Math.min(o, p) * 0.996, close: p, volume: 100 };
    });
  };
  const up = Insights.analyze(make((p) => p * (1.004 + rnd() * 0.01)), { timeframe: '1h' });
  assert.equal(up.regime.kind, 'uptrend');
  assert.ok(up.strategies.some((s) => s.template === 'EmaCrossStrategy' && s.fit === 'good'));
  assert.ok(up.indicators.some((i) => i.id === 'supertrend'));
  const down = Insights.analyze(make((p) => p * (0.996 + rnd() * 0.01)), { timeframe: '1h' });
  assert.equal(down.regime.kind, 'downtrend');
  const flat = Insights.analyze(make(() => 100 + rnd() * 0.4), { timeframe: '1h' });
  assert.equal(flat.regime.kind, 'range');
  assert.ok(flat.indicators.some((i) => i.id === 'vwap'));
  assert.equal(Insights.analyze(make((p) => p).slice(0, 30)).ok, false);
});
