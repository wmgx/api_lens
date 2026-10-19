import {
  $, esc, icons, fmtTime, fmtDuration, splitUrl, statusClass, copyWithToast, settings, toast, attachClear, typeLabel,
} from './util.js';
import { createDetail } from './detail.js';
import { compileRule, toMatcher } from './hostFilter.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig, createSettings } from './settingsView.js';
import { attachHistory } from './history.js';
import { openMenu, createDropdown } from './menu.js';
import { toCurl } from './curl.js';
import { exportRecords, downloadBody } from './exporter.js';
import './hintTip.js';

const ROW_H = 26;
const OVERSCAN = 10;
const TIP_DELAY = 350;
const COMMON_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const theme = chrome.devtools?.panels?.themeName;
if (theme) document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';

$('.filter-icon').innerHTML = icons.filter;
$('#btn-settings').innerHTML = icons.gear;
$('#btn-clear').innerHTML = icons.trash;
$('#btn-export').innerHTML = icons.download;

let store = null;
let filtered = [];
let selectedId = null;
const DEFAULT_TYPES = ['json'];
let filter = { tokens: [], method: 'ALL', status: 'all', types: new Set(DEFAULT_TYPES) };
let config = DEFAULT_CONFIG;
let configVer = 0;
let hostOk = compileRule(config.hostFilter);
let paintQueued = false;

const vlist = $('#vlist');
const vspacer = $('#vspacer');
const detailEl = $('#detail');
const split = $('#split');
const tip = $('#tip');

const urlCache = new WeakMap();
const urlParts = (r) => {
  if (!urlCache.has(r)) urlCache.set(r, splitUrl(r.url));
  return urlCache.get(r);
};

// ---------- Header 提取（按配置顺序，响应头优先） ----------
const extractCache = new WeakMap();
function extract(r) {
  const hit = extractCache.get(r);
  if (hit?.ver === configVer) return hit.items;
  const find = (pairs, name) => pairs.find(([k]) => k.toLowerCase() === name)?.[1] || '';
  const items = config.extractHeaders.map((name) => ({
    name, value: find(r.resHeaders, name) || find(r.reqHeaders, name),
  }));
  extractCache.set(r, { ver: configVer, items });
  return items;
}

// ---------- 筛选 ----------
// 与 Chrome 网络面板一致支持 method: / status-code: / domain:（可用 *），其余按关键词匹配；- 前缀表示排除
const PROPS = {
  method: (v) => (r) => r.method.toLowerCase() === v,
  'status-code': (v) => (r) => String(r.status) === v,
  domain: (v) => {
    const hit = toMatcher(v);
    return (r) => hit(urlParts(r).hostname);
  },
};
const parseToken = (raw) => {
  const neg = raw.startsWith('-') && raw.length > 1;
  const t = neg ? raw.slice(1) : raw;
  const i = t.indexOf(':');
  const prop = i > 0 && t.length > i + 1 && PROPS[t.slice(0, i)];
  return prop ? { neg, test: prop(t.slice(i + 1)) } : { neg, t };
};
const parseTokens = (text) => text.toLowerCase().split(/\s+/).filter(Boolean).map(parseToken);

// 失败或 4xx/5xx 的接口常常没有 JSON 响应体，排查时又最需要看到，JSON 筛选一并放行
const isApiError = (r) => r.category === 'fetch' && (!r.status || r.status >= 400);

function passes(r) {
  if (filter.method === 'OTHER' ? COMMON_METHODS.includes(r.method) : filter.method !== 'ALL' && r.method !== filter.method) return false;
  if (filter.status !== 'all' && statusClass(r.status) !== filter.status) return false;
  const { types } = filter;
  if (!types.has('all') && !types.has(r.category) && !(types.has('json') && (r.json || isApiError(r)))) return false;
  if (!hostOk(urlParts(r).hostname)) return false;
  if (!filter.tokens.length) return true;
  let hay = null;
  return filter.tokens.every(({ neg, t, test }) => {
    if (test) return test(r) !== neg;
    hay ??= `${r.url} ${extract(r).map((it) => it.value).join(' ')}`.toLowerCase();
    return hay.includes(t) !== neg;
  });
}

const insertIndex = (list, time) => {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].startTime <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// ---------- 列表（虚拟滚动） ----------
const atBottom = () => vlist.scrollTop + vlist.clientHeight >= vlist.scrollHeight - ROW_H;

