// A small interpreter for the Python-style expressions in Cura's setting definitions
// ("value", "enabled", "minimum_value"...). It is an interpreter, not a translator to JavaScript,
// because the app's Content-Security-Policy does not allow eval / new Function.
//
// Supported: numbers, strings, True/False/None, lists and tuples, + - * / % // **, comparisons
// (including chains, `in`, `not in`), and / or / not, `a if c else b`, calls, `math.x`,
// subscripts and generator expressions such as `all(p != 'x' for p in values)`.

const KEYWORDS = new Set(['and', 'or', 'not', 'if', 'else', 'in', 'for', 'True', 'False', 'None']);

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      out.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; s += src[j]; j++; }
      if (j >= src.length) throw new Error('Unterminated string in expression: ' + src);
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*/.exec(src.slice(i));
      out.push(KEYWORDS.has(m[0]) ? { t: 'kw', v: m[0] } : { t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const three = src.slice(i, i + 2);
    if (['**', '//', '==', '!=', '<=', '>='].includes(three)) { out.push({ t: 'op', v: three }); i += 2; continue; }
    if ('+-*/%<>()[],'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected character "${c}" in expression: ${src}`);
  }
  return out;
}

class Parser {
  constructor(src) { this.src = src; this.toks = tokenize(src); this.p = 0; }
  peek() { return this.toks[this.p]; }
  next() { return this.toks[this.p++]; }
  isOp(v) { const t = this.peek(); return t && t.t === 'op' && t.v === v; }
  isKw(v) { const t = this.peek(); return t && t.t === 'kw' && t.v === v; }
  expectOp(v) { if (!this.isOp(v)) throw new Error(`Expected "${v}" in expression: ${this.src}`); this.p++; }

  parse() {
    const e = this.ternary();
    if (this.p < this.toks.length) throw new Error('Unexpected token in expression: ' + this.src);
    return e;
  }
  ternary() {
    const body = this.or();
    if (this.isKw('if')) {
      this.p++;
      const cond = this.or();
      if (!this.isKw('else')) throw new Error('Expected else in expression: ' + this.src);
      this.p++;
      return { k: 'if', cond, a: body, b: this.ternary() };
    }
    return body;
  }
  or() { let l = this.and(); while (this.isKw('or')) { this.p++; l = { k: 'or', a: l, b: this.and() }; } return l; }
  and() { let l = this.not(); while (this.isKw('and')) { this.p++; l = { k: 'and', a: l, b: this.not() }; } return l; }
  not() { if (this.isKw('not')) { this.p++; return { k: 'not', a: this.not() }; } return this.comparison(); }
  comparison() {
    const first = this.arith();
    const ops = [];
    for (;;) {
      const t = this.peek();
      let op = null;
      if (t && t.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v)) { op = t.v; this.p++; }
      else if (this.isKw('in')) { op = 'in'; this.p++; }
      else if (this.isKw('not') && this.toks[this.p + 1] && this.toks[this.p + 1].v === 'in') { op = 'not in'; this.p += 2; }
      if (!op) break;
      ops.push([op, this.arith()]);
    }
    return ops.length ? { k: 'cmp', first, ops } : first;
  }
  arith() {
    let l = this.term();
    while (this.isOp('+') || this.isOp('-')) { const op = this.next().v; l = { k: 'bin', op, a: l, b: this.term() }; }
    return l;
  }
  term() {
    let l = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%') || this.isOp('//')) { const op = this.next().v; l = { k: 'bin', op, a: l, b: this.unary() }; }
    return l;
  }
  unary() {
    if (this.isOp('-')) { this.p++; return { k: 'neg', a: this.unary() }; }
    if (this.isOp('+')) { this.p++; return this.unary(); }
    return this.power();
  }
  power() {
    const base = this.postfix();
    if (this.isOp('**')) { this.p++; return { k: 'bin', op: '**', a: base, b: this.unary() }; }
    return base;
  }
  postfix() {
    let e = this.atom();
    for (;;) {
      if (this.isOp('(')) {
        this.p++;
        const args = [];
        while (!this.isOp(')')) {
          const a = this.ternary();
          if (this.isKw('for')) { this.p++; args.push(this.comprehension(a)); } else args.push(a);
          if (this.isOp(',')) this.p++; else break;
        }
        this.expectOp(')');
        e = { k: 'call', fn: e, args };
      } else if (this.isOp('[')) {
        this.p++;
        const idx = this.ternary();
        this.expectOp(']');
        e = { k: 'index', a: e, idx };
      } else break;
    }
    return e;
  }
  comprehension(expr) {
    const nameTok = this.next();
    if (!nameTok || nameTok.t !== 'id') throw new Error('Bad comprehension in expression: ' + this.src);
    if (!this.isKw('in')) throw new Error('Bad comprehension in expression: ' + this.src);
    this.p++;
    const iter = this.or();
    let cond = null;
    if (this.isKw('if')) { this.p++; cond = this.or(); }
    return { k: 'comp', expr, name: nameTok.v, iter, cond };
  }
  atom() {
    const t = this.next();
    if (!t) throw new Error('Unexpected end of expression: ' + this.src);
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'kw') {
      if (t.v === 'True') return { k: 'lit', v: true };
      if (t.v === 'False') return { k: 'lit', v: false };
      if (t.v === 'None') return { k: 'lit', v: null };
      throw new Error(`Unexpected "${t.v}" in expression: ${this.src}`);
    }
    if (t.t === 'id') return { k: 'name', name: t.v };
    if (t.v === '(') {
      const items = [];
      let tuple = false;
      while (!this.isOp(')')) {
        items.push(this.ternary());
        if (this.isOp(',')) { this.p++; tuple = true; } else break;
      }
      this.expectOp(')');
      return tuple || items.length === 0 ? { k: 'list', items } : items[0];
    }
    if (t.v === '[') {
      const items = [];
      while (!this.isOp(']')) { items.push(this.ternary()); if (this.isOp(',')) this.p++; else break; }
      this.expectOp(']');
      return { k: 'list', items };
    }
    throw new Error(`Unexpected "${t.v}" in expression: ${this.src}`);
  }
}

const cache = new Map();
/** Parse once, reuse forever. */
export function compile(src) {
  let ast = cache.get(src);
  if (!ast) { ast = new Parser(src).parse(); cache.set(src, ast); }
  return ast;
}

// ---------------------------------------------------------------- semantics
const truthy = (v) => !(v === false || v === null || v === undefined || v === 0 || v === '' || (Array.isArray(v) && v.length === 0));
const num = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

function eq(a, b) {
  const x = num(a), y = num(b);
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => eq(v, y[i]));
  return x === y;
}
function cmp(op, a, b) {
  if (op === '==') return eq(a, b);
  if (op === '!=') return !eq(a, b);
  const x = num(a), y = num(b);
  if (x === null || y === null || x === undefined || y === undefined) throw new Error('Cannot order None');
  switch (op) { case '<': return x < y; case '>': return x > y; case '<=': return x <= y; default: return x >= y; }
}
function contains(list, v) {
  if (typeof list === 'string') return list.includes(v);
  return list.some((x) => eq(x, v));
}
const pyMod = (a, b) => ((a % b) + b) % b;

/** Python's round(): halves go to the even neighbour. */
export function pyRound(x, digits) {
  if (digits === undefined || digits === null) {
    const f = Math.floor(x), d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }
  const k = 10 ** digits;
  return pyRound(x * k) / k;
}

const flat = (args) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map(num);
const BUILTINS = {
  abs: (x) => Math.abs(num(x)),
  min: (...a) => Math.min(...flat(a)),
  max: (...a) => Math.max(...flat(a)),
  sum: (l, start = 0) => l.reduce((s, v) => s + num(v), start),
  round: (x, d) => pyRound(num(x), d),
  int: (x) => (typeof x === 'string' ? parseInt(x, 10) : Math.trunc(num(x))),
  float: (x) => (typeof x === 'string' ? parseFloat(x) : num(x)),
  str: (x) => String(x),
  len: (x) => x.length,
  any: (l) => l.some(truthy),
  all: (l) => l.every(truthy),
  map: (f, l) => l.map((v) => f(v)),
  'math.sqrt': Math.sqrt, 'math.ceil': Math.ceil, 'math.floor': Math.floor, 'math.log': (x, b) => (b ? Math.log(x) / Math.log(b) : Math.log(x)),
  'math.tan': Math.tan, 'math.sin': Math.sin, 'math.cos': Math.cos, 'math.radians': (d) => (d * Math.PI) / 180, 'math.degrees': (r) => (r * 180) / Math.PI,
  'math.pi': Math.PI,
};

/**
 * Evaluate a compiled expression. `scope` supplies { get(name) } for setting values and an optional
 * `fns` map for host functions (resolveOrValue, extruderValue...).
 */
export function evaluate(ast, scope, locals) {
  switch (ast.k) {
    case 'lit': return ast.v;
    case 'name': {
      if (locals && ast.name in locals) return locals[ast.name];
      if (ast.name in BUILTINS) return BUILTINS[ast.name];
      if (scope.fns && ast.name in scope.fns) return scope.fns[ast.name];
      return scope.get(ast.name);
    }
    case 'list': return ast.items.map((i) => evaluate(i, scope, locals));
    case 'neg': return -num(evaluate(ast.a, scope, locals));
    case 'not': return !truthy(evaluate(ast.a, scope, locals));
    case 'and': { const l = evaluate(ast.a, scope, locals); return truthy(l) ? evaluate(ast.b, scope, locals) : l; }
    case 'or': { const l = evaluate(ast.a, scope, locals); return truthy(l) ? l : evaluate(ast.b, scope, locals); }
    case 'if': return truthy(evaluate(ast.cond, scope, locals)) ? evaluate(ast.a, scope, locals) : evaluate(ast.b, scope, locals);
    case 'cmp': {
      let left = evaluate(ast.first, scope, locals);
      for (const [op, rhs] of ast.ops) {
        const right = evaluate(rhs, scope, locals);
        const ok = op === 'in' ? contains(right, left) : op === 'not in' ? !contains(right, left) : cmp(op, left, right);
        if (!ok) return false;
        left = right;
      }
      return true;
    }
    case 'bin': {
      const a = num(evaluate(ast.a, scope, locals)), b = num(evaluate(ast.b, scope, locals));
      switch (ast.op) {
        case '+': return typeof a === 'string' || Array.isArray(a) ? a.concat(b) : a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': if (b === 0) throw new Error('Division by zero'); return a / b;
        case '//': return Math.floor(a / b);
        case '%': return pyMod(a, b);
        default: return a ** b;
      }
    }
    case 'index': { const a = evaluate(ast.a, scope, locals); let i = evaluate(ast.idx, scope, locals); if (i < 0) i += a.length; return a[i]; }
    case 'comp': {
      const out = [];
      for (const item of evaluate(ast.iter, scope, locals)) {
        const inner = { ...locals, [ast.name]: item };
        if (ast.cond && !truthy(evaluate(ast.cond, scope, inner))) continue;
        out.push(evaluate(ast.expr, scope, inner));
      }
      return out;
    }
    case 'call': {
      if (ast.fn.k === 'name' && ast.fn.name in BUILTINS && typeof BUILTINS[ast.fn.name] !== 'function') throw new Error(ast.fn.name + ' is not callable');
      const fn = evaluate(ast.fn, scope, locals);
      if (typeof fn !== 'function') throw new Error('Not a function in expression');
      return fn(...ast.args.map((a) => evaluate(a, scope, locals)));
    }
    default: throw new Error('Unknown expression node ' + ast.k);
  }
}

/** Convenience: compile + evaluate a source string. */
export function run(src, scope) { return evaluate(compile(src), scope); }
