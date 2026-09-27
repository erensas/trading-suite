// Pine Script (v5 subset) for the trading suite: parser, bar-by-bar interpreter with a
// strategy simulator, and a converter to a Freqtrade strategy. Shared by the browser
// (window.Pine) and the tests (require('../public/pine')).
//
// Supported: indicator() / strategy(); variables (=, :=, +=, var), tuples ([a, b] = ...),
// if / else if / else, for loops, single- and multi-line functions (=>), the ternary
// operator, history (x[1]), inputs (input, input.int/float/bool/string/source), ta.* (sma,
// ema, rma, wma, hma, stdev, rsi, macd, bb, atr, tr, highest, lowest, change, mom, roc,
// crossover, crossunder, cross, stoch, cci, mfi, vwap, supertrend, dmi, obv, cum,
// barssince, valuewhen, rising, falling), math.*, nz / na / fixnan, color.*, plot,
// plotshape, plotchar, hline, and strategy.entry / close / close_all / exit (stop, limit).
// Orders fill at the next bar's open, as in TradingView's default.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class PineError extends Error {
    constructor(message, line) {
      super(line ? `line ${line}: ${message}` : message);
      this.line = line || null;
      this.reason = message;
    }
  }

  // ---- lexer --------------------------------------------------------------------------------
  const OPS = [':=', '=>', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '+', '-', '*', '/', '%', '<', '>', '=', '?', ':', '(', ')', '[', ']', ','];
  const TYPE_WORDS = new Set(['float', 'int', 'bool', 'string', 'color', 'series', 'simple', 'const']);
  // A line ending with one of these continues on the next line ("=>" does not: a function