const rowHtml = (r) => {
  const { host, path } = urlParts(r);
  const slow = r.duration >= 1000 ? ' slow' : '';
  return `<div class="r">
    <span class="c-time">${fmtTime(r.startTime)}</span>
    <span class="c-m m-${esc(r.method.toLowerCase())}">${esc(r.method)}</span>
    <span class="c-st ${statusClass(r.status)}">${r.status || '失败'}</span>
    <span class="c-type">${esc(typeLabel(r))}</span>
    <span class="c-url"><span class="u-path">${esc(path)}</span><span class="u-host">${esc(host)}</span></span>
    <span class="c-dur${slow}">${fmtDuration(r.duration)}</span>
  </div>`;
};

// 可见行按记录 id 复用 DOM：新请求到来时只增删变化的行，避免悬停中的行被替换而闪烁
let rowEls = new Map();
const rowTpl = document.createElement('template');
const makeRow = (r) => {
  rowTpl.innerHTML = rowHtml(r);
  return rowTpl.content.firstElementChild;
};

function paint() {
  paintQueued = false;
  vspacer.style.height = `${filtered.length * ROW_H}px`;
  const start = Math.max(0, Math.floor(vlist.scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(filtered.length, Math.ceil((vlist.scrollTop + vlist.clientHeight) / ROW_H) + OVERSCAN);
  const next = new Map();
  for (let i = start; i < end; i += 1) {
    const r = filtered[i];
    const el = rowEls.get(r.id) || makeRow(r);
    if (el.dataset.i !== String(i)) {
      el.dataset.i = i;
      el.style.top = `${i * ROW_H}px`;
    }
    el.classList.toggle('sel', r.id === selectedId);
    if (el.parentNode !== vspacer) vspacer.appendChild(el);
    next.set(r.id, el);
  }
  rowEls.forEach((el, id) => { if (!next.has(id)) el.remove(); });
  rowEls = next;
  renderMeta();
}

const schedulePaint = () => {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(paint);
};

function renderMeta() {
  const total = store?.records.length || 0;
  const count = filtered.length === total ? `${total} 条` : `${filtered.length} / ${total}`;
  $('#count').textContent = store?.paused ? `${count} · 已暂停` : count;
  const empty = $('#empty');
  empty.hidden = filtered.length > 0;
  if (!filtered.length) {
    empty.innerHTML = total
      ? `${icons.inbox}<b>没有匹配的请求</b><span>调整筛选条件或 Host 过滤规则</span>`
      : `${icons.inbox}<b>正在监听网络请求</b><span>刷新页面即可捕获首屏请求${store?.preserve === false ? '' : '，刷新后记录会保留'}</span>`;
  }
  const rule = config.hostFilter;
  $('#btn-settings').classList.toggle('active', rule.mode !== 'all' && rule.patterns.length > 0);
}

function refilter() {
  const stick = atBottom();
  filtered = store ? store.records.filter(passes) : [];
  paint();
  if (stick) vlist.scrollTop = filtered.length * ROW_H;
}

// ---------- 详情 ----------
const detail = createDetail(detailEl, { onClose: () => select(null), getExtracted: extract, getStore: () => store });

function select(id, { scroll = false } = {}) {
  selectedId = id;
  const rec = id == null ? null : store.records.find((r) => r.id === id);
  detailEl.hidden = !rec;
  $('#divider').hidden = !rec;
  if (rec) detail.show(rec);
  if (rec && scroll) {
    const top = filtered.indexOf(rec) * ROW_H;
    if (top < vlist.scrollTop) vlist.scrollTop = top;
    else if (top + ROW_H > vlist.scrollTop + vlist.clientHeight) vlist.scrollTop = top + ROW_H - vlist.clientHeight;
  }
  schedulePaint();
}

function move(delta) {
  if (!filtered.length) return;
  const cur = filtered.findIndex((r) => r.id === selectedId);
  const next = cur < 0 ? (delta > 0 ? 0 : filtered.length - 1) : Math.max(0, Math.min(filtered.length - 1, cur + delta));
  select(filtered[next].id, { scroll: true });
}

const recordAt = (target) => {
  const row = target.closest?.('.r');
  return row ? filtered[Number(row.dataset.i)] : null;
};

vlist.addEventListener('scroll', () => { hideTip(); schedulePaint(); });
vlist.addEventListener('click', (e) => {
  const rec = recordAt(e.target);
  if (!rec) return;
  if (qInput.value.trim()) filterHistory.commit();
  select(rec.id);
  vlist.focus({ preventScroll: true });
});

// ---------- 右键菜单 ----------
function hideHost(hostname) {
  const rule = config.hostFilter;
  const next = {
    ...config,
    hostFilter: { mode: 'exclude', patterns: [...new Set([...(rule.mode === 'exclude' ? rule.patterns : []), hostname])] },
  };
  applyConfig(next);
  saveConfig(next);
}

vlist.addEventListener('contextmenu', (e) => {
  const rec = recordAt(e.target);
  if (!rec) return;
  e.preventDefault();
  hideTip();
  const { hostname } = urlParts(rec);
  const found = extract(rec).filter((it) => it.value);
  openMenu([
    { label: '复制 cURL', hint: 'bash', run: () => copyWithToast(toCurl(rec), '已复制 cURL') },
    { label: '复制 URL', run: () => copyWithToast(rec.url, '已复制 URL') },
    ...found.map((it) => ({ label: `复制 ${it.name}`, run: () => copyWithToast(it.value, `已复制 ${it.name}`) })),
    '-',
    { label: '复制响应体', run: () => copyBody(rec) },
    { label: '复制请求体', disabled: !rec.reqBody, run: () => copyWithToast(rec.reqBody) },
    { label: '下载响应体', run: () => downloadBody(store, rec).catch((err) => toast(err.message)) },
    { label: '导出此请求', hint: 'HAR', run: () => exportRecords(store, [rec], 'har') },
    '-',
    { label: '只看此 Host', hint: hostname, run: () => setFilterText(hostname) },
    { label: '隐藏此 Host', disabled: config.hostFilter.mode === 'include', run: () => hideHost(hostname) },
  ], e.clientX, e.clientY);
});

async function copyBody(rec) {
  try {
    const content = await store.loadContent(rec);
    if (content.encoding === 'base64') toast('二进制内容，请使用「下载响应体」');
    else copyWithToast(content.text);
  } catch (err) {
    toast(err.message);
  }
}

// ---------- 悬停提示：方法 + 完整地址 ----------
let tipTimer = 0;
let tipRec = null;

function hideTip() {
  clearTimeout(tipTimer);
  tipRec = null;
  tip.hidden = true;
}

function showTip(rec, row) {
  tip.innerHTML = `<div class="tip-url"><b class="m-${esc(rec.method.toLowerCase())}">${esc(rec.method)}</b> ${esc(rec.url)}</div>`;
  tip.hidden = false;
  const r = row.getBoundingClientRect();
  const { height } = tip.getBoundingClientRect();
  const below = r.bottom + 6 + height < window.innerHeight;
  tip.style.top = `${below ? r.bottom + 6 : Math.max(4, r.top - height - 6)}px`;
  tip.style.left = `${Math.max(8, r.left + 8)}px`;
  tip.style.maxWidth = `${Math.max(240, Math.min(720, window.innerWidth - r.left - 24))}px`;
}

vlist.addEventListener('mouseover', (e) => {
  const rec = recordAt(e.target);
  if (rec === tipRec) return;
  hideTip();
  if (!rec) return;
  tipRec = rec;
  const row = e.target.closest('.r');
  tipTimer = setTimeout(() => { if (row.isConnected) showTip(rec, row); }, TIP_DELAY);
});
vlist.addEventListener('mouseleave', hideTip);

// ---------- 工具栏 ----------
const qInput = $('#q');
const filterHistory = attachHistory(qInput, { key: 'hist:filter', onPick: (v) => setFilterText(v) });
attachClear(qInput);

function setFilterText(text) {
  qInput.value = text;
  filter = { ...filter, tokens: parseTokens(text) };
  filterHistory.commit(text);
  refilter();
}

let qTimer = 0;
qInput.addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    filter = { ...filter, tokens: parseTokens(qInput.value) };
    refilter();
  }, 120);
});
qInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') filterHistory.commit();
});

