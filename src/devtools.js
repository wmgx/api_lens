// DevTools 打开即运行：持续收集当前标签页的所有网络请求（默认刷新后继续追加，可关闭「保留日志」），面板展示时再接入。
// Fetch/XHR 的文本响应在完成时立即读取；其他资源（图片、脚本、下载等）在查看时按需读取，避免占用大量内存。

// 最先注册面板：DevTools 打开时恢复上次选中的面板，扩展面板注册得越晚越容易错过而落到相邻面板
// 面板首次显示时才加载，两边都做一次握手，谁先就绪都能接上；回调触发时 store 早已初始化
chrome.devtools.panels.create('API Lens', 'icons/16.png', 'src/panel/panel.html', (panel) => {
  panel.onShown.addListener((win) => {
    win.__jniStore = store;
    win.__jniAttach?.(store);
  });
});

const EAGER_MAX = 5 * 1024 * 1024;
const TEXT_MIME = /json|text|javascript|xml|html|css|urlencoded|graphql/i;
const JSON_MIME = /json/i;
// 长时间开着 DevTools（如轮询页面）时防止内存无限增长，超出后淘汰最早的记录
const MAX_RECORDS = 5000;

const CATEGORY = {
  xhr: 'fetch', fetch: 'fetch', eventsource: 'fetch',
  document: 'doc', script: 'js', stylesheet: 'css', image: 'img',
  media: 'media', font: 'font',
};

let seq = 0;

function createStore(loadContent) {
  let records = [];
  let paused = false;
  let preserve = true;
  let generation = 0; // 每次清空 +1，用于丢弃清空前开始读取、清空后才完成的记录
  const subscribers = new Set();
  const notify = (event) => subscribers.forEach((fn) => fn(event));

  // 按请求开始时间升序插入；绝大多数情况是追加到末尾
  const indexFor = (time) => {
    let lo = 0;
    let hi = records.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (records[mid].startTime <= time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return {
    get records() { return records; },
    get paused() { return paused; },
    get preserve() { return preserve; },
    get generation() { return generation; },
    setPreserve(value) {
      preserve = !!value;
      notify({ type: 'preserve', preserve });
    },
    setPaused(value) {
      paused = !!value;
      notify({ type: 'pause', paused });
    },
    add(record) {
      const index = indexFor(record.startTime);
      // 这里有意原地插入，避免每条请求都复制整个数组
      records.splice(index, 0, record);
      notify({ type: 'add', record, index });
      if (records.length > MAX_RECORDS) notify({ type: 'evict', record: records.shift() });
    },
    clear() {
      records = [];
      generation += 1;
      notify({ type: 'clear' });
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    // 返回 { text, encoding }，encoding 为 'base64' 表示二进制内容
    loadContent,
  };
}

const entries = new WeakMap(); // record -> HAR entry
const contents = new WeakMap(); // record -> Promise<{ text, encoding }>

const readContent = (entry) => new Promise((resolve, reject) => {
  entry.getContent((content, encoding) => {
    if (content == null) reject(new Error('内容不可用（可能已随页面跳转释放）'));
    else resolve({ text: content, encoding: encoding === 'base64' ? 'base64' : '' });
  });
});

// base64 的文本内容转成字符串，便于直接展示和搜索
const normalizeContent = ({ text, encoding }, mime) => {
  if (encoding !== 'base64' || !TEXT_MIME.test(mime)) return { text, encoding };
  try {
    const bin = atob(text);
    return { text: new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))), encoding: '' };
  } catch {
    return { text, encoding };
  }
};

const looksLikeJson = (text) => {
  const t = text.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return false;
  try { JSON.parse(text); return true; } catch { return false; }
};

function loadContent(record) {
  if (!contents.has(record)) {
    const entry = entries.get(record);
    const p = entry ? readContent(entry).then((c) => normalizeContent(c, record.mime)) : Promise.reject(new Error('内容不可用'));
    contents.set(record, p);
    p.catch(() => contents.delete(record)); // 失败允许重试
  }
  return contents.get(record);
}

const store = createStore(loadContent);

