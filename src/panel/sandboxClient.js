// 与沙箱 iframe 通信，执行 $.path / JS 表达式
const TIMEOUT = 5000;
let frame = null;
let ready = null;
let seq = 0;
const pending = new Map();

function init() {
  frame = document.createElement('iframe');
  frame.src = '../sandbox/sandbox.html';
  frame.hidden = true;
  ready = new Promise((resolve) => { frame.addEventListener('load', resolve, { once: true }); });
  document.body.appendChild(frame);
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    const p = pending.get(e.data?.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data);
    else p.reject(new Error(e.data.error));
  });
}

export async function evaluate(text, expr) {
  if (!frame) init();
  await ready;
  seq += 1;
  const id = seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    frame.contentWindow.postMessage({ id, text, expr }, '*');
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error('执行超时'));
    }, TIMEOUT);
  });
}