createDropdown($('#method'), {
  options: [
    { value: 'ALL', label: '全部方法' }, ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })),
    { value: 'OTHER', label: '其他' },
  ],
  value: 'ALL',
  defaultValue: 'ALL',
  onChange: (method) => { filter = { ...filter, method }; refilter(); },
});
createDropdown($('#status'), {
  options: [
    { value: 'all', label: '全部状态' }, { value: 's2', label: '2xx 成功' }, { value: 's3', label: '3xx 重定向' },
    { value: 's4', label: '4xx 客户端错误' }, { value: 's5', label: '5xx 服务端错误' }, { value: 's0', label: '失败' },
  ],
  value: 'all',
  defaultValue: 'all',
  onChange: (status) => { filter = { ...filter, status }; refilter(); },
});
$('#btn-clear').addEventListener('click', () => store?.clear());

// 类型筛选：单击单选，⌘/Ctrl+单击多选（与 DevTools 一致）
// 类型按钮放不下时横向滚动：竖向滚轮转为横向，并在两侧显示渐隐提示
const typesEl = $('#types');
const updateTypesFade = () => {
  const { scrollLeft, scrollWidth, clientWidth } = typesEl;
  typesEl.classList.toggle('fade-l', scrollLeft > 1);
  typesEl.classList.toggle('fade-r', scrollLeft + clientWidth < scrollWidth - 1);
};
typesEl.addEventListener('wheel', (e) => {
  if (typesEl.scrollWidth <= typesEl.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.preventDefault();
  typesEl.scrollLeft += e.deltaY;
}, { passive: false });
typesEl.addEventListener('scroll', updateTypesFade);
new ResizeObserver(updateTypesFade).observe(typesEl);

function renderTypes() {
  $('#types').querySelectorAll('button').forEach((b) => b.classList.toggle('on', filter.types.has(b.dataset.v)));
}
$('#types').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  let next = new Set([v]);
  if ((e.metaKey || e.ctrlKey) && v !== 'all') {
    const base = [...filter.types].filter((t) => t !== 'all');
    next = new Set(base.includes(v) ? base.filter((t) => t !== v) : [...base, v]);
    if (!next.size) next = new Set(['all']);
  }
  filter = { ...filter, types: next };
  renderTypes();
  e.target.closest('button').scrollIntoView({ block: 'nearest', inline: 'nearest' });
  settings.set('typeFilter', [...next]);
  refilter();
});