// 扩展用 webRequest 把请求重定向到 data: URL 来 mock 时，DevTools 只上报一条 307 Internal Redirect，
// 响应体藏在 Location 里；后续的 data: 跳转记录不带原 URL，没有查看价值
const DATA_URL = /^data:([^,]*),(.*)$/s;
const mockTargets = new Set();

function parseDataUrl(url) {
  const m = DATA_URL.exec(url);
  if (!m) return null;
  const params = m[1].split(';');
  const base64 = params.at(-1).toLowerCase() === 'base64';
  const mime = params.slice(0, base64 ? -1 : undefined).join(';') || 'text/plain';
  try {
    const raw = decodeURIComponent(m[2]);
    const content = base64 ? { text: raw.replace(/\s/g, ''), encoding: 'base64' } : { text: raw, encoding: '' };
    const size = base64 ? atob(content.text).length : new TextEncoder().encode(raw).length;
    return { mime, size, content: normalizeContent(content, mime) };
  } catch {
    return null;
  }
}

function applyMock(record) {
  if (record.status < 300 || record.status >= 400) return;
  const location = record.resHeaders.find(([k]) => k.toLowerCase() === 'location')?.[1] || '';
  const mock = location.startsWith('data:') && parseDataUrl(location);
  if (!mock) return;
  if (mockTargets.size > 100) mockTargets.clear();
  mockTargets.add(location);
  Object.assign(record, { mime: mock.mime, json: JSON_MIME.test(mock.mime), size: mock.size });
  contents.set(record, Promise.resolve(mock.content));
}

const toPairs = (headers = []) => headers.map((h) => [h.name, h.value]);

function toRecord(entry) {
  const { request, response } = entry;
  const postData = request.postData;
  seq += 1;
  return {
    id: seq,
    method: request.method,
    url: request.url,
    status: response.status,
    statusText: response.statusText || entry._error || '',
    startTime: new Date(entry.startedDateTime).getTime(),
    duration: Math.max(0, Math.round(entry.time || 0)),
    resourceType: entry._resourceType || 'other',
    category: CATEGORY[entry._resourceType] || 'other',
    mime: response.content?.mimeType || '',
    json: JSON_MIME.test(response.content?.mimeType || ''),
    reqHeaders: toPairs(request.headers),
    reqBody: postData?.text ?? null,
    reqMime: postData?.mimeType || '',
    reqParams: (postData?.params || []).map((p) => ({
      name: p.name, value: p.value ?? '', fileName: p.fileName || '', contentType: p.contentType || '',
    })),
    query: (request.queryString || []).map((q) => [q.name, q.value]),
    resHeaders: toPairs(response.headers),
    size: response.content?.size ?? -1,
    transferSize: entry.response._transferSize ?? response.bodySize ?? -1,
  };
}

// 「保留日志」关闭时，与 Chrome 一致在页面跳转时清空；跳转后的文档请求完成得更晚，不会被清掉
chrome.storage.local.get('preserveLog').then((res) => {
  if (res.preserveLog === false) store.setPreserve(false);
}, () => null);
chrome.devtools.network.onNavigated.addListener(() => {
  if (!store.preserve) store.clear();
});

chrome.devtools.network.onRequestFinished.addListener((entry) => {
  // WebSocket 只在连接关闭后上报且没有响应体，不做记录
  if (store.paused || entry._resourceType === 'websocket') return;
  if (mockTargets.delete(entry.request.url)) return;
  const record = toRecord(entry);
  entries.set(record, entry);
  applyMock(record);
  const eager = record.category === 'fetch' && TEXT_MIME.test(record.mime) && record.size <= EAGER_MAX;
  if (!eager) return store.add(record);
  // 先读完再入列表，保证页面跳转后接口响应仍可查看
  // text/plain 等返回 JSON 的接口，按内容识别；记录尚未入列表，此处补标记是安全的
  const gen = store.generation;
  loadContent(record).then((c) => {
    if (!record.json && !c.encoding && looksLikeJson(c.text)) record.json = true;
  }, () => null).then(() => {
    if (gen === store.generation) store.add(record);
  });
});
