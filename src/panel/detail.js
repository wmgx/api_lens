import { $, esc, icons, fmtDate, fmtTime, fmtDuration, fmtSize, statusClass, copyWithToast, settings, toast, typeLabel } from './util.js';
import { createJsonView } from './jsonView.js';
import { toCurl } from './curl.js';
import { contentBlob, downloadBody, fileNameFor } from './exporter.js';

const TABS = ['res', 'req', 'headers'];

const headerRows = (pairs, hl) => pairs.map(([k, v]) => `
  <div class="kv${hl.has(k.toLowerCase()) ? ' hl' : ''}"><span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(v)}</span></div>`).join('');

const section = (id, title, pairs, hl = new Set()) => `
  <details class="sec" open data-sec="${id}">
    <summary><span class="sec-title">${title}</span><span class="sec-n">${pairs.length}</span>
      <button type="button" class="icon sm" data-copy-sec="${id}" title="复制本组全部">${icons.copy}</button></summary>
    <div class="sec-body">${pairs.length ? headerRows(pairs, hl) : '<div class="kv-empty">无</div>'}</div>
  </details>`;

const generalPairs = (r) => [
  ['Request URL', r.url],
  ['Request Method', r.method],
  ['Status Code', `${r.status || '(failed)'} ${r.statusText}`.trim()],
  ['Type', r.resourceType],
  ['Content-Type', r.mime],
  ['Started', fmtDate(r.startTime)],
  ['Duration', fmtDuration(r.duration)],
  ['Size', fmtSize(r.size)],
];

// 自动提取的 Header：找到的逐行展示并可复制，缺失的合并成一行
const extractHtml = (items) => {
  const found = items.filter((it) => it.value);
  const missing = items.filter((it) => !it.value).map((it) => it.name);
  return found.map((it, i) => `
    <div class="ex-row">
      <span class="ex-name">${esc(it.name)}</span>
      <code class="ex-val" title="${esc(it.value)}">${esc(it.value)}</code>
      <button type="button" class="ex-copy" data-ex="${i}">${icons.copy}<span>复制</span></button>
    </div>`).join('')
    + (missing.length ? `<div class="ex-missing">未返回：${missing.map(esc).join('、')}</div>` : '');
};

const isImage = (mime) => /^image\//i.test(mime);

// 元信息标签：图标 + 值，悬停显示完整说明
const metaItem = (icon, text, tip, cls = '') => `<span class="mi${cls ? ` ${cls}` : ''}" data-tip="${esc(tip)}">${icon}<span>${esc(text)}</span></span>`;
const isToday = (ms) => new Date(ms).toDateString() === new Date().toDateString();
const speedClass = (ms) => (ms >= 1000 ? 'slow' : ms < 300 ? 'fast' : '');
const metaHtml = (r) => [
  metaItem(icons.clock, isToday(r.startTime) ? fmtTime(r.startTime) : fmtDate(r.startTime), `开始时间 ${fmtDate(r.startTime)}`),
  metaItem(icons.timer, fmtDuration(r.duration), '耗时', speedClass(r.duration)),
  r.size >= 0 && metaItem(icons.box, fmtSize(r.size),
    r.transferSize > 0 ? `响应大小 ${fmtSize(r.size)} · 传输 ${fmtSize(r.transferSize)}` : '响应大小'),
  metaItem(icons.file, typeLabel(r) === r.resourceType ? r.resourceType : `${r.resourceType} · ${typeLabel(r)}`, `类型 ${r.resourceType}${r.mime ? ` · ${r.mime}` : ''}`),
].filter(Boolean).join('');

