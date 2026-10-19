export const $ = (sel, root = document) => root.querySelector(sel);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

// 把 text 中所有不区分大小写的 query 命中包成 <mark>
export function highlight(text, query) {
  const s = String(text);
  if (!query) return esc(s);
  const lower = s.toLowerCase();
  const q = query.toLowerCase();
  let out = '';
  let from = 0;
  let at = lower.indexOf(q);
  while (at !== -1) {
    out += `${esc(s.slice(from, at))}<mark>${esc(s.slice(at, at + q.length))}</mark>`;
    from = at + q.length;
    at = lower.indexOf(q, from);
  }
  return out + esc(s.slice(from));
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
export const fmtTime = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};
export const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtTime(ms)}`;
};
export const fmtDuration = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
export const fmtSize = (n) => {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

export const splitUrl = (url) => {
  try {
    const u = new URL(url);
    return { host: u.host, hostname: u.hostname, path: `${u.pathname}${u.search}` };
  } catch {
    return { host: '', hostname: '', path: url };
  }
};

// MIME 子类型简写，用于类型列与详情元信息
const MIME_SHORT = {
  javascript: 'js', 'x-javascript': 'js', ecmascript: 'js', 'svg+xml': 'svg', 'octet-stream': 'bin',
  plain: 'text', 'x-www-form-urlencoded': 'form', 'event-stream': 'sse', 'vnd.apple.mpegurl': 'm3u8',
};
export const typeLabel = (r) => {
  const mime = r.mime.split(';')[0].trim().toLowerCase();
  if (!mime) return r.resourceType;
  const sub = mime.split('/')[1] || mime;
  return MIME_SHORT[sub] || sub.replace(/^x-/, '').replace(/^.*\+json$/, 'json').slice(0, 12);
};

export const statusClass = (s) => (s >= 500 ? 's5' : s >= 400 ? 's4' : s >= 300 ? 's3' : s >= 200 ? 's2' : 's0');

// DevTools 面板里 navigator.clipboard 常因焦点 / 权限失败，优先走 execCommand
export async function copyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (ok) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// 给文本输入框加清除按钮：有内容时显示（依赖 placeholder 判断），点击清空并触发 input 事件
export function attachClear(input, onClear) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'clear-x';
  btn.tabIndex = -1;
  btn.title = '清空';
  btn.innerHTML = icons.close;
  btn.addEventListener('pointerdown', (e) => e.preventDefault()); // 不抢输入框焦点
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    onClear?.();
    input.focus();
  });
  if (!input.placeholder) input.placeholder = ' ';
  input.after(btn);
  return btn;
}

let toastTimer = 0;
export function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

export async function copyWithToast(text, label = '已复制') {
  toast((await copyText(text)) ? label : '复制失败');
}

// 本地设置：优先 chrome.storage.local，不可用时退回 localStorage
export const settings = {
  async get(key, fallback) {
    try {
      if (chrome?.storage?.local) {
        const res = await chrome.storage.local.get(key);
        return res[key] ?? fallback;
      }
    } catch { /* 走 localStorage */ }
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  async set(key, value) {
    try {
      if (chrome?.storage?.local) return await chrome.storage.local.set({ [key]: value });
    } catch { /* 走 localStorage */ }
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 忽略 */ }
  },
};

const svg = (d, extra = '') => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
export const icons = {
  search: svg('<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3 3"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.25c.05.7.6 1.25 1.3 1.25h3.2c.7 0 1.25-.55 1.3-1.25l.6-8.25"/>'),
  gear: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
  pause: svg('<path d="M5.75 3.5v9M10.25 3.5v9"/>', 'stroke-width="2"'),
  play: svg('<path d="M5 3.25v9.5l7.5-4.75z" fill="currentColor"/>'),
  download: svg('<path d="M8 2.5v8M4.75 7.5 8 10.75l3.25-3.25M3 13.25h10"/>'),
  check: svg('<path d="m3.5 8.5 3 3 6-7"/>'),
  enter: svg('<path d="M12.5 3.5v4a2 2 0 0 1-2 2h-7M6 6.5l-3 3 3 3"/>'),
  clock: svg('<circle cx="8" cy="8" r="5.75"/><path d="M8 5v3l2 1.25"/>'),
  timer: svg('<circle cx="8" cy="9" r="5"/><path d="M8 9V6.5M6.5 2.25h3M12.25 4.75l-.75.75"/>'),
  box: svg('<path d="M2.75 5 8 2.25 13.25 5v6L8 13.75 2.75 11z"/><path d="M2.75 5 8 7.75 13.25 5M8 7.75v6"/>'),
  file: svg('<path d="M4 2.25h5l3 3v8.5H4z"/><path d="M9 2.25v3h3"/>'),
  terminal: svg('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3"/>'),
  fx: svg('<path d="M9.5 2.75c-1.5 0-2 .75-2.25 2l-1.5 7c-.25 1.25-.75 2-2.25 2M4.5 6.5h5M10 8.5l3 4M13 8.5l-3 4"/>'),
  close: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  copy: svg('<rect x="5.25" y="5.25" width="8" height="8" rx="1.5"/><path d="M10.75 5.25V3.5c0-.7-.55-1.25-1.25-1.25h-6c-.7 0-1.25.55-1.25 1.25v6c0 .7.55 1.25 1.25 1.25h1.75"/>'),
  up: svg('<path d="m4 10 4-4 4 4"/>'),
  down: svg('<path d="m4 6 4 4 4-4"/>'),
  expand: svg('<path d="M5 6.5 8 3.5l3 3M5 9.5l3 3 3-3"/>'),
  collapse: svg('<path d="M5 3.5l3 3 3-3M5 12.5l3-3 3 3"/>'),
  code: svg('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
  tree: svg('<path d="M3 3h4M5 3v9.5h4M5 8h4"/><circle cx="11" cy="8" r="1.25"/><circle cx="11" cy="12.5" r="1.25"/>'),
  filter: svg('<path d="M2.5 3.5h11l-4.25 5v4l-2.5 1.25V8.5z"/>'),
  inbox: svg('<path d="M2 9.5 4 3.5h8l2 6M2 9.5v3h12v-3M2 9.5h3.5l1 1.5h3l1-1.5H14"/>', 'width="28" height="28" stroke-width="1.1"'),
};