// body may follow as an indented block).
const CONTINUES = new Set(['+', '-', '*', '/', '%', '<', '>', '==', '!=', '<=', '>=', '?', ':', ',', '=', ':=', 'and', 'or', 'not', '(', '[']);

  function lex(source) {
    const lines = String(source).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    const toks = [];
    const stack = [0];
    let depth = 0;
    let version = null;
    let continuing = false;
    const push = (t, v, line) => toks.push({ t, v, line });
    for (let li = 0; li < lines.length; li++) {
      const lineNo = li + 1;
      let text = lines[li];
      // Strip a comment that is not inside a string.
      let inStr = null;
      for (let k = 0; k < text.length; k++) {
        const ch = text[k];
        if (inStr) {
          if (ch === '\\') k++;
          else if (ch === inStr) inStr = null;
        } else if (ch === '"' || ch === "'") inStr = ch;
        else if (ch === '/' && text[k + 1] === '/') {
          const m = text.slice(k).match(/^\/\/\s*@version\s*=\s*(\d+)/);
          if (m) version = Number(m[1]);
          text = text.slice(0, k);
          break;
        }
      }
      if (!text.trim()) continue;
      const indent = text.match(/^ */)[0].length;
      const top = stack[stack.length - 1];
      // Continuation: inside brackets, after an operator, or indented by a non-multiple of 4.
      const isCont = depth > 0 || continuing || (indent > top && indent % 4 !== 0);
      if (!isCont) {
        if (indent > top) {
          stack.push(indent);
          push('indent', null, lineNo);
        } else {
          while (indent < stack[stack.length - 1]) {
            stack.pop();
            push('dedent', null, lineNo);
          }
          if (indent !== stack[stack.length - 1]) throw new PineError('inconsistent indentation', lineNo);
        }
      }
      let k = indent;
      let last = null;
      while (k < text.length) {
        const rest = text.slice(k);
        const ws = rest.match(/^\s+/);
        if (ws) {
          k += ws[0].length;
          continue;
        }
        let m;
        if ((m = rest.match(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?/))) {
          push('color', m[0], lineNo);
        } else if ((m = rest.match(/^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/))) {
          push('num', Number(m[0]), lineNo);
        } else if ((m = rest.match(/^(["'])((?:\\.|(?!\1).)*)\1/))) {
          push('str', m[2].replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] || c)), lineNo);
        } else if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/))) {
          push('id', m[0], lineNo);
        } else {
          const op = OPS.find((o) => rest.startsWith(o));
          if (!op) throw new PineError(`unexpected character "${rest[0]}"`, lineNo);
          m = [op];
          if (op === '(' || op === '[') depth++;
          if (op === ')' || op === ']') depth = Math.max(0, depth - 1);
          push('op', op, lineNo);
        }
        last = toks[toks.length - 1];
        k += m[0].length;
      }
      continuing = depth === 0 && last && CONTINUES.has(last.v) && !(last.t === 'op' && (last.v === ')' || last.v === ']'));
      if (depth === 0 && !continuing) push('nl', null, lineNo);
    }
    const end = lines.length;
    if (toks.length && toks[toks.length - 1].t !== 'nl') push('nl', null, end);
    while (stack.length > 1) {
      stack.pop();
      push('dedent', null, end);
    }
    push('eof', null, end);
    return { toks, version };
  }

  // ---- parser ---------------------------------------------------------------------------------
  function parse(source) {
    const { toks, version } = lex(source);
    let p = 0;
    let nextId = 1;
    const node = (type, line, props) => ({ type, line, id: nextId++, ...props });
    const peek = (o = 0) => toks[p + o];
    const at = (t, v, o = 0) => {
      const x = toks[p + o];
      return x && x.t === t && (v === undefined || x.v === v);
    };
    const next = () => toks[p++];
    const expect = (t, v) => {
      if (!at(t, v)) {
        const x = peek();
        throw new PineError(`expected ${v || t} but found ${x.t === 'nl' ? 'end of line' : x.v === null ? x.t : `"${x.v}"`}`, x.line);
      }
      return next();
    };
    const skipNl = () => {
      while (at('nl')) next();
    };
    // A statement ends at the end of its line; one that ends with a block already did.
    const endOfStatement = () => {
      if (!at('eof') && !at('dedent') && toks[p - 1].t !== 'dedent') expect('nl');
      skipNl();
    };

    function block() {
      expect('nl');
      skipNl();
      expect('indent');
      const body = [];
      while (!at('dedent') && !at('eof')) {
        body.push(statement());
        endOfStatement();
      }
      if (at('dedent')) next();
      return body;
    }

    // An identifier followed by "(...)" and "=>" defines a function.
    function isFuncDef() {
      if (!at('id') || !at('op', '(', 1)) return false;
      let d = 0;
      for (let q = p + 1; q < toks.length; q++) {
        const x = toks[q];
        if (x.t === 'op' && x.v === '(') d++;
        if (x.t === 'op' && x.v === ')') {
          d--;
          if (d === 0) return toks[q + 1] && toks[q + 1].t === 'op' && toks[q + 1].v === '=>';
        }
        if (x.t === 'nl' || x.t === 'eof') return false;
      }
      return false;
    }

    function statement() {
      const t = peek();
      if (at('id', 'if')) return ifStatement();
      if (at('id', 'for')) {
        next();
        const v = expect('id').v;
        expect('op', '=');
        const from = expr();
        expect('id', 'to');
        const to = expr();
        let step = null;
        if (at('id', 'by')) {
          next();
          step = expr();
        }
        return node('For', t.line, { name: v, from, to, step, body: block() });
      }
      if (at('id', 'var') || at('id', 'varip')) {
        next();
        if (at('id') && TYPE_WORDS.has(peek().v) && at('id', undefined, 1)) next();
        const name = expect('id').v;
        expect('op', '=');
        return node('Decl', t.line, { name, isVar: true, init: expr() });
      }
      if (at('id') && TYPE_WORDS.has(t.v) && at('id', undefined, 1) && at('op', '=', 2)) {
        next();
        const name = next().v;
        next();
        return node('Decl', t.line, { name, isVar: false, init: expr() });
      }
      if (at('op', '[')) {
        const save = p;
        next();
        const names = [];
        while (at('id')) {
          names.push(next().v);
          if (at('op', ',')) next();
          else break;
        }
        if (names.length && at('op', ']') && at('op', '=', 1)) {
          next();
          next();
          return node('TupleDecl', t.line, { names, init: expr() });
        }
        p = save;
      }
      if (isFuncDef()) {
        const name = next().v;
        expect('op', '(');
        const params = [];
        while (!at('op', ')')) {
          if (at('id') && TYPE_WORDS.has(peek().v) && at('id', undefined, 1)) next();
          const pn = expect('id').v;
          let def = null;
          if (at('op', '=')) {
            next();
            def = expr();
          }
          params.push({ name: pn, def });
          if (at('op', ',')) next();
        }
        expect('op', ')');
        expect('op', '=>');
        if (at('nl')) return node('FuncDef', t.line, { name, params, body: block() });
        return node('FuncDef', t.line, { name, params, body: [node('ExprStmt', t.line, { expr: expr() })] });
      }
      if (at('id') && at('op', '=', 1)) {
        const name = next().v;
        next();
        return node('Decl', t.line, { name, isVar: false, init: expr() });
      }
      if (at('id') && ['op'].includes(peek(1).t) && [':=', '+=', '-=', '*=', '/=', '%='].includes(peek(1).v)) {
        const name = next().v;
        const op = next().v;
        return node('Assign', t.line, { name, op, value: expr() });
      }
      return node('ExprStmt', t.line, { expr: expr() });
    }

    function ifStatement() {
      const t = expect('id', 'if');
      const cond = expr();
      const then = block();
      skipNl();
      let otherwise = null;
      if (at('id', 'else')) {
        const e = next();
        if (at('id', 'if')) otherwise = [ifStatement()];
        else otherwise = block();
        if (otherwise[0] && !otherwise[0].line) otherwise[0].line = e.line;
      }
      return node('If', t.line, { cond, then, otherwise });
    }

    function expr() {
      return ternary();
    }
    function ternary() {
      const cond = orExpr();
      if (at('op', '?')) {
        const t = next();
        const a = ternary();
        expect('op', ':');
        const b = ternary();
        return node('Ternary', t.line, { cond, a, b });
      }
      return cond;
    }
    const binaryLevel = (nextLevel, ops, kind = 'op') =>
      function level() {
        let left = nextLevel();
        while ((kind === 'op' && at('op') && ops.includes(peek().v)) || (kind === 'id' && at('id') && ops.includes(peek().v))) {
          const t = next();
          left = node('Binary', t.line, { op: t.v, left, right: nextLevel() });
        }
        return left;
      };
    function unary() {
      if (at('op', '-') || at('op', '+') || at('id', 'not')) {
        const t = next();
        return node('Unary', t.line, { op: t.v, arg: unary() });
      }
      return postfix();
    }
    const mul = binaryLevel(unary, ['*', '/', '%']);
    const add = binaryLevel(mul, ['+', '-']);
    const cmp = binaryLevel(add, ['<', '>', '<=', '>=']);
    const eq = binaryLevel(cmp, ['==', '!=']);
    const andExpr = binaryLevel(eq, ['and'], 'id');
    const orExpr = binaryLevel(andExpr, ['or'], 'id');

    function postfix() {
      let e = primary();
      while (at('op', '[')) {
        const t = next();
        const offset = expr();
        expect('op', ']');
        e = node('Index', t.line, { target: e, offset });
      }
      return e;
    }

    function primary() {
      const t = peek();
      if (at('num')) return next(), node('Num', t.line, { value: t.v });
      if (at('str')) return next(), node('Str', t.line, { value: t.v });
      if (at('color')) return next(), node('Color', t.line, { value: t.v });
      if (at('op', '(')) {
        next();
        const e = expr();
        expect('op', ')');
        return e;
      }
      if (at('op', '[')) {
        next();
        const items = [];
        while (!at('op', ']')) {
          items.push(expr());
          if (at('op', ',')) next();
          else break;
        }
        expect('op', ']');
        return node('Tuple', t.line, { items });
      }
      if (at('id')) {
        next();
        if (t.v === 'true' || t.v === 'false') return node('Bool', t.line, { value: t.v === 'true' });
        if (t.v === 'na') return node('Na', t.line, {});
        if (at('op', '(')) {
          next();
          const args = [];
          const named = {};
          while (!at('op', ')')) {
            if (at('id') && at('op', '=', 1)) {
              const k = next().v;
              next();
              named[k] = expr();
            } else {
              if (Object.keys(named).length) throw new PineError('positional argument after a named one', peek().line);
              args.push(expr());
            }
            if (at('op', ',')) next();
            else break;
          }
          expect('op', ')');
          return node('Call', t.line, { callee: t.v, args, named });
        }
        return node('Ident', t.line, { name: t.v });
      }
      throw new PineError(`unexpected ${t.t === 'nl' ? 'end of line' : t.v === null ? t.t : `"${t.v}"`}`, t.line);
    }

    const body = [];
    skipNl();
    while (!at('eof')) {
      if (at('dedent')) {
        next();
        continue;
      }
      body.push(statement());
      endOfStatement();
    }
    return { type: 'Program', body, version };
  }

  // ---- values -------------------------------------------------------------------------------
  const isNa = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
  const num = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : isNa(v) ? NaN : Number(v));
  const truthy = (v) => (typeof v === 'boolean' ? v : !isNa(v) && v !== 0);
  const COLORS = {
    aqua: '#00bcd4', black: '#363a45', blue: '#2962ff', fuchsia: '#e040fb', gray: '#787b86', green: '#4caf50', lime: '#00e676', maroon: '#880e4f',
    navy: '#311b92', olive: '#808000', orange: '#ff9800', purple: '#9c27b0', red: '#f23645', silver: '#b2b5be', teal: '#089981', white: '#ffffff', yellow: '#ffeb3b',
  };
  const PALETTE = ['#38bdf8', '#f59e0b', '#c084fc', '#34d399', '#f472b6', '#fbbf24', '#60a5fa', '#fb7185'];
  function colorNew(c, transp) {
    const m = String(c || '').match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
    if (!m) return c;
    const a = Math.max(0, Math.min(100, 100 - num(transp || 0))) / 100;
    return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
  }
  const CONSTANTS = {
    'strategy.long': 'long', 'strategy.short': 'short',
    'strategy.fixed': 'fixed', 'strategy.cash': 'cash', 'strategy.percent_of_equity': 'percent_of_equity',
    'strategy.commission.percent': 'percent', 'strategy.commission.cash_per_order': 'cash_per_order', 'strategy.commission.cash_per_contract': 'cash_per_contract',
    'location.abovebar': 'aboveBar', 'location.belowbar': 'belowBar', 'location.top': 'aboveBar', 'location.bottom': 'belowBar', 'location.absolute': 'inBar',
    'shape.triangleup': 'arrowUp', 'shape.arrowup': 'arrowUp', 'shape.labelup': 'arrowUp', 'shape.triangledown': 'arrowDown', 'shape.arrowdown': 'arrowDown', 'shape.labeldown': 'arrowDown',
    'shape.circle': 'circle', 'shape.square': 'square', 'shape.diamond': 'square', 'shape.xcross': 'square', 'shape.cross': 'square', 'shape.flag': 'square',
    'size.auto': 1, 'size.tiny': 0.5, 'size.small': 1, 'size.normal': 1.5, 'size.large': 2, 'size.huge': 2.5,
    'plot.style_line': 'line', 'plot.style_linebr': 'line', 'plot.style_stepline': 'line', 'plot.style_histogram': 'histogram', 'plot.style_columns': 'histogram',
    'plot.style_circles': 'circles', 'plot.style_cross': 'circles', 'plot.style_area': 'area', 'plot.style_areabr': 'area',
    'hline.style_dashed': 'dashed', 'hline.style_dotted': 'dotted', 'hline.style_solid': 'solid',
    'display.all': 'all', 'display.none': 'none',
    'math.pi': Math.PI, 'math.e': Math.E, 'math.phi': 1.618033988749895,
  };
  for (const [k, v] of Object.entries(COLORS)) CONSTANTS[`color.${k}`] = v;

  // ---- window helpers over arrays indexed by bar ----------------------------------------------
  const nanArray = (n) => new Float64Array(n).fill(NaN);
  function smaAt(a, i, n) {
    if (!(n >= 1) || i - n + 1 < 0) return NaN;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const v = a[j];
      if (Number.isNaN(v)) return NaN;
      s += v;
    }
    return s / n;
  }
  function wmaAt(a, i, n) {
    if (!(n >= 1) || i - n + 1 < 0) return NaN;
    let s = 0;
    for (let j = 0; j < n; j++) {
      const v = a[i - j];
      if (Number.isNaN(v)) return NaN;
      s += v * (n - j);
    }
    return s / ((n * (n + 1)) / 2);
  }
  function stdevAt(a, i, n) {
    const m = smaAt(a, i, n);
    if (Number.isNaN(m)) return NaN;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (a[j] - m) ** 2;
    return Math.sqrt(s / n);
  }
  function extremeAt(a, i, n, max) {
    if (!(n >= 1) || i - n + 1 < 0) return NaN;
    let m = NaN;
    for (let j = i - n + 1; j <= i; j++) {
      const v = a[j];
      if (Number.isNaN(v)) continue;
      if (Number.isNaN(m) || (max ? v > m : v < m)) m = v;
    }
    return m;
  }
  const sumAt = (a, i, n) => {
    if (!(n >= 1) || i - n + 1 < 0) return NaN;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) {
      if (Number.isNaN(a[j])) return NaN;
      s += a[j];
    }
    return s;
  };
  const round = (x) => Math.floor(x + 0.5);

  // ---- interpreter ---------------------------------------------------------------------------
  const MAX_STEPS = 5e6;

  function run(sourceOrAst, candles, { inputs: overrides = {}, symbol = '', timeframe = '' } = {}) {
    const ast = typeof sourceOrAst === 'string' ? parse(sourceOrAst) : sourceOrAst;
    const n = candles.length;
    const O = Float64Array.from(candles, (c) => num(c.open));
    const H = Float64Array.from(candles, (c) => num(c.high));
    const L = Float64Array.from(candles, (c) => num(c.low));
    const C = Float64Array.from(candles, (c) => num(c.close));
    const V = Float64Array.from(candles, (c) => num(c.volume || 0));
    const T = candles.map((c) => c.time);
    const out = { meta: { kind: null, title: 'Script', overlay: false }, inputs: [], plots: [], hlines: [], shapes: [], warnings: [], strategy: null, bars: n };
    const warned = new Set();
    const warn = (msg, line) => {
      if (warned.has(msg)) return;
      warned.add(msg);
      out.warnings.push(line ? `line ${line}: ${msg}` : msg);
    };
    let i = 0;
    let steps = 0;
    const sites = new Map();
    const varSeries = [];
    const funcs = new Map();
    const plotsBySite = new Map();
    const inputsBySite = new Map();
    let inputCount = 0;

    // Series of a variable: values by bar.
    class Frame {
      constructor(parent, key) {
        this.parent = parent;
        this.key = key;
        this.vars = new Map();
      }
      lookup(name) {
        for (let f = this; f; f = f.parent) if (f.vars.has(name)) return f.vars.get(name);
        return null;
      }
    }
    const newSeries = (isVar) => ({ v: new Array(n).fill(NaN), isVar, init: false });
    const global = new Frame(null, 'g');
    const childFrames = new Map();
    const child = (frame, key) => {
      const k = `${frame.key}/${key}`;
      let f = childFrames.get(k);
      if (!f) {
        f = new Frame(frame, k);
        childFrames.set(k, f);
      }
      return f;
    };
    const site = (frame, nd, init) => {
      const k = `${frame.key}:${nd.id}`;
      let s = sites.get(k);
      if (!s) {
        s = init ? init() : {};
        sites.set(k, s);
      }
      return s;
    };
    const arr = (s, name) => s[name] || (s[name] = nanArray(n));
    // Exponential smoothing that starts from the SMA of the first `len` values (ta.ema / ta.rma).
    function smooth(s, key, src, len, alpha) {
      const o = arr(s, key);
      const prev = i > 0 ? o[i - 1] : NaN;
      o[i] = Number.isNaN(prev) ? smaAt(src, i, len) : alpha * src[i] + (1 - alpha) * prev;
      return o[i];
    }
    const record = (s, key, v) => {
      arr(s, key)[i] = num(v);
      return s[key];
    };
    const trAt = (j, handleNa) => (j === 0 ? (handleNa ? H[0] - L[0] : NaN) : Math.max(H[j] - L[j], Math.abs(H[j] - C[j - 1]), Math.abs(L[j] - C[j - 1])));

    // ---- strategy simulation state
    const strat = {
      on: false, capital: 10000, qtyType: 'percent_of_equity', qtyValue: 100, commission: 0, commissionType: 'percent',
      pos: null, pending: [], exits: new Map(), trades: [], equity: nanArray(n), realized: 0, markers: [],
    };
    const posSize = () => (strat.pos ? strat.pos.dir * strat.pos.qty : 0);
    const fee = (price, qty) => (strat.commissionType === 'percent' ? (price * qty * strat.commission) / 100 : strat.commissionType === 'cash_per_order' ? strat.commission : strat.commission * qty);
    function closePos(price, bar, reason) {
      const p = strat.pos;
      if (!p) return;
      const gross = (price - p.price) * p.qty * p.dir;
      const net = gross - p.fee - fee(price, p.qty);
      strat.realized += net;
      strat.trades.push({
        id: p.id, dir: p.dir > 0 ? 'long' : 'short', qty: p.qty, entryTime: T[p.bar], entryPrice: p.price, exitTime: T[bar], exitPrice: price,
        profit: net, profitPct: ((price / p.price - 1) * 100 * p.dir), reason, bars: bar - p.bar,
      });
      strat.markers.push({ time: T[bar], position: p.dir > 0 ? 'aboveBar' : 'belowBar', color: net >= 0 ? '#34d399' : '#fb7185', shape: p.dir > 0 ? 'arrowDown' : 'arrowUp', text: reason === 'signal' ? `Close ${p.id}` : `${reason} ${p.id}` });
      strat.pos = null;
      strat.exits.clear();
    }
    function openPos(o, price, bar) {
      const equity = strat.capital + strat.realized;
      const qty = o.qty !== undefined && !Number.isNaN(o.qty) ? o.qty : strat.qtyType === 'fixed' ? strat.qtyValue : strat.qtyType === 'cash' ? strat.qtyValue / price : (equity * strat.qtyValue) / 100 / price;
      if (!(qty > 0)) return;
      strat.pos = { id: o.id, dir: o.dir, qty, price, bar, fee: fee(price, qty) };
      strat.markers.push({ time: T[bar], position: o.dir > 0 ? 'belowBar' : 'aboveBar', color: o.dir > 0 ? '#34d399' : '#fb7185', shape: o.dir > 0 ? 'arrowUp' : 'arrowDown', text: o.id });
    }
    // Orders from the previous bar fill at this bar's open; stop and limit exits inside the bar.
    function fillOrders(bar) {
      const orders = strat.pending;
      strat.pending = [];
      for (const o of orders) {
        if (o.kind === 'close' && strat.pos && (o.id === null || o.id === strat.pos.id)) closePos(O[bar], bar, 'signal');
      }
      for (const o of orders) {
        if (o.kind !== 'entry') continue;
        if (strat.pos && strat.pos.dir === o.dir) continue;
        if (strat.pos) closePos(O[bar], bar, 'reverse');
        openPos(o, O[bar], bar);
      }
      const p = strat.pos;
      if (!p) return;
      for (const ex of strat.exits.values()) {
        if (ex.from && ex.from !== p.id) continue;
        const stop = ex.stop;
        const limit = ex.limit;
        if (p.dir > 0) {
          if (!Number.isNaN(stop) && L[bar] <= stop) return closePos(Math.min(O[bar], stop), bar, 'stop');
          if (!Number.isNaN(limit) && H[bar] >= limit) return closePos(Math.max(O[bar], limit), bar, 'limit');
        } else {
          if (!Number.isNaN(stop) && H[bar] >= stop) return closePos(Math.max(O[bar], stop), bar, 'stop');
          if (!Number.isNaN(limit) && L[bar] <= limit) return closePos(Math.min(O[bar], limit), bar, 'limit');
        }
      }
    }

    // ---- built-in variables
    function builtinVar(name, frame, nd) {
      switch (name) {
        case 'open': return O[i];
        case 'high': return H[i];
        case 'low': return L[i];
        case 'close': return C[i];
        case 'volume': return V[i];
        case 'time': return T[i] * 1000;
        case 'bar_index': return i;
        case 'last_bar_index': return n - 1;
        case 'hl2': return (H[i] + L[i]) / 2;
        case 'hlc3': return (H[i] + L[i] + C[i]) / 3;
        case 'ohlc4': return (O[i] + H[i] + L[i] + C[i]) / 4;
        case 'barstate.isfirst': return i === 0;
        case 'barstate.islast': return i === n - 1;
        case 'barstate.isconfirmed': return true;
        case 'syminfo.ticker': case 'syminfo.tickerid': return symbol;
        case 'timeframe.period': return timeframe;
        case 'strategy.position_size': return posSize();
        case 'strategy.position_avg_price': return strat.pos ? strat.pos.price : NaN;
        case 'strategy.equity': return strat.capital + strat.realized + (strat.pos ? (C[i] - strat.pos.price) * strat.pos.qty * strat.pos.dir : 0);
        case 'strategy.netprofit': return strat.realized;
        case 'strategy.opentrades': return strat.pos ? 1 : 0;
        case 'strategy.closedtrades': return strat.trades.length;
        case 'strategy.initial_capital': return strat.capital;
        case 'ta.tr': return trAt(i, false);
        case 'ta.obv': {
          const s = site(frame, nd);
          const o = arr(s, 'o');
          const ch = i > 0 ? C[i] - C[i - 1] : NaN;
          const inc = Number.isNaN(ch) ? 0 : Math.sign(ch) * V[i];
          o[i] = (i > 0 ? o[i - 1] : 0) + inc;
          return o[i];
        }
        case 'ta.vwap': return vwap(site(frame, nd), (H[i] + L[i] + C[i]) / 3);
        case 'ta.accdist': {
          const s = site(frame, nd);
          const o = arr(s, 'o');
          const mfm = H[i] === L[i] ? 0 : ((C[i] - L[i]) - (H[i] - C[i])) / (H[i] - L[i]);
          o[i] = (i > 0 ? o[i - 1] : 0) + mfm * V[i];
          return o[i];
        }
        default:
          if (name in CONSTANTS) return CONSTANTS[name];
          return undefined;
      }
    }
    function vwap(s, src) {
      const day = Math.floor(T[i] / 86400);
      if (s.day !== day) {
        s.day = day;
        s.pv = 0;
        s.v = 0;
      }
      if (s.bar !== i) {
        s.bar = i;
        s.pv += src * V[i];
        s.v += V[i];
      }
      return s.v > 0 ? s.pv / s.v : src;
    }

    // ---- built-in functions: [parameter names, implementation(a, frame, node)]
    const B = {};
    const def = (names, params, fn) => {
      for (const nm of names.split(' ')) B[nm] = { params, fn };
    };
    const ta1 = (name, key, fnAt) =>
      def(name, ['source', 'length'], (a, f, nd) => {
        const s = site(f, nd);
        const src = record(s, 'src', a.source);
        return fnAt(src, i, Math.floor(num(a.length)), s);
      });
    ta1('ta.sma', 'sma', smaAt);
    ta1('ta.wma', 'wma', wmaAt);
    ta1('ta.stdev ta.dev_std', 'stdev', stdevAt);
    ta1('ta.ema', 'ema', (src, _i, len, s) => smooth(s, 'o', src, len, 2 / (len + 1)));
    ta1('ta.rma', 'rma', (src, _i, len, s) => smooth(s, 'o', src, len, 1 / len));
    ta1('math.sum', 'sum', sumAt);
    ta1('ta.hma', 'hma', (src, j, len, s) => {
      const a = arr(s, 'a');
      a[j] = 2 * wmaAt(src, j, Math.max(1, round(len / 2))) - wmaAt(src, j, len);
      return wmaAt(a, j, Math.max(1, round(Math.sqrt(len))));
    });
    ta1('ta.rsi', 'rsi', (src, j, len, s) => {
      const ch = j > 0 ? src[j] - src[j - 1] : NaN;
      arr(s, 'u')[j] = Number.isNaN(ch) ? NaN : Math.max(ch, 0);
      arr(s, 'd')[j] = Number.isNaN(ch) ? NaN : Math.max(-ch, 0);
      const up = smooth(s, 'ru', s.u, len, 1 / len);
      const dn = smooth(s, 'rd', s.d, len, 1 / len);
      if (Number.isNaN(up) || Number.isNaN(dn)) return NaN;
      return dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
    });
    ta1('ta.change', 'change', (src, j, len) => {
      const k = Number.isNaN(len) ? 1 : len;
      return j - k >= 0 ? src[j] - src[j - k] : NaN;
    });
    ta1('ta.mom', 'mom', (src, j, len) => (j - len >= 0 ? src[j] - src[j - len] : NaN));
    ta1('ta.roc', 'roc', (src, j, len) => (j - len >= 0 ? (100 * (src[j] - src[j - len])) / src[j - len] : NaN));
    ta1('ta.cci', 'cci', (src, j, len) => {
      const m = smaAt(src, j, len);
      if (Number.isNaN(m)) return NaN;
      let md = 0;
      for (let k = j - len + 1; k <= j; k++) md += Math.abs(src[k] - m);
      md /= len;
      return md === 0 ? 0 : (src[j] - m) / (0.015 * md);
    });
    ta1('ta.rising', 'rising', (src, j, len) => {
      if (j - len < 0) return false;
      for (let k = j - len + 1; k <= j; k++) if (!(src[k] > src[k - 1])) return false;
      return true;
    });
    ta1('ta.falling', 'falling', (src, j, len) => {
      if (j - len < 0) return false;
      for (let k = j - len + 1; k <= j; k++) if (!(src[k] < src[k - 1])) return false;
      return true;
    });
    const extreme = (max) => (a, f, nd) => {
      const s = site(f, nd);
      // ta.highest(length) uses high / low.
      const onlyLength = a.length === undefined || Number.isNaN(num(a.length));
      const src = record(s, 'src', onlyLength ? (max ? H[i] : L[i]) : a.source);
      return extremeAt(src, i, Math.floor(num(onlyLength ? a.source : a.length)), max);
    };
    def('ta.highest', ['source', 'length'], extreme(true));
    def('ta.lowest', ['source', 'length'], extreme(false));
    def('ta.cum', ['source'], (a, f, nd) => {
      const o = arr(site(f, nd), 'o');
      o[i] = (i > 0 ? o[i - 1] : 0) + (isNa(a.source) ? 0 : num(a.source));
      return o[i];
    });
    const crossFn = (kind) => (a, f, nd) => {
      const s = site(f, nd);
      const x = record(s, 'a', a.source1);
      const y = record(s, 'b', a.source2);
      if (i === 0) return false;
      const up = x[i] > y[i] && x[i - 1] <= y[i - 1];
      const down = x[i] < y[i] && x[i - 1] >= y[i - 1];
      return kind === 'over' ? up : kind === 'under' ? down : up || down;
    };
    def('ta.crossover', ['source1', 'source2'], crossFn('over'));
    def('ta.crossunder', ['source1', 'source2'], crossFn('under'));
    def('ta.cross', ['source1', 'source2'], crossFn('any'));
    def('ta.tr', ['handle_na'], (a) => trAt(i, truthy(a.handle_na)));
    def('ta.atr', ['length'], (a, f, nd) => {
      const s = site(f, nd);
      const len = Math.floor(num(a.length));
      arr(s, 'tr')[i] = trAt(i, true);
      return smooth(s, 'o', s.tr, len, 1 / len);
    });
    def('ta.macd', ['source', 'fastlen', 'slowlen', 'siglen'], (a, f, nd) => {
      const s = site(f, nd);
      const src = record(s, 'src', a.source);
      const fl = Math.floor(num(a.fastlen));
      const sl = Math.floor(num(a.slowlen));
      const gl = Math.floor(num(a.siglen));
      const m = smooth(s, 'f', src, fl, 2 / (fl + 1)) - smooth(s, 's', src, sl, 2 / (sl + 1));
      arr(s, 'm')[i] = m;
      const sig = smooth(s, 'g', s.m, gl, 2 / (gl + 1));
      return tuple([m, sig, m - sig]);
    });
    def('ta.bb', ['series', 'length', 'mult'], (a, f, nd) => {
      const s = site(f, nd);
      const src = record(s, 'src', a.series);
      const len = Math.floor(num(a.length));
      const mid = smaAt(src, i, len);
      const dev = num(a.mult) * stdevAt(src, i, len);
      return tuple([mid, mid + dev, mid - dev]);
    });
    def('ta.stoch', ['source', 'high', 'low', 'length'], (a, f, nd) => {
      const s = site(f, nd);
      const src = record(s, 'src', a.source);
      const hh = extremeAt(record(s, 'h', a.high), i, Math.floor(num(a.length)), true);
      const ll = extremeAt(record(s, 'l', a.low), i, Math.floor(num(a.length)), false);
      return hh === ll ? NaN : (100 * (src[i] - ll)) / (hh - ll);
    });
    def('ta.mfi', ['series', 'length'], (a, f, nd) => {
      const s = site(f, nd);
      const src = record(s, 'src', a.series);
      const len = Math.floor(num(a.length));
      const ch = i > 0 ? src[i] - src[i - 1] : NaN;
      arr(s, 'u')[i] = V[i] * (ch <= 0 ? 0 : src[i]);
      arr(s, 'd')[i] = V[i] * (ch >= 0 ? 0 : src[i]);
      const up = sumAt(s.u, i, len);
      const dn = sumAt(s.d, i, len);
      return 100 - 100 / (1 + up / dn);
    });
    def('ta.vwap', ['source'], (a, f, nd) => vwap(site(f, nd), num(a.source)));
    def('ta.supertrend', ['factor', 'atrPeriod'], (a, f, nd) => {
      const s = site(f, nd);
      const len = Math.floor(num(a.atrPeriod));
      arr(s, 'tr')[i] = trAt(i, true);
      const atr = smooth(s, 'atr', s.tr, len, 1 / len);
      const src = (H[i] + L[i]) / 2;
      const up = arr(s, 'up');
      const lo = arr(s, 'lo');
      const st = arr(s, 'st');
      const dir = arr(s, 'dir');
      let upper = src + num(a.factor) * atr;
      let lower = src - num(a.factor) * atr;
      const prevLower = i > 0 && !Number.isNaN(lo[i - 1]) ? lo[i - 1] : 0;
      const prevUpper = i > 0 && !Number.isNaN(up[i - 1]) ? up[i - 1] : 0;
      const prevClose = i > 0 ? C[i - 1] : NaN;
      lower = lower > prevLower || prevClose < prevLower ? lower : prevLower;
      upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper;
      const prevAtr = i > 0 ? s.atr[i - 1] : NaN;
      const prevSt = i > 0 ? st[i - 1] : NaN;
      let d;
      if (Number.isNaN(prevAtr)) d = 1;
      else if (prevSt === prevUpper) d = C[i] > upper ? -1 : 1;
      else d = C[i] < lower ? 1 : -1;
      up[i] = upper;
      lo[i] = lower;
      dir[i] = d;
      st[i] = d === -1 ? lower : upper;
      return tuple([Number.isNaN(atr) ? NaN : st[i], d]);
    });
    def('ta.dmi', ['diLength', 'adxSmoothing'], (a, f, nd) => {
      const s = site(f, nd);
      const len = Math.floor(num(a.diLength));
      const sm = Math.floor(num(a.adxSmoothing));
      const up = i > 0 ? H[i] - H[i - 1] : NaN;
      const down = i > 0 ? -(L[i] - L[i - 1]) : NaN;
      arr(s, 'pdm')[i] = Number.isNaN(up) ? NaN : up > down && up > 0 ? up : 0;
      arr(s, 'mdm')[i] = Number.isNaN(down) ? NaN : down > up && down > 0 ? down : 0;
      arr(s, 'tr')[i] = trAt(i, false);
      const trur = smooth(s, 'trur', s.tr, len, 1 / len);
      const fix = (key, v) => {
        const o = arr(s, key);
        o[i] = Number.isNaN(v) && i > 0 ? o[i - 1] : v;
        return o[i];
      };
      const plus = fix('plus', (100 * smooth(s, 'rp', s.pdm, len, 1 / len)) / trur);
      const minus = fix('minus', (100 * smooth(s, 'rm', s.mdm, len, 1 / len)) / trur);
      const sum = plus + minus;
      arr(s, 'dx')[i] = Math.abs(plus - minus) / (sum === 0 ? 1 : sum);
      const adx = 100 * smooth(s, 'adx', s.dx, sm, 1 / sm);
      return tuple([plus, minus, adx]);
    });
    def('ta.barssince', ['condition'], (a, f, nd) => {
      const s = site(f, nd);
      if (truthy(a.condition)) s.last = i;
      return s.last === undefined ? NaN : i - s.last;
    });
    def('ta.valuewhen', ['condition', 'source', 'occurrence'], (a, f, nd) => {
      const s = site(f, nd);
      s.hits = s.hits || [];
      if (s.bar !== i && truthy(a.condition)) s.hits.push(num(a.source));
      s.bar = i;
      const k = Math.floor(num(a.occurrence) || 0);
      return s.hits.length > k ? s.hits[s.hits.length - 1 - k] : NaN;
    });
    def('nz', ['source', 'replacement'], (a) => (isNa(a.source) ? (a.replacement === undefined ? 0 : a.replacement) : a.source));
    def('na', ['x'], (a) => isNa(a.x));
    def('fixnan', ['source'], (a, f, nd) => {
      const s = site(f, nd);
      if (!isNa(a.source)) s.last = a.source;
      return s.last === undefined ? NaN : s.last;
    });
    def('math.abs', ['number'], (a) => Math.abs(num(a.number)));
    def('math.sqrt', ['number'], (a) => Math.sqrt(num(a.number)));
    def('math.log', ['number'], (a) => Math.log(num(a.number)));
    def('math.log10', ['number'], (a) => Math.log10(num(a.number)));
    def('math.exp', ['number'], (a) => Math.exp(num(a.number)));
    def('math.sign', ['number'], (a) => Math.sign(num(a.number)));
    def('math.floor', ['number'], (a) => Math.floor(num(a.number)));
    def('math.ceil', ['number'], (a) => Math.ceil(num(a.number)));
    def('math.pow', ['base', 'exponent'], (a) => num(a.base) ** num(a.exponent));
    def('math.round', ['number', 'precision'], (a) => {
      const p = isNa(a.precision) ? 0 : num(a.precision);
      const m = 10 ** p;
      return Math.round(num(a.number) * m) / m;
    });
    const variadic = (fn) => ({ variadic: true, fn });
    B['math.max'] = variadic((xs) => (xs.some(isNa) ? NaN : Math.max(...xs.map(num))));
    B['math.min'] = variadic((xs) => (xs.some(isNa) ? NaN : Math.min(...xs.map(num))));
    B['math.avg'] = variadic((xs) => (xs.some(isNa) ? NaN : xs.reduce((x, y) => x + num(y), 0) / xs.length));
    def('str.tostring', ['value', 'format'], (a) => (isNa(a.value) ? 'NaN' : String(a.value)));
    def('int', ['x'], (a) => (isNa(a.x) ? NaN : Math.trunc(num(a.x))));
    def('float', ['x'], (a) => num(a.x));
    def('bool', ['x'], (a) => truthy(a.x));
    def('color.new', ['color', 'transp'], (a) => colorNew(a.color, a.transp));
    def('color.rgb', ['red', 'green', 'blue', 'transp'], (a) => `rgba(${num(a.red)}, ${num(a.green)}, ${num(a.blue)}, ${(100 - (num(a.transp) || 0)) / 100})`);

    // Declarations: indicator(), strategy(), inputs, plots, strategy orders.
    function declare(kind, a) {
      if (i > 0) return;
      out.meta = { kind, title: a.title || (kind === 'strategy' ? 'Strategy' : 'Indicator'), shorttitle: a.shorttitle || null, overlay: truthy(a.overlay), args: {} };
      for (const [k, v] of Object.entries(a)) if (!(typeof v === 'object' && v && v.tuple)) out.meta.args[k] = v;
      if (kind === 'strategy') {
        strat.on = true;
        if (!isNa(a.initial_capital)) strat.capital = num(a.initial_capital);
        if (a.default_qty_type) strat.qtyType = a.default_qty_type;
        if (!isNa(a.default_qty_value)) strat.qtyValue = num(a.default_qty_value);
        else if (a.default_qty_type === 'fixed') strat.qtyValue = 1;
        if (!isNa(a.commission_value)) strat.commission = num(a.commission_value);
        if (a.commission_type) strat.commissionType = a.commission_type;
        if (num(a.pyramiding) > 1) warn('pyramiding is not simulated: one position at a time');
      }
    }
    const DECL_PARAMS = ['title', 'shorttitle', 'overlay', 'format', 'precision', 'scale', 'max_bars_back'];
    def('indicator study', DECL_PARAMS, (a) => declare('indicator', a));
    def('strategy', ['title', 'shorttitle', 'overlay', 'format', 'precision', 'scale', 'pyramiding', 'calc_on_order_fills', 'calc_on_every_tick', 'max_bars_back', 'backtest_fill_limits_assumption', 'default_qty_type', 'default_qty_value', 'initial_capital', 'currency', 'slippage', 'commission_type', 'commission_value'], (a) => declare('strategy', a));

    function input(kind) {
      return (a, f, nd) => {
        let s = inputsBySite.get(nd.id);
        if (!s) {
          const title = a.title || `Input ${inputCount + 1}`;
          const key = String(title);
          let value = a.defval;
          if (Object.prototype.hasOwnProperty.call(overrides, key)) value = overrides[key];
          const type = kind === 'auto' ? (typeof a.defval === 'boolean' ? 'bool' : typeof a.defval === 'string' ? 'string' : Number.isInteger(a.defval) ? 'int' : 'float') : kind;
          if (type === 'int') value = Math.round(num(value));
          if (type === 'float') value = num(value);
          if (type === 'bool') value = value === true || value === 'true';
          s = { value, index: inputCount++ };
          inputsBySite.set(nd.id, s);
          const sourceName = kind === 'source' ? sourceNameOf(nd.args[0] || nd.named.defval) : null;
          out.inputs.push({ key, title: key, type, defval: kind === 'source' ? sourceName : a.defval, value: kind === 'source' ? sourceName : value, min: isNa(a.minval) ? null : a.minval, max: isNa(a.maxval) ? null : a.maxval, step: isNa(a.step) ? null : a.step, options: Array.isArray(a.options) ? a.options : null, line: nd.line });
          if (kind === 'source') {
            const pick = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : sourceName;
            s.source = SOURCE_NAMES.includes(pick) ? pick : sourceName;
          }
        }
        if (kind === 'source') return builtinVar(s.source);
        return s.value;
      };
    }
    const INPUT_PARAMS = ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm', 'options'];
    def('input', INPUT_PARAMS, input('auto'));
    def('input.int', INPUT_PARAMS, input('int'));
    def('input.float', INPUT_PARAMS, input('float'));
    def('input.bool', ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm'], input('bool'));
    def('input.string', ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm'], input('string'));
    def('input.source', ['defval', 'title', 'tooltip', 'inline', 'group'], input('source'));
    def('input.timeframe', ['defval', 'title'], input('string'));
    def('input.color', ['defval', 'title'], input('string'));

    def('plot', ['series', 'title', 'color', 'linewidth', 'style', 'trackprice', 'histbase', 'offset', 'join', 'editable', 'show_last', 'display'], (a, f, nd) => {
      let p = plotsBySite.get(nd.id);
      if (!p) {
        p = { title: a.title || `Plot ${out.plots.length + 1}`, color: typeof a.color === 'string' ? a.color : PALETTE[out.plots.length % PALETTE.length], linewidth: num(a.linewidth) || 1, style: a.style || 'line', values: new Array(n).fill(NaN), colors: new Array(n).fill(null), line: nd.line };
        plotsBySite.set(nd.id, p);
        out.plots.push(p);
      }
      p.values[i] = num(a.series);
      if (typeof a.color === 'string') p.colors[i] = a.color;
      return nd.id;
    });
    const shapeFn = (isChar) => (a, f, nd) => {
      if (!truthy(a.series)) return;
      const loc = a.location || (isChar ? 'aboveBar' : 'aboveBar');
      out.shapes.push({ time: T[i], position: loc, color: typeof a.color === 'string' ? a.color : '#38bdf8', shape: isChar ? 'circle' : a.style || 'circle', text: isChar ? a.char || a.text || '' : a.text || '', title: a.title || '' });
    };
    def('plotshape', ['series', 'title', 'style', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size'], shapeFn(false));
    def('plotchar', ['series', 'title', 'char', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size'], shapeFn(true));
    def('plotarrow', ['series', 'title', 'colorup', 'colordown'], (a) => {
      const v = num(a.series);
      if (!v || Number.isNaN(v)) return;
      out.shapes.push({ time: T[i], position: v > 0 ? 'belowBar' : 'aboveBar', color: v > 0 ? a.colorup || '#34d399' : a.colordown || '#fb7185', shape: v > 0 ? 'arrowUp' : 'arrowDown', text: '' });
    });
    def('hline', ['price', 'title', 'color', 'linestyle', 'linewidth', 'editable'], (a, f, nd) => {
      if (!out.hlines.some((h) => h.id === nd.id)) out.hlines.push({ id: nd.id, price: num(a.price), title: a.title || '', color: typeof a.color === 'string' ? a.color : '#64748b', style: a.linestyle || 'dashed' });
      return nd.id;
    });
    const ignored = (what) => (a, f, nd) => warn(`${what} is not drawn in the suite (ignored)`, nd.line);
    for (const nm of ['bgcolor', 'barcolor', 'fill', 'label.new', 'line.new', 'box.new', 'table.new', 'label.delete', 'line.delete', 'label.set_text', 'line.set_xy2', 'alert']) B[nm] = { params: [], fn: ignored(`${nm}()`) };
    B.alertcondition = { params: [], fn: () => {} };

    def('strategy.entry', ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment', 'alert_message', 'disable_alert', 'when'], (a, f, nd) => {
      if (!strat.on) throw new PineError('strategy.entry() needs strategy(...) at the top instead of indicator(...)', nd.line);
      if (a.when !== undefined && !truthy(a.when)) return;
      if (!isNa(a.limit) || !isNa(a.stop)) warn('limit and stop prices on strategy.entry are ignored: entries fill at the next open', nd.line);
      strat.pending.push({ kind: 'entry', id: String(a.id), dir: a.direction === 'short' ? -1 : 1, qty: isNa(a.qty) ? undefined : num(a.qty) });
    });
    def('strategy.order', ['id', 'direction', 'qty', 'limit', 'stop', 'when'], (a, f, nd) => {
      warn('strategy.order is treated like strategy.entry', nd.line);
      if (a.when !== undefined && !truthy(a.when)) return;
      strat.pending.push({ kind: 'entry', id: String(a.id), dir: a.direction === 'short' ? -1 : 1, qty: isNa(a.qty) ? undefined : num(a.qty) });
    });
    def('strategy.close', ['id', 'comment', 'qty', 'qty_percent', 'alert_message', 'immediately', 'disable_alert', 'when'], (a) => {
      if (a.when !== undefined && !truthy(a.when)) return;
      strat.pending.push({ kind: 'close', id: String(a.id) });
    });
    def('strategy.close_all', ['comment', 'alert_message', 'immediately', 'disable_alert', 'when'], (a) => {
      if (a.when !== undefined && !truthy(a.when)) return;
      strat.pending.push({ kind: 'close', id: null });
    });
    def('strategy.exit', ['id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop', 'trail_price', 'trail_points', 'trail_offset', 'oca_name', 'comment', 'comment_profit', 'comment_loss', 'comment_trailing', 'alert_message', 'when'], (a, f, nd) => {
      if (a.when !== undefined && !truthy(a.when)) return;
      if (!isNa(a.profit) || !isNa(a.loss) || !isNa(a.trail_points) || !isNa(a.trail_price)) warn('strategy.exit: profit / loss in ticks and trailing stops are not simulated; use stop= and limit= prices', nd.line);
      strat.exits.set(String(a.id), { from: isNa(a.from_entry) ? null : String(a.from_entry), stop: num(a.stop), limit: num(a.limit) });
    });
    def('strategy.cancel strategy.cancel_all', ['id'], () => {});

    // ---- evaluation
    const SOURCE_NAMES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'volume'];
    function sourceNameOf(nd) {
      return nd && nd.type === 'Ident' && SOURCE_NAMES.includes(nd.name) ? nd.name : 'close';
    }
    function tuple(items) {
      const t = items.slice();
      t.tuple = true;
      return t;
    }

    function evalExpr(nd, frame) {
      if (++steps > MAX_STEPS) throw new PineError('the script takes too long (endless loop?)', nd.line);
      switch (nd.type) {
        case 'Num': return nd.value;
        case 'Str': return nd.value;
        case 'Bool': return nd.value;
        case 'Color': return nd.value.length === 9 ? colorNew(nd.value.slice(0, 7), 100 - (parseInt(nd.value.slice(7), 16) / 255) * 100) : nd.value;
        case 'Na': return NaN;
        case 'Ident': {
          const s = frame.lookup(nd.name);
          if (s) return s.v[i];
          const b = builtinVar(nd.name, frame, nd);
          if (b !== undefined) return b;
          if (funcs.has(nd.name) || B[nd.name]) throw new PineError(`${nd.name} is a function; call it with (...)`, nd.line);
          throw new PineError(`unknown name "${nd.name}"`, nd.line);
        }
        case 'Index': {
          const k = Math.floor(num(evalExpr(nd.offset, frame)));
          if (!(k >= 0)) throw new PineError('the history offset must be 0 or more', nd.line);
          const t = nd.target;
          if (t.type === 'Ident') {
            const s = frame.lookup(t.name);
            if (s) return i - k >= 0 ? s.v[i - k] : NaN;
            const direct = { open: O, high: H, low: L, close: C, volume: V }[t.name];
            if (direct) return i - k >= 0 ? direct[i - k] : NaN;
            if (t.name === 'time') return i - k >= 0 ? T[i - k] * 1000 : NaN;
          }
          // Any other expression: keep its values at this call site.
          const st = site(frame, nd);
          const h = st.h || (st.h = new Array(n).fill(NaN));
          h[i] = evalExpr(t, frame);
          return i - k >= 0 ? h[i - k] : NaN;
        }
        case 'Unary': {
          const v = evalExpr(nd.arg, frame);
          if (nd.op === 'not') return !truthy(v);
          return nd.op === '-' ? -num(v) : num(v);
        }
        case 'Binary': {
          if (nd.op === 'and') return truthy(evalExpr(nd.left, frame)) && truthy(evalExpr(nd.right, frame));
          if (nd.op === 'or') return truthy(evalExpr(nd.left, frame)) || truthy(evalExpr(nd.right, frame));
          const l = evalExpr(nd.left, frame);
          const r = evalExpr(nd.right, frame);
          if (nd.op === '+' && (typeof l === 'string' || typeof r === 'string')) return `${l}${r}`;
          if (nd.op === '==') return typeof l === 'string' || typeof r === 'string' ? l === r : num(l) === num(r);
          if (nd.op === '!=') return typeof l === 'string' || typeof r === 'string' ? l !== r : !(num(l) === num(r)) && !(isNa(l) && isNa(r));
          const x = num(l);
          const y = num(r);
          switch (nd.op) {
            case '+': return x + y;
            case '-': return x - y;
            case '*': return x * y;
            case '/': return y === 0 ? NaN : x / y;
            case '%': return x % y;
            case '<': return x < y;
            case '>': return x > y;
            case '<=': return x <= y;
            case '>=': return x >= y;
          }
          throw new PineError(`unknown operator ${nd.op}`, nd.line);
        }
        case 'Ternary': return truthy(evalExpr(nd.cond, frame)) ? evalExpr(nd.a, frame) : evalExpr(nd.b, frame);
        case 'Tuple': return tuple(nd.items.map((x) => evalExpr(x, frame)));
        case 'Call': return call(nd, frame);
      }
      throw new PineError(`cannot evaluate ${nd.type}`, nd.line);
    }

    function call(nd, frame) {
      const user = funcs.get(nd.callee);
      if (user) {
        if (nd.args.length > user.params.length) throw new PineError(`${nd.callee}() takes ${user.params.length} arguments`, nd.line);
        const f = child(frame, `f${nd.id}`);
        user.params.forEach((pm, k) => {
          const argNode = k < nd.args.length ? nd.args[k] : nd.named[pm.name] || pm.def;
          if (!argNode) throw new PineError(`${nd.callee}(): missing argument ${pm.name}`, nd.line);
          let s = f.vars.get(pm.name);
          if (!s) f.vars.set(pm.name, (s = newSeries(false)));
          s.v[i] = evalExpr(argNode, frame);
        });
        let result = NaN;
        for (const st of user.body) result = exec(st, f);
        return result;
      }
      const b = B[nd.callee];
      if (!b) throw new PineError(`unknown function ${nd.callee}()`, nd.line);
      if (b.variadic) return b.fn(nd.args.map((x) => evalExpr(x, frame)));
      const a = {};
      nd.args.forEach((x, k) => {
        if (k >= b.params.length) throw new PineError(`${nd.callee}() takes at most ${b.params.length} arguments`, nd.line);
        a[b.params[k]] = evalExpr(x, frame);
      });
      for (const [k, x] of Object.entries(nd.named)) {
        if (!b.params.includes(k)) throw new PineError(`${nd.callee}() has no argument "${k}"`, nd.line);
        a[k] = evalExpr(x, frame);
      }
      return b.fn(a, frame, nd);
    }

    // Returns the value of the statement (a function's last statement is its result).
    function exec(st, frame) {
      switch (st.type) {
        case 'Decl': {
          let s = frame.vars.get(st.name);
          if (!s) {
            s = newSeries(st.isVar);
            frame.vars.set(st.name, s);
            if (st.isVar) varSeries.push(s);
          }
          if (st.isVar) {
            if (!s.init) {
              s.v[i] = evalExpr(st.init, frame);
              s.init = true;
            }
          } else s.v[i] = evalExpr(st.init, frame);
          return s.v[i];
        }
        case 'TupleDecl': {
          const v = evalExpr(st.init, frame);
          if (!Array.isArray(v)) throw new PineError('the right side does not return a tuple', st.line);
          st.names.forEach((nm, k) => {
            let s = frame.vars.get(nm);
            if (!s) frame.vars.set(nm, (s = newSeries(false)));
            s.v[i] = v[k];
          });
          return v;
        }
        case 'Assign': {
          const s = frame.lookup(st.name);
          if (!s) throw new PineError(`"${st.name}" is not declared; declare it with = first`, st.line);
          const v = evalExpr(st.value, frame);
          const cur = s.v[i];
          s.v[i] = st.op === ':=' ? v : st.op === '+=' ? num(cur) + num(v) : st.op === '-=' ? num(cur) - num(v) : st.op === '*=' ? num(cur) * num(v) : st.op === '/=' ? num(cur) / num(v) : num(cur) % num(v);
          return s.v[i];
        }
        case 'If': {
          if (truthy(evalExpr(st.cond, frame))) return execBlock(st.then, child(frame, `i${st.id}`));
          if (st.otherwise) return execBlock(st.otherwise, child(frame, `e${st.id}`));
          return NaN;
        }
        case 'For': {
          const f = child(frame, `l${st.id}`);
          let s = f.vars.get(st.name);
          if (!s) f.vars.set(st.name, (s = newSeries(false)));
          const from = num(evalExpr(st.from, frame));
          const to = num(evalExpr(st.to, frame));
          const step = st.step ? Math.abs(num(evalExpr(st.step, frame))) : 1;
          if (!(step > 0)) throw new PineError('the loop step must be positive', st.line);
          let result = NaN;
          for (let k = from; from <= to ? k <= to : k >= to; k += from <= to ? step : -step) {
            s.v[i] = k;
            result = execBlock(st.body, f);
            if (++steps > MAX_STEPS) throw new PineError('the loop takes too long', st.line);
          }
          return result;
        }
        case 'FuncDef':
          if (i === 0) funcs.set(st.name, st);
          return NaN;
        case 'ExprStmt':
          return evalExpr(st.expr, frame);
      }
      throw new PineError(`cannot run ${st.type}`, st.line);
    }
    function execBlock(stmts, frame) {
      let r = NaN;
      for (const st of stmts) r = exec(st, frame);
      return r;
    }

    // Functions are known before the first bar runs.
    for (const st of ast.body) if (st.type === 'FuncDef') funcs.set(st.name, st);
    const first = ast.body.find((st) => st.type === 'ExprStmt' && st.expr.type === 'Call' && ['indicator', 'strategy', 'study'].includes(st.expr.callee));
    if (!first) throw new PineError('the script must call indicator(...) or strategy(...)', 1);

    for (i = 0; i < n; i++) {
      for (const s of varSeries) if (i > 0) s.v[i] = s.v[i - 1];
      if (strat.on) fillOrders(i);
      for (const st of ast.body) exec(st, global);
      if (strat.on) strat.equity[i] = strat.capital + strat.realized + (strat.pos ? (C[i] - strat.pos.price) * strat.pos.qty * strat.pos.dir - strat.pos.fee : 0);
    }

    if (strat.on) out.strategy = summarize(strat, C, T, n);
    return out;
  }

  function summarize(strat, C, T, n) {
    const trades = strat.trades;
    const wins = trades.filter((t) => t.profit > 0);
    const losses = trades.filter((t) => t.profit <= 0);
    const grossWin = wins.reduce((s, t) => s + t.profit, 0);
    const grossLoss = -losses.reduce((s, t) => s + t.profit, 0);
    let peak = -Infinity;
    let maxDd = 0;
    let maxDdPct = 0;
    const equity = [];
    for (let i = 0; i < n; i++) {
      const e = strat.equity[i];
      if (Number.isNaN(e)) continue;
      equity.push({ time: T[i], value: e });
      if (e > peak) peak = e;
      if (peak - e > maxDd) maxDd = peak - e;
      if (peak > 0 && (peak - e) / peak > maxDdPct) maxDdPct = (peak - e) / peak;
    }
    const last = strat.equity[n - 1];
    const firstClose = C.find((c) => !Number.isNaN(c));
    const open = strat.pos ? { id: strat.pos.id, dir: strat.pos.dir > 0 ? 'long' : 'short', entryTime: T[strat.pos.bar], entryPrice: strat.pos.price, profitPct: ((C[n - 1] / strat.pos.price - 1) * 100 * strat.pos.dir) } : null;
    return {
      initialCapital: strat.capital,
      netProfit: strat.realized,
      netProfitPct: (strat.realized / strat.capital) * 100,
      equityEnd: last,
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      avgTradePct: trades.length ? trades.reduce((s, t) => s + t.profitPct, 0) / trades.length : null,
      maxDrawdown: maxDd,
      maxDrawdownPct: maxDdPct * 100,
      buyHoldPct: firstClose ? (C[n - 1] / firstClose - 1) * 100 : null,
      openTrade: open,
      trades,
      equity,
      markers: strat.markers,
    };
  }

  // ---- converter to a Freqtrade strategy --------------------------------------------------------
  // Pine runs bar by bar; a Freqtrade strategy computes whole columns at once. The converter
  // takes the part of Pine that maps onto columns: variables computed from built-ins and
  // other variables, inputs (as hyperopt parameters), tuples from ta.*, single- and
  // multi-line functions without state, and strategy.entry / close / close_all under if
  // blocks. var, :=, for loops and stop / limit exits need bar-by-bar state and are
  // refused (with the line) or reported.
  const PY_HELPERS = {
    _ser: { deps: [], code: `def _ser(x, like):
    """A scalar as a column with the dataframe's index."""
    if isinstance(x, pd.Series):
        return x
    return pd.Series(x, index=like.index, dtype="float64" if not isinstance(x, (bool, np.bool_)) else "bool")` },
    _nz: { deps: [], code: `def _nz(x, y=0.0):
    return x.fillna(y) if isinstance(x, pd.Series) else (y if x is None or (isinstance(x, float) and np.isnan(x)) else x)` },
    _na: { deps: [], code: `def _na(x):
    return x.isna() if isinstance(x, pd.Series) else (x is None or (isinstance(x, float) and np.isnan(x)))` },
    _bool: { deps: [], code: `def _bool(x, like):
    if isinstance(x, pd.Series):
        return x.fillna(False).astype(bool)
    return pd.Series(bool(x), index=like.index)` },
    _sma: { deps: [], code: `def _sma(s, n):
    n = int(n)
    return s.rolling(n, min_periods=n).mean()` },
    _ema_core: { deps: ['_sma'], code: `def _ema_core(s, n, alpha):
    """Pine's ta.ema / ta.rma: the first value is the SMA of the first n values."""
    x = s.to_numpy(dtype="float64")
    seed = _sma(s, n).to_numpy(dtype="float64")
    out = np.full(len(x), np.nan)
    prev = np.nan
    for i in range(len(x)):
        prev = seed[i] if np.isnan(prev) else alpha * x[i] + (1 - alpha) * prev
        out[i] = prev
    return pd.Series(out, index=s.index)` },
    _ema: { deps: ['_ema_core'], code: `def _ema(s, n):
    return _ema_core(s, int(n), 2.0 / (int(n) + 1))` },
    _rma: { deps: ['_ema_core'], code: `def _rma(s, n):
    return _ema_core(s, int(n), 1.0 / int(n))` },
    _wma: { deps: [], code: `def _wma(s, n):
    n = int(n)
    w = np.arange(1, n + 1, dtype="float64")
    return s.rolling(n, min_periods=n).apply(lambda v: float(np.dot(v, w) / w.sum()), raw=True)` },
    _hma: { deps: ['_wma'], code: `def _hma(s, n):
    n = int(n)
    half = max(1, int(np.floor(n / 2 + 0.5)))
    root = max(1, int(np.floor(np.sqrt(n) + 0.5)))
    return _wma(2 * _wma(s, half) - _wma(s, n), root)` },
    _stdev: { deps: [], code: `def _stdev(s, n):
    n = int(n)
    return s.rolling(n, min_periods=n).std(ddof=0)` },
    _sum: { deps: [], code: `def _sum(s, n):
    n = int(n)
    return s.rolling(n, min_periods=n).sum()` },
    _rsi: { deps: ['_rma'], code: `def _rsi(s, n):
    ch = s.diff()
    up = _rma(ch.clip(lower=0), n)
    down = _rma((-ch).clip(lower=0), n)
    with np.errstate(divide="ignore", invalid="ignore"):
        r = 100 - 100 / (1 + up / down)
    r = r.where(up != 0, 0.0)
    r = r.where(down != 0, 100.0)
    return r.where(up.notna() & down.notna())` },
    _macd: { deps: ['_ema'], code: `def _macd(s, fast, slow, signal):
    m = _ema(s, fast) - _ema(s, slow)
    sig = _ema(m, signal)
    return m, sig, m - sig` },
    _bb: { deps: ['_sma', '_stdev'], code: `def _bb(s, n, mult):
    mid = _sma(s, n)
    dev = mult * _stdev(s, n)
    return mid, mid + dev, mid - dev` },
    _tr: { deps: [], code: `def _tr(df, handle_na):
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)
    if not handle_na:
        tr[pc.isna()] = np.nan
    return tr` },
    _atr: { deps: ['_tr', '_rma'], code: `def _atr(df, n):
    return _rma(_tr(df, True), n)` },
    _highest: { deps: [], code: `def _highest(s, n):
    n = int(n)
    return s.rolling(n, min_periods=n).max()` },
    _lowest: { deps: [], code: `def _lowest(s, n):
    n = int(n)
    return s.rolling(n, min_periods=n).min()` },
    _cross: { deps: [], code: `def _crossover(a, b):
    return (a > b) & (a.shift(1) <= b.shift(1))


def _crossunder(a, b):
    return (a < b) & (a.shift(1) >= b.shift(1))` },
    _stoch: { deps: ['_highest', '_lowest'], code: `def _stoch(s, high, low, n):
    hh = _highest(high, n)
    ll = _lowest(low, n)
    return 100 * (s - ll) / (hh - ll)` },
    _cci: { deps: ['_sma'], code: `def _cci(s, n):
    n = int(n)
    ma = _sma(s, n)
    md = s.rolling(n, min_periods=n).apply(lambda v: float(np.mean(np.abs(v - v.mean()))), raw=True)
    return ((s - ma) / (0.015 * md)).where(md != 0, 0.0)` },
    _mfi: { deps: [], code: `def _mfi(s, n, volume):
    n = int(n)
    ch = s.diff()
    up = pd.Series(volume.to_numpy() * np.where(ch <= 0, 0.0, s), index=s.index).rolling(n, min_periods=n).sum()
    down = pd.Series(volume.to_numpy() * np.where(ch >= 0, 0.0, s), index=s.index).rolling(n, min_periods=n).sum()
    return 100.0 - 100.0 / (1.0 + up / down)` },
    _vwap: { deps: [], code: `def _vwap(df, s):
    day = df["date"].dt.floor("D")
    pv = (s * df["volume"]).groupby(day).cumsum()
    v = df["volume"].groupby(day).cumsum()
    return (pv / v).where(v > 0, s)` },
    _change: { deps: [], code: `def _change(s, n=1):
    return s - s.shift(int(n))` },
    _roc: { deps: [], code: `def _roc(s, n):
    prev = s.shift(int(n))
    return 100 * (s - prev) / prev` },
    _obv: { deps: [], code: `def _obv(df):
    return (np.sign(df["close"].diff()).fillna(0) * df["volume"]).cumsum()` },
    _cum: { deps: [], code: `def _cum(s):
    return s.fillna(0).cumsum()` },
    _supertrend: { deps: ['_atr'], code: `def _supertrend(df, factor, period):
    atr = _atr(df, period).to_numpy(dtype="float64")
    hl2 = ((df["high"] + df["low"]) / 2).to_numpy(dtype="float64")
    close = df["close"].to_numpy(dtype="float64")
    n = len(close)
    up = np.full(n, np.nan)
    lo = np.full(n, np.nan)
    st = np.full(n, np.nan)
    direction = np.full(n, np.nan)
    for i in range(n):
        upper = hl2[i] + factor * atr[i]
        lower = hl2[i] - factor * atr[i]
        prev_lower = lo[i - 1] if i > 0 and not np.isnan(lo[i - 1]) else 0.0
        prev_upper = up[i - 1] if i > 0 and not np.isnan(up[i - 1]) else 0.0
        prev_close = close[i - 1] if i > 0 else np.nan
        lower = lower if (lower > prev_lower or prev_close < prev_lower) else prev_lower
        upper = upper if (upper < prev_upper or prev_close > prev_upper) else prev_upper
        if i == 0 or np.isnan(atr[i - 1]):
            d = 1
        elif st[i - 1] == prev_upper:
            d = -1 if close[i] > upper else 1
        else:
            d = 1 if close[i] < lower else -1
        up[i], lo[i], direction[i] = upper, lower, d
        st[i] = lower if d == -1 else upper
    st[np.isnan(atr)] = np.nan
    return pd.Series(st, index=df.index), pd.Series(direction, index=df.index)` },
    _dmi: { deps: ['_tr', '_rma'], code: `def _dmi(df, n, smoothing):
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index).where(up.notna())
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index).where(down.notna())
    trur = _rma(_tr(df, False), n)
    plus = (100 * _rma(plus_dm, n) / trur).ffill()
    minus = (100 * _rma(minus_dm, n) / trur).ffill()
    total = plus + minus
    adx = 100 * _rma((plus - minus).abs() / total.where(total != 0, 1), smoothing)
    return plus, minus, adx` },
  };
  const PY_TA = {
    'ta.sma': { helper: '_sma', args: ['source', 'length'], py: (a) => `_sma(${a.source}, ${a.length})` },
    'ta.ema': { helper: '_ema', args: ['source', 'length'], py: (a) => `_ema(${a.source}, ${a.length})` },
    'ta.rma': { helper: '_rma', args: ['source', 'length'], py: (a) => `_rma(${a.source}, ${a.length})` },
    'ta.wma': { helper: '_wma', args: ['source', 'length'], py: (a) => `_wma(${a.source}, ${a.length})` },
    'ta.hma': { helper: '_hma', args: ['source', 'length'], py: (a) => `_hma(${a.source}, ${a.length})` },
    'ta.stdev': { helper: '_stdev', args: ['source', 'length'], py: (a) => `_stdev(${a.source}, ${a.length})` },
    'math.sum': { helper: '_sum', args: ['source', 'length'], py: (a) => `_sum(${a.source}, ${a.length})` },
    'ta.rsi': { helper: '_rsi', args: ['source', 'length'], py: (a) => `_rsi(${a.source}, ${a.length})` },
    'ta.macd': { helper: '_macd', args: ['source', 'fastlen', 'slowlen', 'siglen'], tuple: 3, py: (a) => `_macd(${a.source}, ${a.fastlen}, ${a.slowlen}, ${a.siglen})` },
    'ta.bb': { helper: '_bb', args: ['series', 'length', 'mult'], tuple: 3, py: (a) => `_bb(${a.series}, ${a.length}, ${a.mult})` },
    'ta.atr': { helper: '_atr', args: ['length'], py: (a) => `_atr(dataframe, ${a.length})` },
    'ta.tr': { helper: '_tr', args: ['handle_na'], py: (a) => `_tr(dataframe, ${a.handle_na || 'False'})` },
    'ta.highest': { helper: '_highest', args: ['source', 'length'], py: (a) => (a.length ? `_highest(${a.source}, ${a.length})` : `_highest(dataframe["high"], ${a.source})`) },
    'ta.lowest': { helper: '_lowest', args: ['source', 'length'], py: (a) => (a.length ? `_lowest(${a.source}, ${a.length})` : `_lowest(dataframe["low"], ${a.source})`) },
    'ta.change': { helper: '_change', args: ['source', 'length'], py: (a) => `_change(${a.source}, ${a.length || 1})` },
    'ta.mom': { helper: '_change', args: ['source', 'length'], py: (a) => `_change(${a.source}, ${a.length})` },
    'ta.roc': { helper: '_roc', args: ['source', 'length'], py: (a) => `_roc(${a.source}, ${a.length})` },
    'ta.crossover': { helper: '_cross', args: ['source1', 'source2'], bool: true, py: (a) => `_crossover(${a.source1}, ${a.source2})` },
    'ta.crossunder': { helper: '_cross', args: ['source1', 'source2'], bool: true, py: (a) => `_crossunder(${a.source1}, ${a.source2})` },
    'ta.cross': { helper: '_cross', args: ['source1', 'source2'], bool: true, py: (a) => `(_crossover(${a.source1}, ${a.source2}) | _crossunder(${a.source1}, ${a.source2}))` },
    'ta.stoch': { helper: '_stoch', args: ['source', 'high', 'low', 'length'], py: (a) => `_stoch(${a.source}, ${a.high}, ${a.low}, ${a.length})` },
    'ta.cci': { helper: '_cci', args: ['source', 'length'], py: (a) => `_cci(${a.source}, ${a.length})` },
    'ta.mfi': { helper: '_mfi', args: ['series', 'length'], py: (a) => `_mfi(${a.series}, ${a.length}, dataframe["volume"])` },
    'ta.vwap': { helper: '_vwap', args: ['source'], py: (a) => `_vwap(dataframe, ${a.source})` },
    'ta.supertrend': { helper: '_supertrend', args: ['factor', 'atrPeriod'], tuple: 2, py: (a) => `_supertrend(dataframe, ${a.factor}, ${a.atrPeriod})` },
    'ta.dmi': { helper: '_dmi', args: ['diLength', 'adxSmoothing'], tuple: 3, py: (a) => `_dmi(dataframe, ${a.diLength}, ${a.adxSmoothing})` },
    'ta.cum': { helper: '_cum', args: ['source'], py: (a) => `_cum(${a.source})` },
  };
  const PY_SOURCES = {
    open: 'dataframe["open"]', high: 'dataframe["high"]', low: 'dataframe["low"]', close: 'dataframe["close"]', volume: 'dataframe["volume"]',
    hl2: '((dataframe["high"] + dataframe["low"]) / 2)', hlc3: '((dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3)',
    ohlc4: '((dataframe["open"] + dataframe["high"] + dataframe["low"] + dataframe["close"]) / 4)',
    bar_index: 'pd.Series(np.arange(len(dataframe)), index=dataframe.index)',
    'ta.tr': '_tr(dataframe, False)', 'ta.obv': '_obv(dataframe)', 'ta.vwap': '_vwap(dataframe, ((dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3))',
  };
  const PY_MATH = { 'math.abs': 'np.abs', 'math.sqrt': 'np.sqrt', 'math.log': 'np.log', 'math.log10': 'np.log10', 'math.exp': 'np.exp', 'math.sign': 'np.sign', 'math.floor': 'np.floor', 'math.ceil': 'np.ceil' };
  const pyStr = (s) => JSON.stringify(String(s));
  const pyIdent = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');

  function toFreqtrade(source, { className = 'PineStrategy', timeframe = '15m' } = {}) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{2,60}$/.test(className)) throw new PineError('the class name must be a Python identifier of 3 to 61 characters');
    const ast = parse(source);
    const warnings = [];
    const used = new Set(['_bool']);
    const params = []; // [{ attr, line }]
    const lines = []; // body of populate_indicators
    const vars = new Map(); // pine name -> { py, series }
    const funcs = new Map();
    const entries = { long: [], short: [] };
    const exits = { long: [], short: [] };
    const entryDir = new Map();
    const closes = [];
    const plots = { main: {}, sub: {} };
    const settings = { title: 'Pine strategy', overlay: true, args: {} };
    let hasStrategy = false;
    let tmp = 0;
    let maxLen = 20;
    const fail = (msg, line) => {
      throw new PineError(msg, line);
    };
    const need = (h) => {
      used.add(h);
      for (const d of PY_HELPERS[h].deps) need(d);
    };
    const noteLength = (nd) => {
      if (nd && nd.type === 'Num') maxLen = Math.max(maxLen, nd.value);
    };

    // An expression as Python: { py, series, bool }.
    function tx(nd, scope = null) {
      switch (nd.type) {
        case 'Num': return { py: String(nd.value), series: false };
        case 'Str': return { py: pyStr(nd.value), series: false, str: true };
        case 'Bool': return { py: nd.value ? 'True' : 'False', series: false, bool: true };
        case 'Na': return { py: 'np.nan', series: false };
        case 'Color': return { py: pyStr(nd.value), series: false, str: true };
        case 'Ident': {
          if (scope && scope.has(nd.name)) return scope.get(nd.name);
          if (vars.has(nd.name)) return vars.get(nd.name);
          if (PY_SOURCES[nd.name]) {
            if (nd.name === 'ta.tr') need('_tr');
            if (nd.name === 'ta.obv') need('_obv');
            if (nd.name === 'ta.vwap') need('_vwap');
            return { py: PY_SOURCES[nd.name], series: true };
          }
          if (nd.name === 'strategy.long' || nd.name === 'strategy.short') return { py: pyStr(nd.name.split('.')[1]), series: false, dir: nd.name.split('.')[1] };
          if (nd.name in CONSTANTS) return { py: typeof CONSTANTS[nd.name] === 'number' ? String(CONSTANTS[nd.name]) : pyStr(CONSTANTS[nd.name]), series: false };
          if (nd.name.startsWith('strategy.')) fail(`${nd.name} depends on the simulated position and cannot be converted`, nd.line);
          return fail(`unknown name "${nd.name}"`, nd.line);
        }
        case 'Index': {
          const t = tx(nd.target, scope);
          const k = tx(nd.offset, scope);
          if (k.series) fail('a history offset that changes from bar to bar cannot be converted', nd.line);
          if (!t.series) return t;
          return { py: `${wrap(t.py)}.shift(int(${k.py}))`, series: true, bool: t.bool };
        }
        case 'Unary': {
          const v = tx(nd.arg, scope);
          if (nd.op === 'not') return v.series ? { py: `~${wrap(boolOf(v).py)}`, series: true, bool: true } : { py: `(not ${v.py})`, series: false, bool: true };
          return { py: `(${nd.op}${v.py})`, series: v.series };
        }
        case 'Binary': {
          const l = tx(nd.left, scope);
          const r = tx(nd.right, scope);
          const series = l.series || r.series;
          if (nd.op === 'and' || nd.op === 'or') {
            if (!series) return { py: `(${l.py} ${nd.op} ${r.py})`, series: false, bool: true };
            return { py: `(${asBoolSeries(l)} ${nd.op === 'and' ? '&' : '|'} ${asBoolSeries(r)})`, series: true, bool: true };
          }
          const bool = ['<', '>', '<=', '>=', '==', '!='].includes(nd.op);
          return { py: `(${l.py} ${nd.op} ${r.py})`, series, bool };
        }
        case 'Ternary': {
          const c = tx(nd.cond, scope);
          const a = tx(nd.a, scope);
          const b = tx(nd.b, scope);
          if (!c.series) return { py: `(${a.py} if ${c.py} else ${b.py})`, series: a.series || b.series, bool: a.bool && b.bool };
          if (a.str || b.str) return { py: pyStr(''), series: false, str: true };
          return { py: `pd.Series(np.where(${boolOf(c).py}, ${a.py}, ${b.py}), index=dataframe.index)`, series: true, bool: a.bool && b.bool };
        }
        case 'Call': return txCall(nd, scope);
        case 'Tuple': return { py: `(${nd.items.map((x) => tx(x, scope).py).join(', ')})`, series: true, tuple: nd.items.length };
      }
      return fail(`${nd.type} cannot be converted`, nd.line);
    }
    const wrap = (py) => (/^[A-Za-z_][A-Za-z0-9_.]*(\[[^\]]+\])?$/.test(py) || /^\(.*\)$/.test(py) ? py : `(${py})`);
    const boolOf = (v) => (v.series ? (v.bool ? v : { py: `_bool(${v.py}, dataframe)`, series: true, bool: true }) : v);
    // A scalar next to a column in and / or becomes a column too.
    const asBoolSeries = (v) => {
      if (v.series) return boolOf(v).py;
      need('_ser');
      return `_ser(bool(${v.py}), dataframe)`;
    };

    function bindArgs(nd, names, scope) {
      const a = {};
      nd.args.forEach((x, k) => {
        if (k >= names.length) fail(`${nd.callee}() takes at most ${names.length} arguments`, nd.line);
        a[names[k]] = x;
      });
      for (const [k, x] of Object.entries(nd.named)) a[k] = x;
      const py = {};
      for (const [k, x] of Object.entries(a)) {
        const v = tx(x, scope);
        py[k] = v.series && !v.param && !['source', 'source1', 'source2', 'series', 'high', 'low'].includes(k) ? fail(`${nd.callee}(): ${k} must not change from bar to bar here`, nd.line) : v.py;
        if (['source1', 'source2'].includes(k) && !v.series) py[k] = `_ser(${v.py}, dataframe)`;
      }
      return { nodes: a, py };
    }

    function txCall(nd, scope) {
      const name = nd.callee;
      if (funcs.has(name)) {
        const f = funcs.get(name);
        const args = f.params.map((pm, k) => {
          const x = k < nd.args.length ? nd.args[k] : nd.named[pm.name] || pm.def;
          if (!x) fail(`${name}(): missing argument ${pm.name}`, nd.line);
          return tx(x, scope).py;
        });
        return { py: `${f.py}(${args.join(', ')})`, series: true, tuple: f.tuple };
      }
      if (PY_TA[name]) {
        const spec = PY_TA[name];
        need(spec.helper === '_cross' ? '_cross' : spec.helper);
        if (spec.helper === '_cross') need('_ser');
        const { nodes, py } = bindArgs(nd, spec.args, scope);
        for (const k of ['length', 'fastlen', 'slowlen', 'siglen', 'diLength', 'atrPeriod']) noteLength(nodes[k]);
        return { py: spec.py(py), series: true, bool: !!spec.bool, tuple: spec.tuple };
      }
      if (PY_MATH[name]) {
        const v = tx(nd.args[0], scope);
        return { py: `${PY_MATH[name]}(${v.py})`, series: v.series };
      }
      if (name === 'math.max' || name === 'math.min') {
        const vs = nd.args.map((x) => tx(x, scope));
        const fn = name === 'math.max' ? 'np.maximum' : 'np.minimum';
        const py = vs.map((v) => v.py).reduce((acc, x) => `${fn}(${acc}, ${x})`);
        return { py: vs.some((v) => v.series) ? `pd.Series(${py}, index=dataframe.index)` : py, series: vs.some((v) => v.series) };
      }
      if (name === 'math.pow') {
        const [b, e] = nd.args.map((x) => tx(x, scope));
        return { py: `(${b.py} ** ${e.py})`, series: b.series || e.series };
      }
      if (name === 'math.round') {
        const v = tx(nd.args[0], scope);
        return { py: v.series ? `${wrap(v.py)}.round(${nd.args[1] ? tx(nd.args[1], scope).py : 0})` : `round(${v.py}${nd.args[1] ? `, ${tx(nd.args[1], scope).py}` : ''})`, series: v.series };
      }
      if (name === 'math.avg') {
        const vs = nd.args.map((x) => tx(x, scope));
        return { py: `((${vs.map((v) => v.py).join(' + ')}) / ${vs.length})`, series: vs.some((v) => v.series) };
      }
      if (name === 'nz') {
        need('_nz');
        const v = tx(nd.args[0], scope);
        return { py: `_nz(${v.py}${nd.args[1] ? `, ${tx(nd.args[1], scope).py}` : ''})`, series: v.series };
      }
      if (name === 'na') {
        need('_na');
        const v = tx(nd.args[0], scope);
        return { py: `_na(${v.py})`, series: v.series, bool: true };
      }
      if (name === 'fixnan') {
        const v = tx(nd.args[0], scope);
        return { py: v.series ? `${wrap(v.py)}.ffill()` : v.py, series: v.series };
      }
      if (name === 'int' || name === 'float') {
        const v = tx(nd.args[0], scope);
        return v.series ? v : { py: `${name}(${v.py})`, series: false };
      }
      if (name === 'color.new' || name === 'color.rgb') return { py: pyStr(''), series: false, str: true };
      if (name.startsWith('input')) fail('inputs can only be used as "name = input...(...)" at the top of the script', nd.line);
      if (['ta.barssince', 'ta.valuewhen', 'ta.rising', 'ta.falling'].includes(name)) fail(`${name}() is not supported by the converter`, nd.line);
      return fail(`${name}() cannot be converted`, nd.line);
    }

    function inputParam(name, nd) {
      const kind = nd.callee === 'input' ? 'auto' : nd.callee.split('.')[1];
      const argNames = ['defval', 'title', 'minval', 'maxval', 'step'];
      const a = {};
      nd.args.forEach((x, k) => (a[argNames[k]] = x));
      Object.assign(a, nd.named);
      const lit = (x) => (x && x.type === 'Num' ? x.value : x && x.type === 'Unary' && x.op === '-' && x.arg.type === 'Num' ? -x.arg.value : x && x.type === 'Bool' ? x.value : x && x.type === 'Str' ? x.value : undefined);
      const defval = lit(a.defval);
      if (kind === 'source') {
        const src = a.defval && a.defval.type === 'Ident' && PY_SOURCES[a.defval.name] ? a.defval.name : 'close';
        vars.set(name, { py: PY_SOURCES[src], series: true });
        return;
      }
      const attr = `p_${pyIdent(name)}`;
      const type = kind === 'auto' ? (typeof defval === 'boolean' ? 'bool' : typeof defval === 'string' ? 'string' : Number.isInteger(defval) ? 'int' : 'float') : kind;
      if (type === 'string' || type === 'timeframe' || type === 'color') {
        vars.set(name, { py: pyStr(defval === undefined ? '' : defval), series: false, str: true });
        return;
      }
      if (defval === undefined) fail('the default of an input must be a literal', nd.line);
      if (type === 'bool') {
        params.push(`    ${attr} = BooleanParameter(default=${defval ? 'True' : 'False'}, space="buy")`);
      } else if (type === 'int') {
        const lo = lit(a.minval) !== undefined ? lit(a.minval) : Math.max(1, Math.floor(defval / 2));
        const hi = lit(a.maxval) !== undefined ? lit(a.maxval) : Math.max(defval * 3, lo + 1);
        params.push(`    ${attr} = IntParameter(${Math.min(lo, defval)}, ${Math.max(hi, defval)}, default=${defval}, space="buy")`);
        maxLen = Math.max(maxLen, defval);
      } else {
        const lo = lit(a.minval) !== undefined ? lit(a.minval) : Math.min(defval / 2, defval * 2);
        const hi = lit(a.maxval) !== undefined ? lit(a.maxval) : Math.max(defval * 2, defval / 2, lo + 0.1);
        params.push(`    ${attr} = DecimalParameter(${Math.min(lo, defval)}, ${Math.max(hi, defval)}, default=${defval}, decimals=3, space="buy")`);
      }
      vars.set(name, { py: type === 'int' ? `int(self.${attr}.value)` : type === 'float' ? `float(self.${attr}.value)` : `self.${attr}.value`, series: false, bool: type === 'bool' });
    }

    // Pine variables become columns of the same name, except names Freqtrade uses itself.
    const RESERVED = new Set(['date', 'open', 'high', 'low', 'close', 'volume', 'enter_long', 'enter_short', 'exit_long', 'exit_short', 'enter_tag', 'exit_tag']);
    const col = (name) => `dataframe[${pyStr(RESERVED.has(name) || name.startsWith('pine_') ? `pine_${name}` : name)}]`;
    function assign(name, v, line) {
      if (v.tuple) fail('a tuple needs [a, b, ...] = on the left', line);
      if (v.series) {
        lines.push(`        ${col(name)} = ${v.py}`);
        vars.set(name, { py: col(name), series: true, bool: v.bool });
      } else {
        const local = `v_${pyIdent(name)}`;
        lines.push(`        ${local} = ${v.py}`);
        vars.set(name, { py: local, series: false, bool: v.bool, str: v.str });
      }
    }

    function condOf(conds) {
      if (!conds.length) return 'True';
      return conds.map((c) => c.py).join(' & ');
    }
    function strategyCall(nd, conds) {
      const name = nd.callee;
      const argNames = {
        'strategy.entry': ['id', 'direction', 'qty', 'limit', 'stop'],
        'strategy.close': ['id', 'comment', 'qty', 'qty_percent'],
        'strategy.close_all': ['comment'],
        'strategy.exit': ['id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop'],
      }[name];
      const a = {};
      nd.args.forEach((x, k) => (a[argNames[k]] = x));
      Object.assign(a, nd.named);
      const all = conds.slice();
      if (a.when) all.push(boolOf(tx(a.when)));
      const cond = all.length ? all.map((c) => (c.series ? c.py : `_ser(${c.py}, dataframe).astype(bool)`)).join(' & ') : null;
      if (cond && all.some((c) => !c.series)) need('_ser');
      if (name === 'strategy.entry') {
        const dir = a.direction && a.direction.type === 'Ident' && a.direction.name === 'strategy.short' ? 'short' : 'long';
        const id = a.id && a.id.type === 'Str' ? a.id.value : dir;
        entryDir.set(id, dir);
        entries[dir].push({ cond: cond || 'True', id, line: nd.line });
        if (a.limit || a.stop) warnings.push(`line ${nd.line}: limit / stop prices on strategy.entry are ignored (Freqtrade enters at the next open)`);
      } else if (name === 'strategy.close') {
        const id = a.id && a.id.type === 'Str' ? a.id.value : null;
        closes.push({ id, cond: cond || 'True', line: nd.line });
      } else if (name === 'strategy.close_all') {
        exits.long.push({ cond: cond || 'True' });
        exits.short.push({ cond: cond || 'True' });
      } else if (name === 'strategy.exit') {
        warnings.push(`line ${nd.line}: strategy.exit (stop / limit / profit / loss) is not converted; set stoploss, minimal_roi or custom_stoploss in the generated class`);
      }
    }

    function statement(st, conds) {
      switch (st.type) {
        case 'Decl':
          if (conds.length) fail('a variable declared inside an if block cannot be converted; use the ternary operator (cond ? a : b)', st.line);
          if (st.isVar) fail('var keeps state from bar to bar and cannot be converted', st.line);
          if (st.init.type === 'Call' && st.init.callee.startsWith('input')) return inputParam(st.name, st.init);
          return assign(st.name, tx(st.init), st.line);
        case 'TupleDecl': {
          const v = tx(st.init);
          if (!v.tuple) fail('the right side does not return a tuple', st.line);
          if (st.names.length > v.tuple) fail(`the call returns ${v.tuple} values`, st.line);
          const t = `t${++tmp}`;
          lines.push(`        ${t} = ${v.py}`);
          st.names.forEach((nm, k) => {
            if (nm === '_') return;
            lines.push(`        ${col(nm)} = ${t}[${k}]`);
            vars.set(nm, { py: col(nm), series: true });
          });
          return;
        }
        case 'Assign':
          return fail(`"${st.name} ${st.op}" reassigns a variable bar by bar and cannot be converted; compute it in one expression`, st.line);
        case 'For':
          return fail('for loops cannot be converted', st.line);
        case 'FuncDef': {
          if (conds.length) fail('functions must be defined at the top level', st.line);
          const py = `f_${pyIdent(st.name)}`;
          // A parameter may be a column or a number (a length): Python decides at run time.
          const scope = new Map(st.params.map((pm) => [pm.name, { py: pyIdent(pm.name), series: true, param: true }]));
          const body = [];
          let result = null;
          st.body.forEach((b, k) => {
            if (b.type === 'Decl' && !b.isVar) {
              const v = tx(b.init, scope);
              const local = `l_${pyIdent(b.name)}`;
              body.push(`            ${local} = ${v.py}`);
              scope.set(b.name, { py: local, series: v.series, bool: v.bool });
            } else if (b.type === 'ExprStmt' && k === st.body.length - 1) {
              result = tx(b.expr, scope);
            } else fail('function bodies can only declare variables and end with an expression', b.line);
          });
          if (!result) fail('the function must end with an expression', st.line);
          lines.push(`        def ${py}(${st.params.map((pm) => pyIdent(pm.name)).join(', ')}):`, ...body, `            return ${result.py}`, '');
          funcs.set(st.name, { py, params: st.params, tuple: result.tuple });
          return;
        }
        case 'If': {
          const c = boolOf(tx(st.cond));
          statementsIn(st.then, [...conds, c]);
          if (st.otherwise) statementsIn(st.otherwise, [...conds, c.series ? { py: `~${wrap(c.py)}`, series: true, bool: true } : { py: `(not ${c.py})`, series: false }]);
          return;
        }
        case 'ExprStmt': {
          const e = st.expr;
          if (e.type !== 'Call') fail('this statement has no effect in a Freqtrade strategy', st.line);
          if (e.callee === 'strategy' || e.callee === 'indicator' || e.callee === 'study') {
            if (conds.length) fail(`${e.callee}() must be at the top level`, st.line);
            hasStrategy = hasStrategy || e.callee === 'strategy';
            const t = e.args[0] || e.named.title;
            if (t && t.type === 'Str') settings.title = t.value;
            for (const [k, x] of Object.entries(e.named)) if (['Num', 'Str', 'Bool'].includes(x.type)) settings.args[k] = x.value;
            return;
          }
          if (e.callee.startsWith('strategy.')) return strategyCall(e, conds);
          if (e.callee === 'plot') {
            const v = tx(e.args[0] || e.named.series);
            let column = v.py.match(/^dataframe\["([^"]+)"\]$/);
            const title = (e.args[1] && e.args[1].type === 'Str' ? e.args[1].value : e.named.title && e.named.title.type === 'Str' ? e.named.title.value : null) || (column ? column[1] : `plot_${tmp + 1}`);
            if (!column && v.series) {
              const c = `plot_${++tmp}`;
              lines.push(`        ${col(c)} = ${v.py}`);
              column = [null, c];
            }
            if (column) {
              const colorNode = e.named.color || e.args[2];
              const color = colorNode && colorNode.type === 'Color' ? colorNode.value.slice(0, 7) : colorNode && colorNode.type === 'Ident' && CONSTANTS[colorNode.name] ? CONSTANTS[colorNode.name] : null;
              (settings.overlay === false || settings.args.overlay === false ? plots.sub : plots.main)[column[1]] = { title, color };
            }
            return;
          }
          if (['plotshape', 'plotchar', 'plotarrow', 'hline', 'bgcolor', 'barcolor', 'fill', 'alertcondition', 'alert'].includes(e.callee)) return;
          fail(`${e.callee}() cannot be converted`, st.line);
        }
      }
      return fail(`${st.type} cannot be converted`, st.line);
    }
    function statementsIn(list, conds) {
      for (const st of list) statement(st, conds);
    }

    statementsIn(ast.body, []);
    if (!hasStrategy) fail('only strategy(...) scripts can be converted: add strategy.entry / strategy.close calls', 1);
    for (const c of closes) {
      const dir = c.id ? entryDir.get(c.id) : null;
      if (c.id && !dir) warnings.push(`line ${c.line}: strategy.close("${c.id}") names no entry; treated as closing longs`);
      exits[dir || 'long'].push({ cond: c.cond });
    }
    if (!entries.long.length && !entries.short.length) fail('the script has no strategy.entry calls');
    // Pine reverses a position when the opposite entry fires.
    if (entries.long.length && entries.short.length) {
      exits.long.push(...entries.short.map((e) => ({ cond: e.cond })));
      exits.short.push(...entries.long.map((e) => ({ cond: e.cond })));
    }
    const canShort = entries.short.length > 0;
    const orCols = (list) => (list.length ? list.map((e) => `_bool(${e.cond}, dataframe)`).join(' | ') : 'False');
    lines.push(`        dataframe["pine_enter_long"] = ${entries.long.length ? orCols(entries.long) : 'False'}`);
    lines.push(`        dataframe["pine_exit_long"] = ${exits.long.length ? orCols(exits.long) : 'False'}`);
    if (canShort) {
      lines.push(`        dataframe["pine_enter_short"] = ${orCols(entries.short)}`);
      lines.push(`        dataframe["pine_exit_short"] = ${exits.short.length ? orCols(exits.short) : 'False'}`);
    }
    const tag = (list) => (list[0] ? list[0].id : 'pine');
    const helpers = Object.keys(PY_HELPERS).filter((h) => used.has(h)).map((h) => PY_HELPERS[h].code);
    const startup = Math.min(500, Math.max(50, Math.ceil(maxLen * 3)));
    const plotConfig = (obj) => Object.entries(obj).map(([k, v]) => `${pyStr(k)}: {${v.color ? `"color": ${pyStr(v.color)}` : ''}}`).join(', ');
    const hasSub = Object.keys(plots.sub).length > 0;
    const title = String(settings.title).replace(/"""/g, "'''");
    const importsParams = ['IStrategy', params.some((p) => p.includes('IntParameter')) && 'IntParameter', params.some((p) => p.includes('DecimalParameter')) && 'DecimalParameter', params.some((p) => p.includes('BooleanParameter')) && 'BooleanParameter'].filter(Boolean);
    const py = `"""${title} (converted from Pine Script by trading-suite).

Pine runs bar by bar and fills orders at the next bar's open; this class computes the same
columns for the whole dataframe, and Freqtrade also enters on the candle after a signal.
Inputs became hyperopt parameters. Stoploss and ROI are not taken from the script: set them.
"""
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
from freqtrade.strategy import ${importsParams.join(', ')}
from pandas import DataFrame

from ts_guard import entries_allowed


${helpers.join('\n\n\n')}


class ${className}(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = ${pyStr(timeframe)}
    can_short = ${canShort ? 'True' : 'False'}
    # Exits come from the script's strategy.close / reversal signals.
    minimal_roi = {"0": 100.0}
    stoploss = -0.10
    use_exit_signal = True
    process_only_new_candles = True
    startup_candle_count = ${startup}
${params.length ? `\n${params.join('\n')}\n` : ''}
    plot_config = {
        "main_plot": {${plotConfig(plots.main)}},${hasSub ? `\n        "subplots": {"Pine": {${plotConfig(plots.sub)}}},` : ''}
    }

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
${lines.join('\n')}
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        live = dataframe["volume"] > 0
        dataframe.loc[dataframe["pine_enter_long"] & live, ["enter_long", "enter_tag"]] = (1, ${pyStr(tag(entries.long))})${canShort ? `\n        dataframe.loc[dataframe["pine_enter_short"] & live, ["enter_short", "enter_tag"]] = (1, ${pyStr(tag(entries.short))})` : ''}
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[dataframe["pine_exit_long"], "exit_long"] = 1${canShort ? '\n        dataframe.loc[dataframe["pine_exit_short"], "exit_short"] = 1' : ''}
        return dataframe

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float, time_in_force: str,
                            current_time: datetime, entry_tag: Optional[str], side: str, **kwargs) -> bool:
        # Kill switch: no new entries while trading is halted in the trading suite.
        return entries_allowed(pair)
`;
    return { source: py, className, warnings, canShort, inputs: params.length };
  }

  return { parse, run, toFreqtrade, PineError, lex };
});
