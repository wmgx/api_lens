// 导出与下载：HAR 1.2（可导入 DevTools / Charles 等工具）、精简 JSON，以及单个响应体另存为文件
const VERSION = chrome.runtime?.getManifest?.().version || '';

const toNameValue = (pairs) => pairs.map(([name, value]) => ({ name, value }));
const toObject = (pairs) => Object.fromEntries(pairs.map(([k, v]) => [k, v]));
const findHeader = (pairs, name) => pairs.find(([k]) => k.toLowerCase() === name)?.[1] || '';
const tryParse = (text) => {
  if (text == null || text === '') return text ?? null;
  try { return JSON.parse(text); } catch { return text; }
};

function harEntry(r, content) {
  const postData = r.reqBody != null || r.reqParams.length
    ? {
      mimeType: r.reqMime || findHeader(r.reqHeaders, 'content-type'),
      text: r.reqBody ?? '',
      ...(r.reqParams.length && { params: r.reqParams.map((p) => ({ name: p.name, value: p.value, ...(p.fileName && { fileName: p.fileName, contentType: p.contentType }) })) }),
    }
    : undefined;
  return {
    startedDateTime: new Date(r.startTime).toISOString(),
    time: r.duration,
    request: {
      method: r.method, url: r.url, httpVersion: '', cookies: [],
      headers: toNameValue(r.reqHeaders), queryString: toNameValue(r.query),
      ...(postData && { postData }), headersSize: -1, bodySize: r.reqBody?.length ?? 0,
    },
    response: {
      status: r.status, statusText: r.statusText, httpVersion: '', cookies: [],
      headers: toNameValue(r.resHeaders),
      content: {
        size: r.size, mimeType: r.mime,
        ...(content && { text: content.text }), ...(content?.encoding && { encoding: content.encoding }),
      },
      redirectURL: '', headersSize: -1, bodySize: r.transferSize ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: r.duration, receive: 0 },
  };
}

const toHar = (records, contents) => JSON.stringify({
  log: {
    version: '1.2', creator: { name: 'API Lens', version: VERSION }, pages: [],
    entries: records.map((r, i) => harEntry(r, contents[i])),
  },
}, null, 2);

const toJson = (records, contents) => JSON.stringify(records.map((r, i) => ({
  method: r.method,
  url: r.url,
  status: r.status,
  type: r.resourceType,
  startedAt: new Date(r.startTime).toISOString(),
  durationMs: r.duration,
  requestHeaders: toObject(r.reqHeaders),
  requestBody: tryParse(r.reqBody),
  ...(r.reqParams.length && { formData: r.reqParams }),
  responseHeaders: toObject(r.resHeaders),
  responseBody: contents[i]?.encoding ? contents[i].text : tryParse(contents[i]?.text),
  ...(contents[i]?.encoding && { responseBodyEncoding: contents[i].encoding }),
})), null, 2);

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportRecords(store, records, format) {
  const contents = await Promise.all(records.map((r) => store.loadContent(r).catch(() => null)));
  const text = format === 'har' ? toHar(records, contents) : toJson(records, contents);
  saveBlob(new Blob([text], { type: 'application/json' }), `api-lens-${stamp()}.${format === 'har' ? 'har' : 'json'}`);
}

// ---------- 单个响应体另存为 ----------
export function contentBlob(content, mime) {
  if (content.encoding !== 'base64') return new Blob([content.text], { type: mime || 'text/plain' });
  const bin = atob(content.text);
  return new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: mime || 'application/octet-stream' });
}

export function fileNameFor(r) {
  const cd = findHeader(r.resHeaders, 'content-disposition');
  const star = cd.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  try {
    if (star) return decodeURIComponent(star[1].trim());
  } catch { /* 用下面的兜底 */ }
  if (plain) return plain[1].trim();
  try {
    const last = new URL(r.url).pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch { /* 用默认名 */ }
  return 'response';
}

export async function downloadBody(store, r) {
  const content = await store.loadContent(r);
  saveBlob(contentBlob(content, r.mime), fileNameFor(r));
}
