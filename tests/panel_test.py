"""API Lens 面板回归测试。

在本地静态服务器中打开 src/panel/panel.html，页面加载前注入假的 chrome.devtools 与
window.__jniStore（模拟请求记录），再用 Playwright 操作并断言。

依赖：pip install playwright && playwright install chromium
运行：python3 tests/panel_test.py（任意目录均可）
"""
import functools
import http.server
import json
import socketserver
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

ORDERS = {
    "code": 0,
    "data": {"list": [{"id": i, "title": f"item {i}", "amount": [50, 150, 300][i % 3]} for i in range(30)]},
    "multiline": "line1\nline2",
    "quote": 'say "hi"',
    "big": 0,
}
# 超出安全整数范围的数字，验证不丢精度
ORDERS_TEXT = json.dumps(ORDERS).replace('"big": 0', '"big": 12345678901234567890')

INIT = """(() => {
  window.chrome = { devtools: { panels: { themeName: 'default' } } };
  // 模拟 DevTools 注入的按键转发：带 ⌘/Ctrl 的按键到达 document 就会被转发
  window.__forwarded = 0;
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') window.__forwarded += 1; });
  // 复制走 execCommand，记录复制内容供断言
  document.execCommand = function () { window.__copied = document.activeElement && document.activeElement.value; return true; };
  let seq = 0;
  const subs = new Set();
  const t0 = Date.now() - 100000;
  const mk = (url, extra = {}) => ({
    id: ++seq, method: 'GET', url, status: 200, statusText: 'OK', startTime: t0 + seq * 1000, duration: 50,
    resourceType: 'fetch', category: 'fetch', mime: 'application/json', json: true, size: 100, transferSize: 60,
    reqHeaders: [['accept', 'application/json']], reqBody: null, reqMime: '', reqParams: [],
    query: [...new URL(url).searchParams], resHeaders: [['content-type', 'application/json'], ['x-tt-logid', `LOGID${seq}`]],
    ...extra,
  });
  const records = [
    mk('https://api.example.com/v1/orders?page=1&keyword=hello%20world'),
    mk('https://api.example.com/v1/user', { method: 'POST', status: 400 }),
    mk('https://cdn.example.com/app.js', { resourceType: 'script', category: 'js', mime: 'application/javascript', json: false }),
    ...Array.from({ length: 7 }, (_, i) => mk(`https://api.example.com/v1/item/${i}`)),
  ];
  window.__jniStore = {
    records, paused: false, setPaused(v) { this.paused = v; subs.forEach((f) => f({ type: 'pause' })); },
    preserve: true, setPreserve(v) { this.preserve = v; subs.forEach((f) => f({ type: 'preserve' })); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    clear() { records.length = 0; subs.forEach((f) => f({ type: 'clear' })); },
    loadContent: (r) => Promise.resolve({ text: r.url.includes('/orders') ? __ORDERS__ : '{"ok":true}', encoding: '' }),
  };
  window.__add = (url, extra = {}) => { const r = mk(url, { startTime: Date.now(), ...extra }); records.push(r); subs.forEach((f) => f({ type: 'add', record: r })); };
  window.__evict = () => { const r = records.shift(); subs.forEach((f) => f({ type: 'evict', record: r })); };
})();""".replace('__ORDERS__', json.dumps(ORDERS_TEXT))

JV = '[data-jv="res"]'
failures = []


def check(cond, name):
    print(('ok   ' if cond else 'FAIL ') + name)
    if not cond:
        failures.append(name)


def test_list(page):
    check(page.locator('.r').count() == 9, '默认只显示 JSON 请求')
    page.click('#types [data-v="all"]')
    page.wait_for_timeout(100)
    check(page.locator('.r').count() == 10, '切到「全部」显示所有请求')
    page.fill('#q', 'item/3')
    page.wait_for_timeout(200)
    check(page.locator('.r').count() == 1, '关键词筛选')
    page.fill('#q', 'method:post status-code:400 domain:example.com')
    page.wait_for_timeout(200)
    check(page.locator('.r').count() == 1 and '/v1/user' in page.inner_text('.r'), 'method: / status-code: / domain: 筛选')
    page.fill('#q', '-domain:api.example.com')
    page.wait_for_timeout(200)
    check(page.locator('.r').count() == 1 and 'app.js' in page.inner_text('.r'), '-domain: 排除')
    page.fill('#q', 'LOGID2')
    page.wait_for_timeout(200)
    check(page.locator('.r').count() == 1 and '/v1/user' in page.inner_text('.r'), '按提取的 Header 值筛选')
    page.fill('#q', '')
    page.wait_for_timeout(200)


def test_hover_no_flicker(page):
    page.locator('.r', has_text='/item/2').hover()
    page.evaluate("window.__mark = document.querySelector('.r:hover')")
    for k in range(5):
        page.evaluate(f"__add('https://api.example.com/v1/new/{k}')")
        page.wait_for_timeout(60)
    same = page.evaluate("document.querySelector('.r:hover') === window.__mark && window.__mark.isConnected")
    check(same, '悬停时新请求到来，悬停行不被替换（不闪烁）')
    page.wait_for_timeout(500)
    check(page.is_visible('#tip') and '/item/2' in page.inner_text('#tip'), '持续有新请求时悬停提示正常出现')
    page.mouse.move(5, 5)