// ---------- 暂停 / 导出 ----------
function renderPause() {
  const paused = !!store?.paused;
  const btn = $('#btn-pause');
  btn.innerHTML = paused ? icons.play : icons.pause;
  btn.dataset.tip = paused ? `继续记录（${MOD}E）` : `暂停记录（${MOD}E，暂停期间的请求不会被记录）`;
  btn.classList.toggle('paused', paused);
  document.body.classList.toggle('is-paused', paused);
}
$('#btn-pause').addEventListener('click', () => store?.setPaused(!store.paused));

const renderPreserve = () => { $('#preserve').checked = store?.preserve !== false; };
$('#preserve').addEventListener('change', (e) => {
  store?.setPreserve(e.target.checked);
  settings.set('preserveLog', e.target.checked);
});

$('#btn-export').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const all = store?.records || [];
  const selected = all.find((x) => x.id === selectedId);
  openMenu([
    { label: '导出当前列表为 HAR', hint: `${filtered.length} 条`, disabled: !filtered.length, run: () => exportRecords(store, [...filtered], 'har') },
    { label: '导出当前列表为 JSON', hint: `${filtered.length} 条`, disabled: !filtered.length, run: () => exportRecords(store, [...filtered], 'json') },
    '-',
    { label: '导出选中请求为 HAR', disabled: !selected, run: () => exportRecords(store, [selected], 'har') },
    { label: '导出选中请求为 JSON', disabled: !selected, run: () => exportRecords(store, [selected], 'json') },
  ], r.right - 220, r.bottom + 4);
});

function applyConfig(next) {
  config = next;
  configVer += 1;
  hostOk = compileRule(config.hostFilter);
  refilter();
  detail.refreshExtracted();
}

const settingsUi = createSettings($('#settings'), { onSave: applyConfig });
$('#btn-settings').addEventListener('click', () => settingsUi.open(config));

