// 统一的悬停提示：接管带 title / data-tip 的元素。DevTools 面板里原生 title 出现慢且不明显。
const DELAY = 350;
const tip = document.createElement('div');
tip.className = 'hint-tip';
tip.hidden = true;
document.body.appendChild(tip);

let timer = 0;
let target = null;

function hide() {
  clearTimeout(timer);
  target = null;
  tip.hidden = true;
}

function show(el) {
  if (!el.isConnected || !el.dataset.tip) return;
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const { width, height } = tip.getBoundingClientRect();
  const below = r.bottom + 6 + height <= window.innerHeight - 4;
  tip.style.top = `${below ? r.bottom + 6 : Math.max(4, r.top - height - 6)}px`;
  tip.style.left = `${Math.max(4, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 4))}px`;
}

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('[title], [data-tip]');
  if (el === target) return;
  hide();
  if (!el || el.closest('#vlist')) return;
  // 转存为 data-tip，避免和原生 title 提示重复出现
  if (el.hasAttribute('title')) {
    if (el.title) el.dataset.tip = el.title;
    el.removeAttribute('title');
  }
  target = el;
  timer = setTimeout(() => show(el), DELAY);
});
document.addEventListener('pointerdown', hide, true);
document.addEventListener('wheel', hide, { capture: true, passive: true });
window.addEventListener('blur', hide);
