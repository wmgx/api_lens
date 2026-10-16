// 沙箱页（manifest sandbox）：无扩展权限、独立源，允许 eval，用于执行用户输入的 $.path / JS 表达式。
(() => {
  const parse = (text) => JSON.parse(text, (_k, v, ctx) => (
    typeof v === 'number' && ctx?.source && String(v) !== ctx.source && JSON.rawJSON ? JSON.rawJSON(ctx.source) : v
  ));

  // ---------- 简易 JSONPath：$.a.b、$['a-b']、$.list[0]、[-1]、[*]、[1:3]、..key、.* ----------
  const TOKEN = /^(?:(\.\.)(\*|[A-Za-z_$][\w$-]*)|\.(\*|[A-Za-z_$][\w$-]*)|\[\s*(\*|-?\d+|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d*\s*:\s*-?\d*)\s*\])/;

  function tokenize(expr) {
    if (!expr.startsWith('$')) return null;
    const tokens = [];
    let rest = expr.slice(1).trim();
    while (rest) {
      const m = rest.match(TOKEN);
      if (!m) return null;
      if (m[1]) tokens.push({ type: 'deep', name: m[2] });
      else if (m[3]) tokens.push({ type: 'child', name: m[3] });
      else tokens.push({ type: 'bracket', raw: m[4] });
      rest = rest.slice(m[0].length).trim();
    }
    return tokens;
  }

  const isObj = (v) => v !== null && typeof v === 'object' && !(JSON.isRawJSON && JSON.isRawJSON(v));
  const childrenOf = (v) => (Array.isArray(v) ? v : isObj(v) ? Object.values(v) : []);
  const descendants = (v) => [v, ...childrenOf(v).flatMap(descendants)];
  const pick = (v, key) => (isObj(v) && Object.prototype.hasOwnProperty.call(v, key) ? [v[key]] : []);

  function applyBracket(v, raw) {
    if (raw === '*') return childrenOf(v);
    if (raw[0] === '"') return pick(v, JSON.parse(raw));
    if (raw[0] === "'") return pick(v, raw.slice(1, -1).replace(/\\(.)/g, '$1'));
    if (raw.includes(':')) {
      if (!Array.isArray(v)) return [];
      const [a, b] = raw.split(':').map((s) => s.trim());
      return v.slice(a === '' ? 0 : Number(a), b === '' ? undefined : Number(b));
    }
    const i = Number(raw);
    if (Array.isArray(v)) return i < 0 ? (v.length + i >= 0 ? [v[v.length + i]] : []) : i < v.length ? [v[i]] : [];
    return pick(v, raw);
  }

  function runPath(root, tokens) {
    let nodes = [root];
    let multi = false;
    tokens.forEach((t) => {
      if (t.type === 'deep') {
        multi = true;
        const all = nodes.flatMap(descendants);
        nodes = t.name === '*' ? all.flatMap(childrenOf) : all.flatMap((n) => pick(n, t.name));
      } else if (t.type === 'child') {
        if (t.name === '*') multi = true;
        nodes = nodes.flatMap((n) => (t.name === '*' ? childrenOf(n) : pick(n, t.name)));
      } else {
        if (t.raw === '*' || t.raw.includes(':')) multi = true;
        nodes = nodes.flatMap((n) => applyBracket(n, t.raw));
      }
    });
    return multi ? nodes : nodes[0];
  }

  function evaluate(text, input) {
    const root = parse(text);
    let expr = input.trim();
    if (expr[0] === '.' || expr[0] === '[') expr = `$${expr}`;
    const tokens = tokenize(expr);
    if (tokens) return runPath(root, tokens);
    // eslint-disable-next-line no-new-func
    return new Function('$', `"use strict"; return (${expr});`)(root);
  }

  const summarize = (v) => {
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) return `${v.length} 项`;
    if (isObj(v)) return `${Object.keys(v).length} 个字段`;
    return v === null ? 'null' : typeof v === 'object' ? 'number' : typeof v;
  };

  window.addEventListener('message', (e) => {
    const { id, text, expr } = e.data || {};
    if (id == null) return;
    try {
      const value = evaluate(text, expr);
      if (typeof value === 'function') throw new Error('结果是函数，请调用它或返回数据');
      const out = value === undefined ? 'undefined' : JSON.stringify(value, null, 2);
      e.source.postMessage({ id, ok: true, text: out, summary: summarize(value) }, '*');
    } catch (err) {
      e.source.postMessage({ id, ok: false, error: String(err?.message || err) }, '*');
    }
  });
})();
