import { esc, highlight, icons, copyWithToast, attachClear } from './util.js';
import { evaluate } from './sandboxClient.js';
import { attachHistory } from './history.js';
import { openMenu } from './menu.js';

const CHUNK = 500; // 单层子节点超过此数分批渲染
const AUTO_EXPAND_LIMIT = 3000; // 节点数不超过此值时默认全部展开
const MAX_MATCHES = 10000;
const SEP = '\u0000';
const IDENT = /^[A-Za-z_$][\w$]*$/;

const isRaw = (v) => typeof JSON.isRawJSON === 'function' && JSON.isRawJSON(v);
const kindOf = (v) => {
  if (v === null) return 'null';
  if (isRaw(v)) return 'number';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};
const isContainer = (v) => ['array', 'object'].includes(kindOf(v));
const entries = (v) => (Array.isArray(v) ? v.map((c, i) => [i, c]) : Object.entries(v));
const keyOf = (path) => path.join(SEP);
// 展示文本：字符串按 JSON 转义（\n、\" 等），避免换行 / 引号打乱结构；复制时仍用原值
const primText = (v) => {
  if (isRaw(v)) return v.rawJSON;
  return typeof v === 'string' ? JSON.stringify(v).slice(1, -1) : String(v);
};
export const fmtPath = (path) => `$${path.map((k) => (
  typeof k === 'number' ? `[${k}]` : IDENT.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`
)).join('')}`;

// 超出安全整数范围的数字保留原文（如 int64 ID），避免精度丢失
export function parseJson(text) {
  try {
    const value = JSON.parse(text, (_k, v, ctx) => (
      typeof v === 'number' && ctx?.source && String(v) !== ctx.source && JSON.rawJSON ? JSON.rawJSON(ctx.source) : v
    ));
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

// 文本模式的语法高亮：对非严格 JSON 也尽量着色，搜索命中在各 token 内标记
const TOKEN_RE = /("(?:[^"\\\n]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
function syntaxHighlight(text, query) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    out += highlight(text.slice(last, m.index), query);
    const [, str, colon, num, kw] = m;
    if (str) {
      out += `<span class="${colon ? 'jv-k' : 'jv-str'}">${highlight(str, query)}</span>`;
      if (colon) out += `<span class="jv-p">${highlight(colon, query)}</span>`;
    } else {
      out += `<span class="${num ? 'jv-number' : 'jv-null'}">${highlight(num || kw, query)}</span>`;
    }
    last = m.index + m[0].length;
  }
  return out + highlight(text.slice(last), query);
}

// 文本模式逐行渲染，折行续行对齐到该行缩进；行数过多时退回整段 <pre> 保证性能
const RAW_LINE_LIMIT = 20000;
function rawHtml(text, paint, query) {
  const lines = text.split('\n');
  if (lines.length > RAW_LINE_LIMIT) return `<pre class="jv-raw">${paint(text, query)}</pre>`;
  return `<div class="jv-raw">${lines.map((line) => {
    const body = line.trimStart();
    return `<div class="jv-line" style="--i:${line.length - body.length}">${body ? paint(body, query) : ' '}</div>`;
  }).join('')}</div>`;
}

// 输入框固定以 $. 开头：data.x → $.data.x；[0] → $[0]
const toFullExpr = (input) => (!input ? '' : input[0] === '[' ? `$${input}` : `$.${input}`);
const stripPrefix = (v) => v.trim().replace(/^\$\.?/, '');

const stringify = (v) => (isContainer(v) ? JSON.stringify(v, null, 2) : kindOf(v) === 'string' ? v : primText(v));

export function createJsonView(host) {
  host.classList.add('jv');
  host.innerHTML = `
    <div class="jv-bar">
      <label class="jv-field jv-query" title="按路径 / JSONPath / JS 表达式过滤，如 data.list[*].id、data.list.filter(x => x.ok)，回车执行">
        <span class="jv-prefix">$.</span>
        <input type="text" data-in="query" placeholder="data.list[*].id 或 JS 表达式" spellcheck="false" autocomplete="off">
        <button type="button" data-act="apply" title="应用过滤（Enter）">${icons.enter}</button>
      </label>
      <label class="jv-field jv-search">${icons.search}
        <input type="text" data-in="search" placeholder="搜索" spellcheck="false" autocomplete="off">
        <span class="jv-count"></span>
        <button type="button" data-act="prev" title="上一个 (Shift+Enter)">${icons.up}</button>
        <button type="button" data-act="next" title="下一个 (Enter)">${icons.down}</button>
      </label>
      <div class="jv-tools">
        <button type="button" data-act="expand" title="全部展开">${icons.expand}</button>
        <button type="button" data-act="collapse" title="全部折叠">${icons.collapse}</button>
        <button type="button" data-act="mode"></button>
        <button type="button" data-act="copy" title="复制当前显示的全部内容">${icons.copy}</button>
      </div>
    </div>
    <div class="jv-banner" hidden></div>
    <div class="jv-body" tabindex="-1"></div>
    <div class="jv-path" title="点击复制路径"><span>悬停查看路径 · 右键更多操作</span></div>
    <button type="button" class="jv-cp" title="复制此值" hidden>${icons.copy}</button>`;

  const q = (sel) => host.querySelector(sel);
  const searchInput = q('[data-in="search"]');
  const queryInput = q('[data-in="query"]');
  const countEl = q('.jv-count');
  const body = q('.jv-body');
  const banner = q('.jv-banner');
  const pathBar = q('.jv-path');
  const modeBtn = q('[data-act="mode"]');
  const copyBtn = q('.jv-cp');

  let source = { text: '', emptyText: '无内容', ok: false };
  let expr = '';
  let evalSeq = 0;
  let st = {
    text: '', isJson: false, data: undefined, pretty: '', isResult: false,
    mode: 'tree', expanded: new Set(), showAll: new Set(), query: '', matches: [], cur: -1,
  };
  let refs = new Map(); // pathKey -> 行元素（用于搜索定位）
  const nodeOf = new WeakMap(); // 元素 -> { key, path, depth, last }
  let hoverRow = null;

  const getAt = (path) => path.reduce((v, k) => v[k], st.data);

  const walkContainers = (fn) => {
    const walk = (v, path, depth) => {
      if (!isContainer(v)) return;
      fn(path, depth);
      entries(v).forEach(([k, c]) => walk(c, [...path, k], depth + 1));
    };
    walk(st.data, [], 0);
  };

  const initialExpanded = () => {
    const all = [];
    let count = 0;
    const walk = (v, path, depth) => {
      count += 1;
      if (!isContainer(v)) return;
      all.push({ pk: keyOf(path), depth });
      entries(v).forEach(([k, c]) => walk(c, [...path, k], depth + 1));
    };
    walk(st.data, [], 0);
    return new Set(all.filter((n) => count <= AUTO_EXPAND_LIMIT || n.depth < 2).map((n) => n.pk));
  };

  // ---------- 渲染 ----------
  const row = (cls, depth, html) => {
    const el = document.createElement('div');
    el.className = cls;
    el.style.setProperty('--d', depth);
    el.innerHTML = html;
    return el;
  };

  const primHtml = (v) => {
    const kind = kindOf(v);
    const text = highlight(primText(v), st.query);
    return kind === 'string'
      ? `<span class="jv-v jv-str">"${text}"</span>`
      : `<span class="jv-v jv-${kind}">${text}</span>`;
  };

  function renderNode(key, value, path, depth, last) {
    const pk = keyOf(path);
    const info = { key, path, depth, last };
    const comma = last ? '' : '<span class="jv-p">,</span>';
    const keyHtml = typeof key === 'string'
      ? `<span class="jv-k">"${highlight(key, st.query)}"</span><span class="jv-p">: </span>`
      : typeof key === 'number' ? `<span class="jv-i">${key}</span>` : '';

    if (!isContainer(value)) {
      const el = row('jv-row', depth, `${keyHtml}${primHtml(value)}${comma}`);
      nodeOf.set(el, info);
      refs.set(pk, el);
      return el;
    }

    const isArr = Array.isArray(value);
    const list = entries(value);
    const [ob, cb] = isArr ? ['[', ']'] : ['{', '}'];
    const blk = document.createElement('div');
    blk.className = 'jv-blk';
    nodeOf.set(blk, info);

    const n = list.length;
    const summary = isArr ? `${n} ${n === 1 ? 'item' : 'items'}` : `${n} ${n === 1 ? 'key' : 'keys'}`;
    const open = st.expanded.has(pk) && list.length > 0;
    const head = row(`jv-row jv-head${open ? ' open' : ''}${list.length ? '' : ' jv-leaf'}`, depth, !list.length
      ? `${keyHtml}<span class="jv-b">${ob}${cb}</span>${comma}`
      : open
        ? `<span class="jv-tg" data-t></span>${keyHtml}<span class="jv-b" data-t>${ob}</span><span class="jv-cnt">${summary}</span>`
        : `<span class="jv-tg" data-t></span>${keyHtml}<span class="jv-b jv-fold" data-t>${ob}…${cb}</span>${comma}<span class="jv-sum" data-t>${summary}</span>`);
    nodeOf.set(head, info);
    refs.set(pk, head);
    blk.appendChild(head);
    if (!open) return blk;

    const limit = st.showAll.has(pk) ? list.length : Math.min(list.length, CHUNK);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < limit; i += 1) {
      const [k, c] = list[i];
      frag.appendChild(renderNode(k, c, [...path, k], depth + 1, i === list.length - 1));
    }
    if (limit < list.length) {
      const more = row('jv-row jv-more-row', depth + 1, `<button type="button" class="jv-more">显示剩余 ${list.length - limit} 项</button>`);
      nodeOf.set(more.firstChild, { pk });
      frag.appendChild(more);
    }
    const tail = row('jv-row jv-tail', depth, `<span class="jv-b">${cb}</span>${comma}`);
    nodeOf.set(tail, info);
    frag.appendChild(tail);
    blk.appendChild(frag);
    return blk;
  }

  const rawText = () => (st.isJson ? st.pretty : st.text);

  function render() {
    refs = new Map();
    hideHover();
    pathBar.innerHTML = '<span>悬停查看路径 · 右键更多操作</span>';
    body.textContent = '';
    modeBtn.innerHTML = st.mode === 'tree' ? icons.code : icons.tree;
    modeBtn.dataset.tip = st.mode === 'tree' ? '切换为文本视图' : '切换为树形视图';
    modeBtn.disabled = !st.isJson;
    host.classList.toggle('raw', st.mode === 'raw' || !st.isJson);
    if (!st.text) {
      body.innerHTML = `<div class="jv-empty">${esc(source.emptyText)}</div>`;
      return;
    }
    if (st.mode === 'raw' || !st.isJson) {
      const text = rawText();
      const colorize = st.isJson || /^\s*[[{]/.test(text);
      body.innerHTML = rawHtml(text, colorize ? syntaxHighlight : highlight, st.query);
      return;
    }
    const tree = document.createElement('div');
    tree.className = 'jv-tree';
    tree.appendChild(renderNode(null, st.data, [], 0, true));
    body.appendChild(tree);
  }

  function rerenderBlock(blk) {
    const info = nodeOf.get(blk);
    blk.replaceWith(renderNode(info.key, getAt(info.path), info.path, info.depth, info.last));
  }

  // 展示一段文本（原始 Body 或表达式结果）
  function display(text, isResult) {
    const parsed = text ? parseJson(text) : { ok: false };
    st = {
      ...st,
      text: text || '',
      isResult,
      isJson: parsed.ok,
      data: parsed.ok ? parsed.value : undefined,
      pretty: parsed.ok ? JSON.stringify(parsed.value, null, 2) : '',
      showAll: new Set(),
    };
    st.expanded = parsed.ok ? initialExpanded() : new Set();
    body.scrollTop = 0;
    refreshSearch(false);
  }

  // ---------- 表达式过滤 ----------
  const setBanner = (html, cls = '') => {
    banner.hidden = !html;
    banner.className = `jv-banner ${cls}`;
    banner.innerHTML = html;
  };

  async function applyExpr() {
    evalSeq += 1;
    const token = evalSeq;
    host.classList.toggle('nojson', !!source.text && !source.ok);
    host.classList.toggle('filtered', !!expr);
    if (!expr || !source.text) {
      setBanner('');
      display(source.text, false);
      return;
    }
    if (!source.ok) {
      setBanner('当前内容不是 JSON，无法过滤', 'err');
      display(source.text, false);
      return;
    }
    try {
      const res = await evaluate(source.text, toFullExpr(expr));
      if (token !== evalSeq) return;
      setBanner(`<b>过滤结果</b><code>${esc(toFullExpr(expr))}</code><span>${esc(res.summary)}</span>`);
      display(res.text, true);
      history.commit(expr);
    } catch (err) {
      if (token !== evalSeq) return;
      setBanner(`<b>表达式错误</b><span>${esc(err.message)}</span>`, 'err');
      display(source.text, false);
    }
  }

  const applyBtn = q('[data-act="apply"]');
  const setExpr = (value) => {
    expr = stripPrefix(value);
    queryInput.value = expr;
    applyBtn.classList.remove('pending');
    applyExpr();
  };

  const history = attachHistory(queryInput, { key: 'hist:query', onPick: setExpr });
  attachClear(queryInput);
  attachClear(searchInput);
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setExpr(queryInput.value);
    } else if (e.key === 'Escape' && queryInput.value) {
      e.stopPropagation();
      setExpr('');
    }
  });
  // 输入内容与已生效的表达式不同时，高亮「应用」按钮，提示还没执行
  const syncApply = () => applyBtn.classList.toggle('pending', stripPrefix(queryInput.value) !== expr);
  queryInput.addEventListener('input', () => {
    if (!queryInput.value.trim() && expr) setExpr('');
    syncApply();
  });

  // ---------- 搜索 ----------
  function findMatches() {
    const ql = st.query.toLowerCase();
    if (!ql) return [];
    if (st.mode === 'raw' || !st.isJson) return [...body.querySelectorAll('mark')].slice(0, MAX_MATCHES);
    const out = [];
    const walk = (v, path) => {
      if (out.length >= MAX_MATCHES) return;
      if (!isContainer(v)) {
        if (primText(v).toLowerCase().includes(ql)) out.push({ path, part: 'v' });
        return;
      }
      const isArr = Array.isArray(v);
      entries(v).forEach(([k, c]) => {
        const p = [...path, k];
        if (!isArr && k.toLowerCase().includes(ql)) out.push({ path: p, part: 'k' });
        walk(c, p);
      });
    };
    walk(st.data, []);
    return out;
  }

  function updateCount() {
    const n = st.matches.length;
    countEl.textContent = !st.query ? '' : n ? `${st.cur + 1 || 0}/${n}${n >= MAX_MATCHES ? '+' : ''}` : '无结果';
    countEl.classList.toggle('none', !!st.query && !n);
  }

  // 展开命中路径上的所有祖先，再滚动定位
  function reveal(m) {
    let changed = false;
    for (let i = 0; i < m.path.length; i += 1) {
      const anc = m.path.slice(0, i);
      const pk = keyOf(anc);
      if (!st.expanded.has(pk)) {
        st.expanded.add(pk);
        changed = true;
      }
      const parent = getAt(anc);
      const idx = Array.isArray(parent) ? m.path[i] : Object.keys(parent).indexOf(m.path[i]);
      if (idx >= CHUNK && !st.showAll.has(pk)) {
        st.showAll.add(pk);
        changed = true;
      }
    }
    if (changed) render();
    const el = refs.get(keyOf(m.path));
    return el?.querySelector(m.part === 'k' ? '.jv-k' : '.jv-v');
  }

  function goTo(i) {
    const n = st.matches.length;
    if (!n) return updateCount();
    st.cur = ((i % n) + n) % n;
    body.querySelectorAll('.jv-cur').forEach((x) => x.classList.remove('jv-cur'));
    const m = st.matches[st.cur];
    const target = m instanceof Element ? m : reveal(m);
    if (target) {
      target.classList.add('jv-cur');
      target.scrollIntoView({ block: 'center' });
    }
    updateCount();
  }

  function refreshSearch(jump) {
    render();
    st.matches = findMatches();
    st.cur = -1;
    if (jump && st.matches.length) goTo(0);
    else updateCount();
  }

  let searchTimer = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      st.query = searchInput.value.trim();
      refreshSearch(true);
    }, 150);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goTo(st.cur + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape' && searchInput.value) {
      e.stopPropagation();
      searchInput.value = '';
      st.query = '';
      refreshSearch(false);
    }
  });

  // ---------- 展开 / 折叠 ----------
  const setAll = (open, root = []) => {
    const prefix = keyOf(root);
    const under = (pk) => !root.length || pk === prefix || pk.startsWith(prefix + SEP);
    const keep = [...st.expanded].filter((pk) => !under(pk));
    const touched = [];
    walkContainers((path) => { const pk = keyOf(path); if (under(pk)) touched.push(pk); });
    st.expanded = new Set(open ? [...keep, ...touched] : [...keep, ...(root.length ? [] : [''])]);
  };

  const blockOf = (path) => refs.get(keyOf(path))?.closest('.jv-blk');

  q('.jv-bar').addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    if (act === 'apply') setExpr(queryInput.value);
    if (act === 'prev') goTo(st.cur - 1);
    if (act === 'next') goTo(st.cur + 1);
    if (act === 'copy') copyWithToast(rawText());
    if (act === 'mode') {
      st.mode = st.mode === 'tree' ? 'raw' : 'tree';
      refreshSearch(false);
    }
    if ((act === 'expand' || act === 'collapse') && st.isJson) {
      setAll(act === 'expand');
      st.mode = 'tree';
      refreshSearch(false);
    }
  });

  body.addEventListener('click', (e) => {
    const more = e.target.closest('.jv-more');
    if (more) {
      st.showAll.add(nodeOf.get(more).pk);
      rerenderBlock(more.closest('.jv-blk'));
      return;
    }
    if (!e.target.closest('[data-t]')) return;
    const blk = e.target.closest('.jv-blk');
    const { path } = nodeOf.get(blk);
    const pk = keyOf(path);
    const willOpen = !st.expanded.has(pk);
    // Alt / Option + 点击：递归展开或折叠整棵子树
    if (e.altKey) setAll(willOpen, path);
    if (willOpen) st.expanded.add(pk);
    else st.expanded.delete(pk);
    rerenderBlock(blk);
  });

  // ---------- 悬停：路径栏 + 浮动复制按钮 ----------
  function hideHover() {
    hoverRow = null;
    copyBtn.hidden = true;
  }

  const pathLabel = (path) => (st.isResult ? `结果${fmtPath(path).slice(1)}` : fmtPath(path));

  body.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.jv-row');
    if (!el || el === hoverRow) return;
    const info = nodeOf.get(el);
    if (!info?.path) return hideHover();
    hoverRow = el;
    pathBar.innerHTML = `<code>${esc(pathLabel(info.path))}</code>`;
    if (el.classList.contains('jv-tail')) return void (copyBtn.hidden = true);
    copyBtn.hidden = false;
    copyBtn.style.top = `${el.getBoundingClientRect().top - host.getBoundingClientRect().top}px`;
  });
  body.addEventListener('scroll', hideHover);
  host.addEventListener('mouseleave', hideHover);
  copyBtn.addEventListener('click', () => {
    const info = hoverRow && nodeOf.get(hoverRow);
    if (info?.path) copyWithToast(stringify(getAt(info.path)));
  });
  pathBar.addEventListener('click', () => {
    const code = pathBar.querySelector('code');
    if (code) copyWithToast(code.textContent, '已复制路径');
  });

  // ---------- 右键菜单 ----------
  body.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.jv-row');
    const info = el && nodeOf.get(el);
    if (!info?.path || !st.isJson || st.mode !== 'tree') return;
    e.preventDefault();
    const value = getAt(info.path);
    const container = isContainer(value);
    openMenu([
      { label: '复制值', run: () => copyWithToast(stringify(value)) },
      { label: '复制路径', hint: fmtPath(info.path), run: () => copyWithToast(fmtPath(info.path), '已复制路径') },
      typeof info.key === 'string' && { label: '复制 key', run: () => copyWithToast(info.key) },
      '-',
      !st.isResult && info.path.length > 0 && { label: '按此路径过滤', run: () => setExpr(fmtPath(info.path)) },
      container && { label: '展开全部子节点', hint: 'Alt+点击', run: () => { setAll(true, info.path); st.expanded.add(keyOf(info.path)); rerenderBlock(blockOf(info.path)); } },
      container && { label: '折叠全部子节点', run: () => { setAll(false, info.path); rerenderBlock(blockOf(info.path)); } },
    ], e.clientX, e.clientY);
  });

  return {
    set(text, { emptyText = '无内容' } = {}) {
      source = { text: text || '', emptyText, ok: !!text && parseJson(text).ok };
      applyExpr();
    },
    focusSearch() {
      searchInput.focus();
      searchInput.select();
    },
    focusQuery() {
      queryInput.focus();
      queryInput.select();
    },
  };
}