export function createDetail(root, { onClose, getExtracted, getStore }) {
  root.innerHTML = `
    <header class="d-head">
      <div class="d-title">
        <span class="badge-m"></span><span class="badge-s"></span>
        <span class="d-url"></span>
        <button type="button" class="icon" data-act="copy-curl" title="复制为 cURL 命令">${icons.terminal}</button>
        <button type="button" class="icon" data-act="download" title="下载响应体">${icons.download}</button>
        <button type="button" class="icon" data-act="copy-url" title="复制 URL">${icons.copy}</button>
        <button type="button" class="icon" data-act="close" title="关闭详情 (Esc)">${icons.close}</button>
      </div>
      <div class="d-meta"></div>
      <div class="d-extract"></div>
    </header>
    <nav class="tabs" role="tablist">
      <button type="button" data-tab="res">响应</button>
      <button type="button" data-tab="req">请求</button>
      <button type="button" data-tab="headers">Headers</button>
    </nav>
    <div class="d-pane" data-pane="res"><div class="d-media" hidden></div><div class="jv-host" data-jv="res"></div></div>
    <div class="d-pane" data-pane="req"><div class="d-query"></div><div class="jv-host" data-jv="req"></div></div>
    <div class="d-pane d-scroll" data-pane="headers"></div>`;

  const jvResHost = $('[data-jv="res"]', root);
  const media = $('.d-media', root);
  const jvRes = createJsonView(jvResHost);
  const jvReq = createJsonView($('[data-jv="req"]', root));
  let current = null;
  let extracted = [];
  let tab = 'res';
  let loadSeq = 0;
  let objectUrl = '';

  const setTab = (next) => {
    tab = TABS.includes(next) ? next : 'res';
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    root.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  };
  settings.get('detailTab', 'res').then(setTab);

  const sectionPairs = (id) => ({
    general: () => generalPairs(current),
    res: () => current.resHeaders,
    req: () => current.reqHeaders,
    query: () => current.query,
  }[id]?.() || []);

  const download = () => downloadBody(getStore(), current).catch((err) => toast(err.message));

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !current) return;
    const { act, tab: tabName, copySec, ex } = btn.dataset;
    if (tabName) {
      setTab(tabName);
      settings.set('detailTab', tab);
    } else if (act === 'close') onClose();
    else if (act === 'copy-url') copyWithToast(current.url, '已复制 URL');
    else if (act === 'copy-curl') copyWithToast(toCurl(current), '已复制 cURL');
    else if (act === 'download') download();
    else if (ex != null) {
      const it = extracted.filter((x) => x.value)[Number(ex)];
      copyWithToast(it.value, `已复制 ${it.name}`);
    } else if (copySec) {
      e.preventDefault();
      copyWithToast(sectionPairs(copySec).map(([k, v]) => `${k}: ${v}`).join('\n'));
    }
  });

  function renderHeaders() {
    const hl = new Set(extracted.map((it) => it.name));
    const box = $('.d-extract', root);
    box.hidden = !extracted.length;
    box.innerHTML = extractHtml(extracted);
    $('[data-pane="headers"]', root).innerHTML = section('general', '概要', generalPairs(current))
      + section('res', '响应 Headers', current.resHeaders, hl)
      + section('req', '请求 Headers', current.reqHeaders, hl);
  }

  // 响应体：JSON / 文本走查看器，图片预览，其他二进制提供下载
  const showMedia = (html) => {
    media.hidden = false;
    jvResHost.hidden = true;
    media.innerHTML = html;
  };

  function renderResponse(r, content) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
    if (isImage(r.mime)) {
      objectUrl = URL.createObjectURL(contentBlob(content, r.mime));
      showMedia(`<figure class="d-img">
          <div class="d-img-box"><img src="${objectUrl}" alt=""></div>
          <figcaption><span class="d-img-dim"></span><span>${esc(r.mime)}</span><span>${fmtSize(r.size)}</span>
            <button type="button" class="btn" data-act="download">${icons.download}下载</button></figcaption>
        </figure>`);
      const img = $('img', media);
      img.addEventListener('load', () => { $('.d-img-dim', media).textContent = `${img.naturalWidth} × ${img.naturalHeight}`; }, { once: true });
      return;
    }
    if (content.encoding === 'base64') {
      showMedia(`<div class="d-file">
          <div class="d-file-icon">${icons.download}</div>
          <b>${esc(fileNameFor(r))}</b>
          <span>${esc(r.mime || 'application/octet-stream')} · ${fmtSize(r.size)}</span>
          <button type="button" class="btn primary" data-act="download">${icons.download}下载文件</button>
        </div>`);
      return;
    }
    media.hidden = true;
    jvResHost.hidden = false;
    jvRes.set(content.text, { emptyText: '响应体为空' });
  }

  function loadResponse(r) {
    loadSeq += 1;
    const token = loadSeq;
    showMedia('<div class="d-note">加载中…</div>');
    getStore().loadContent(r).then((content) => {
      if (token === loadSeq) renderResponse(r, content);
    }, (err) => {
      if (token !== loadSeq) return;
      showMedia(`<div class="d-note">${r.status === 0 ? '请求失败，没有响应体' : esc(err.message)}</div>`);
    });
  }

  return {
    show(r) {
      current = r;
      extracted = getExtracted(r);
      $('.badge-m', root).textContent = r.method;
      $('.badge-m', root).className = `badge-m m-${r.method.toLowerCase()}`;
      $('.badge-s', root).textContent = r.status || '失败';
      $('.badge-s', root).className = `badge-s ${statusClass(r.status)}`;
      $('.d-url', root).textContent = r.url;
      $('.d-url', root).dataset.tip = r.url;
      $('.d-meta', root).innerHTML = metaHtml(r);
      loadResponse(r);
      jvReq.set(r.reqBody, { emptyText: '无请求体' });
      $('.d-query', root).innerHTML = r.query.length ? section('query', 'Query 参数', r.query) : '';
      renderHeaders();
    },
    // 提取配置变化时刷新当前详情
    refreshExtracted() {
      if (!current) return;
      extracted = getExtracted(current);
      renderHeaders();
    },
    focusSearch() {
      if (tab === 'headers') setTab('res');
      (tab === 'req' ? jvReq : jvRes).focusSearch();
    },
  };
}