// ---------- 快捷键 ----------
const IS_MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
$('#btn-clear').title = `清空全部记录（${IS_MAC ? '⌘K' : 'Ctrl+L'}）`;
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
// 与 Chrome 网络面板一致：清空 ⌘K / Ctrl+L，暂停 / 继续记录 ⌘E / Ctrl+E，搜索 ⌘F / Ctrl+F
const modShortcuts = {
  [IS_MAC ? 'k' : 'l']: () => store?.clear(),
  e: () => store?.setPaused(!store.paused),
  f: () => (selectedId != null ? detail.focusSearch() : qInput.focus()),
};
// DevTools 会在面板页的 document 上监听 keydown，把带 ⌘/Ctrl 的按键转发给自己（⌘F 会弹出 DevTools 的查找栏）。
// 在 window 捕获阶段先处理并截断传播，转发脚本就收不到
window.addEventListener('keydown', (e) => {
  const run = (IS_MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && modShortcuts[e.key.toLowerCase()];
  if (!run) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  run();
}, true);
document.addEventListener('keydown', (e) => {
  if (!$('#settings').hidden || typing(document.activeElement)) {
    if (e.key === 'Escape' && document.activeElement === qInput) qInput.blur();
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    qInput.focus();
  } else if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Escape' && selectedId != null) {
    select(null);
  }
});

// ---------- 分栏：宽时左右，窄时上下；拖动分隔条调整 ----------
let dir = 'row';
let sizes = { row: 0.42, col: 0.4 };

const applySize = () => {
  split.dataset.dir = dir;
  split.style.setProperty('--list-size', `${(sizes[dir] * 100).toFixed(2)}%`);
};

new ResizeObserver(([entry]) => {
  const next = entry.contentRect.width >= 760 ? 'row' : 'col';
  if (next !== dir) {
    dir = next;
    applySize();
  }
  schedulePaint();
}).observe(split);

$('#divider').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const divider = e.currentTarget;
  divider.setPointerCapture(e.pointerId);
  const rect = split.getBoundingClientRect();
  const onMove = (ev) => {
    const ratio = dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
    sizes = { ...sizes, [dir]: Math.max(0.15, Math.min(0.85, ratio)) };
    applySize();
    schedulePaint();
  };
  const onUp = () => {
    divider.removeEventListener('pointermove', onMove);
    divider.removeEventListener('pointerup', onUp);
    settings.set('splitSizes', sizes);
  };
  divider.addEventListener('pointermove', onMove);
  divider.addEventListener('pointerup', onUp);
});

// ---------- 接入 DevTools 侧的数据 ----------
function onStoreEvent(ev) {
  if (ev.type === 'preserve') return renderPreserve();
  if (ev.type === 'pause') {
    renderPause();
    renderMeta();
    return;
  }
  if (ev.type === 'clear') {
    filtered = [];
    select(null);
    paint();
    return;
  }
  if (ev.type === 'evict') {
    const i = filtered.indexOf(ev.record);
    if (i < 0) return schedulePaint();
    filtered.splice(i, 1);
    // 删掉视口上方的行时同步上移，保持当前看到的内容不跳动
    if (i * ROW_H < vlist.scrollTop) vlist.scrollTop -= ROW_H;
    return schedulePaint();
  }
  if (!passes(ev.record)) return schedulePaint();
  const stick = atBottom();
  filtered.splice(insertIndex(filtered, ev.record.startTime), 0, ev.record);
  if (stick) {
    vspacer.style.height = `${filtered.length * ROW_H}px`;
    vlist.scrollTop = filtered.length * ROW_H;
  }
  schedulePaint();
}

async function attach(s) {
  if (store) return;
  store = s;
  const [savedConfig, savedSizes, savedTypes] = await Promise.all([
    loadConfig(), settings.get('splitSizes', null), settings.get('typeFilter', DEFAULT_TYPES),
  ]);
  filter = { ...filter, types: new Set(savedTypes.length ? savedTypes : DEFAULT_TYPES) };
  renderTypes();
  config = savedConfig;
  configVer += 1;
  hostOk = compileRule(config.hostFilter);
  sizes = { ...sizes, ...savedSizes };
  applySize();
  renderPause();
  renderPreserve();
  const unsubscribe = store.subscribe(onStoreEvent);
  window.addEventListener('unload', unsubscribe);
  refilter();
}

window.__jniAttach = attach;
if (window.__jniStore) attach(window.__jniStore);
renderMeta();
