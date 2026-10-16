import { esc, icons, settings } from './util.js';

const MAX_ITEMS = 10;
const SHOW_ITEMS = 10;

const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

// 为输入框挂载历史下拉：按最近使用排序，输入时模糊匹配，可逐条删除。
// 需在输入框自身的 keydown 监听之前调用，以便优先处理上下键 / 回车。
export function attachHistory(input, { key, onPick }) {
  let items = [];
  let shown = [];
  let active = -1;
  const loaded = settings.get(key, []).then((v) => { items = Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []; });

  const box = document.createElement('div');
  box.className = 'hist';
  box.hidden = true;
  document.body.appendChild(box);

  const save = () => settings.set(key, items);

  const place = () => {
    const r = input.closest('label')?.getBoundingClientRect() || input.getBoundingClientRect();
    box.style.left = `${r.left}px`;
    box.style.top = `${r.bottom + 4}px`;
    box.style.width = `${Math.max(r.width, 240)}px`;
  };

  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((it) => it.v.toLowerCase() !== q && (!q || it.v.toLowerCase().includes(q))).slice(0, SHOW_ITEMS);
    active = Math.min(active, shown.length - 1);
    if (!shown.length || document.activeElement !== input) {
      box.hidden = true;
      return;
    }
    box.innerHTML = `<div class="hist-title">最近使用</div>${shown.map((it, i) => `
      <div class="hist-item${i === active ? ' on' : ''}" data-i="${i}">
        <span class="hist-v">${esc(it.v)}</span><span class="hist-t">${ago(it.t)}</span>
        <button type="button" class="hist-del" data-del="${i}" title="删除">${icons.close}</button>
      </div>`).join('')}`;
    place();
    box.hidden = false;
  };

  const pick = (i) => {
    const it = shown[i];
    if (!it) return;
    input.value = it.v;
    box.hidden = true;
    onPick(it.v);
  };

  box.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // 保持输入框焦点
    const del = e.target.closest('[data-del]');
    if (del) {
      const target = shown[Number(del.dataset.del)];
      items = items.filter((it) => it !== target);
      save();
      render();
      return;
    }
    const row = e.target.closest('.hist-item');
    if (row) pick(Number(row.dataset.i));
  });

  input.addEventListener('focus', () => { loaded.then(render); });
  input.addEventListener('input', () => { active = -1; render(); });
  input.addEventListener('blur', () => { box.hidden = true; });
  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const n = shown.length;
      active = e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n;
      render();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(active);
    } else if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      box.hidden = true;
    }
  });

  return {
    async commit(value) {
      const v = (value ?? input.value).trim();
      if (!v) return;
      await loaded;
      items = [{ v, t: Date.now() }, ...items.filter((it) => it.v !== v)].slice(0, MAX_ITEMS);
      save();
    },
    hide() { box.hidden = true; },
  };
}