def test_detail(page):
    page.locator('.r', has_text='/v1/orders').click()
    page.wait_for_timeout(400)
    metas = page.locator('.d-meta .mi').all_inner_texts()
    check(len(metas) == 4 and 'fetch · json' in metas[-1], f'元信息标签 {metas}')
    tree = page.inner_text(f'{JV} .jv-tree')
    check('"line1\\nline2"' in tree and '12345678901234567890' in tree, '字符串转义显示、大整数不丢精度')


def test_json_tools(page):
    page.keyboard.press(('Meta' if sys.platform == 'darwin' else 'Control') + '+F')
    focused = page.evaluate("document.activeElement.matches('[data-jv=\"res\"] [data-in=\"search\"]')")
    check(focused and page.evaluate('__forwarded') == 0, '⌘F 聚焦响应搜索框且不被 DevTools 转发')
    search = f'{JV} [data-in="search"]'
    page.fill(search, 'item')
    page.wait_for_timeout(400)
    check(page.inner_text(f'{JV} .jv-count') == '1/30', '树形搜索计数')
    page.press(search, 'Enter')
    check(page.inner_text(f'{JV} .jv-count') == '2/30', '搜索跳到下一个')
    page.fill(search, '')
    page.click(f'{JV} [data-act="mode"]')
    page.wait_for_timeout(200)
    check(page.locator(f'{JV} .jv-line').count() > 30, '文本模式逐行渲染')
    page.click(f'{JV} [data-act="mode"]')
    page.wait_for_timeout(200)

    page.locator(f'{JV} .jv-row', has_text='"multiline"').click(button='right')
    page.locator('.menu button', has_text='复制值').click()
    check(page.evaluate('window.__copied') == 'line1\nline2', '复制值为原始字符串')

    query = f'{JV} [data-in="query"]'
    page.fill(query, 'data.list.filter(x => x.amount > 200).map(x => x.id)')
    page.press(query, 'Enter')
    page.wait_for_timeout(400)
    check('10 项' in page.inner_text(f'{JV} .jv-banner'), 'JS 表达式过滤')
    page.fill(query, 'data.list[*].title')
    check(page.locator(f'{JV} [data-act="apply"].pending').count() == 1, '输入未执行时应用按钮高亮')
    page.click(f'{JV} [data-act="apply"]')
    page.wait_for_timeout(400)
    check('30 项' in page.inner_text(f'{JV} .jv-banner'), 'JSONPath 过滤')
    page.fill(query, 'big')
    page.press(query, 'Enter')
    page.wait_for_timeout(400)
    check('12345678901234567890' in page.inner_text(f'{JV} .jv-body'), '表达式结果大整数不丢精度')
    page.click(f'{JV} .jv-query .clear-x')
    page.wait_for_timeout(200)


def test_copy_rows(page):
    page.click('.tabs [data-tab="req"]')
    page.wait_for_timeout(200)
    row = page.locator('[data-sec="query"] .kv', has_text='keyword')
    check(row.locator('[data-copy-kv]').evaluate('e => getComputedStyle(e).opacity') == '0', '复制按钮默认隐藏')
    row.hover()
    row.locator('[data-copy-kv]').click()
    check(page.evaluate('window.__copied') == 'hello world', 'Query 参数行复制')
    page.click('.tabs [data-tab="headers"]')
    page.wait_for_timeout(200)
    page.locator('[data-sec="res"] .kv', has_text='x-tt-logid').locator('[data-copy-kv]').click()
    check(page.evaluate('window.__copied') == 'LOGID1', 'Header 行复制')


def test_clear(page):
    page.click('#btn-clear')
    page.wait_for_timeout(200)
    check(page.locator('.r').count() == 0, '清空后无残留行')
    page.evaluate("__add('https://api.example.com/v1/after-clear')")
    page.wait_for_timeout(200)
    check(page.locator('.r').count() == 1, '清空后新请求正常显示')


def test_errors_and_shortcuts(page):
    page.click('#types [data-v="json"]')
    page.evaluate("__add('https://api.example.com/v1/broken', { status: 0, mime: '', json: false })")
    page.evaluate("__add('https://cdn.example.com/missing.js', { status: 404, resourceType: 'script', category: 'js', mime: 'text/html', json: false })")
    page.wait_for_timeout(200)
    check(page.locator('.r', has_text='/v1/broken').count() == 1, 'JSON 筛选显示失败的接口')
    check(page.locator('.r', has_text='missing.js').count() == 0, 'JSON 筛选不显示非接口的错误资源')
    page.evaluate('__evict()')
    page.wait_for_timeout(200)
    check(page.locator('.r', has_text='after-clear').count() == 0, '淘汰的记录从列表移除')
    page.uncheck('#preserve')
    check(page.evaluate('__jniStore.preserve') is False, '取消保留日志同步到 store')
    page.keyboard.press('Meta+K' if sys.platform == 'darwin' else 'Control+L')
    page.wait_for_timeout(200)
    check(page.locator('.r').count() == 0, '快捷键清空')


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 1280, 'height': 800})
            page.add_init_script(INIT)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
            page.goto(f'http://127.0.0.1:{server.server_address[1]}/src/panel/panel.html')
            page.wait_for_timeout(300)
            for test in (test_list, test_hover_no_flicker, test_detail, test_json_tools, test_copy_rows, test_clear,
                         test_errors_and_shortcuts):
                test(page)
            browser.close()
    finally:
        server.shutdown()
    check(not errors, f'无控制台错误 {errors}')
    print(f'\n{"全部通过" if not failures else f"{len(failures)} 项失败"}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
