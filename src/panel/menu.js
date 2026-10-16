import { esc, icons } from './util.js';

// 通用菜单（右键菜单 / 下拉框共用）：items 为 { label, hint?, run, disabled?, checked? } 或 '-' 分隔线
let current = null;

export function closeMenu() {
  current?.el.remove();
  current?.onClose?.();
  current = null;
}

export function openMenu(items, x, y, { minWidth = 0, onClose } = {}) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  const list = items.filter(Boolean);
  const checkable = list.some((it) => it !== '-' && it.checked !== undefined);
  const actions = [];
  el.innerHTML = list.map((it) => {
    if (it === '-') return '<div class="menu-sep"></div>';
    actions.push(it);
    const check = checkable ? `<span class="menu-check">${it.checked ? icons.check : ''}</span>` : '';
    return `<button type="button" role="menuitem" data-i="${actions.length - 1}"${it.disabled ? ' disabled' : ''}>
      ${check}<span class="menu-label">${esc(it.label)}</span>${it.hint ? `<span class="menu-hint">${esc(it.hint)}</span>` : ''}</button>`;
  }).join('');
  el.style.minWidth = `${Math.max(180, minWidth)}px`;
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    closeMenu();
    actions[Number(btn.dataset.i)].run();
  });
  document.body.appendChild(el);
  const { innerWidth: vw, innerHeight: vh } = window;
  const { width, height } = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, vw - width - 4))}px`;
  el.style.top = `${Math.max(4, y + height > vh - 4 ? y - height : y)}px`;
  current = { el, onClose };
  // 聚焦当前选中项（或第一项），支持键盘操作
  const focusIdx = Math.max(0, actions.findIndex((it) => it.checked));
  el.querySelector(`button[data-i="${focusIdx}"]`)?.focus({ preventScroll: true });
}

const moveFocus = (delta) => {
  const buttons = [...current.el.querySelectorAll('button:not(:disabled)')];
  if (!buttons.length) return;
  const i = buttons.indexOf(document.activeElement);
  buttons[(i + delta + buttons.length) % buttons.length].focus();
};

// 记录触发关闭的元素：点下拉按钮关闭菜单时，随后的 click 不应再次打开
let closedBy = null;
document.addEventListener('pointerdown', (e) => {
  if (!current) {
    closedBy = null;
    return;
  }
  if (current.el.contains(e.target)) return;
  closedBy = e.target;
  closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (!current) return;
  if (e.key === 'Escape') closeMenu();
  else if (e.key === 'ArrowDown') moveFocus(1);
  else if (e.key === 'ArrowUp') moveFocus(-1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}, true);
window.addEventListener('blur', () => closeMenu());
window.addEventListener('resize', () => closeMenu());
// 只在用户主动滚动时关闭；新记录到达引起的自动滚动不应打断菜单
document.addEventListener('wheel', (e) => { if (current && !current.el.contains(e.target)) closeMenu(); }, { capture: true, passive: true });

// 自定义下拉框：替代原生 <select>，样式与面板一致
export function createDropdown(button, { options, value, defaultValue, onChange }) {
  let selected = value;
  const render = () => {
    const opt = options.find((o) => o.value === selected) || options[0];
    button.innerHTML = `<span>${esc(opt.label)}</span>${icons.down}`;
    button.classList.toggle('set', selected !== defaultValue);
  };
  button.classList.add('dd');
  button.setAttribute('aria-haspopup', 'menu');
  button.addEventListener('click', () => {
    if (closedBy && button.contains(closedBy)) {
      closedBy = null;
      return;
    }
    const r = button.getBoundingClientRect();
    button.classList.add('open');
    openMenu(options.map((o) => ({
      label: o.label,
      checked: o.value === selected,
      run: () => {
        selected = o.value;
        render();
        onChange(selected);
      },
    })), r.left, r.bottom + 4, { minWidth: r.width, onClose: () => button.classList.remove('open') });
  });
  render();
  return { get value() { return selected; } };
}
