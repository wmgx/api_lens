// 生成与 DevTools「Copy as cURL (bash)」等价的命令
const SKIP_HEADERS = new Set(['content-length']);
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export function toCurl(r) {
  const parts = [`curl ${quote(r.url)}`];
  const hasBody = r.reqBody != null && r.reqBody !== '';
  if (r.method !== 'GET' || hasBody) parts.push(`-X ${r.method}`);
  const headers = r.reqHeaders.filter(([k]) => !k.startsWith(':') && !SKIP_HEADERS.has(k.toLowerCase()));
  headers.forEach(([k, v]) => parts.push(`-H ${quote(`${k}: ${v}`)}`));
  if (hasBody) parts.push(`--data-raw ${quote(r.reqBody)}`);
  if (headers.some(([k, v]) => k.toLowerCase() === 'accept-encoding' && /gzip|deflate|br|zstd/.test(v))) parts.push('--compressed');
  return parts.join(' \\\n  ');
}
