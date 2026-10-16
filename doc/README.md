# API Lens

Edge / Chrome DevTools 扩展：在 DevTools 中新增「API Lens」标签页，查看当前标签页的网络请求，重点优化 JSON 接口的查看与排查。

## 安装

1. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`），开启「开发人员模式」
2. 点击「加载解压缩的扩展」，选择本项目根目录（包含 `manifest.json` 的目录）；更新代码后在该页点「重新加载」，并重新打开 DevTools
3. 在任意页面按 `F12` 打开 DevTools，切换到 **API Lens** 标签页（可能折叠在 `»` 里）

## 行为说明

- 打开 DevTools 后开始记录全部请求，和原生 Network 面板一致；刷新页面后继续追加，旧记录保留；关闭 DevTools 后清空
- 不限条数，按请求开始时间升序展示；每个标签页的 DevTools 相互独立
- 「JSON」按响应 `Content-Type` 含 json 识别，Fetch/XHR 还会按响应内容识别（如 `text/plain` 返回 JSON）
- 不记录 WebSocket
- Fetch/XHR 的文本响应在请求完成时读取；其他资源（文档、脚本、图片、下载等）在查看时按需读取，页面跳转后可能已被 DevTools 释放

## 功能

| 功能 | 说明 |
|------|------|
| 列表 | 时间、方法、状态（失败请求标红）、类型、地址、耗时；悬停显示完整 URL、类型大小与提取的 Header |
| 类型筛选 | 全部 / JSON / Fetch/XHR / Doc / JS / CSS / Img / Media / Font / 其他，⌘/Ctrl+点击多选，默认 JSON；放不下时可横向滚动 |
| 筛选 | 关键词匹配 URL 和提取的 Header 值（空格分隔多个，`-` 前缀排除）、方法、状态码（下拉框，支持键盘）；历史最多 10 条，回车或选中请求时记录，可下拉选择 / 删除；所有输入框有内容时可点 × 清空 |
| 暂停 / 导出 | 暂停期间的请求不记录；导出当前列表或选中请求为 HAR / JSON |
| 右键菜单 | 复制 cURL / URL / 提取的 Header / 响应体 / 请求体，下载响应体，导出此请求，只看 / 隐藏此 Host |
| 设置（齿轮） | 自动提取 Header（每行一个，默认 `x-tt-logid`）；Host 过滤（显示全部 / 仅显示匹配 / 隐藏匹配，支持 `*`），只影响展示 |
| 响应 | JSON 用查看器；图片直接预览（显示尺寸）；其他文本按原文显示；二进制显示文件信息并可下载（文件名取自 Content-Disposition） |
| JSON 查看 | 格式化、高亮（树形和文本模式都有）、缩进引导线、数组下标、折叠（Alt+点击递归）、悬停复制；超大整数不丢精度 |
| JSON 搜索 | 搜索 key / value，Enter / Shift+Enter 跳转，自动展开并定位 |
| 路径栏 | 底部显示悬停节点的 `$.path`，点击复制；右键节点可复制值 / 路径 / key、按此路径过滤 |
| 表达式过滤 | 输入框固定以 `$.` 开头，切换请求时保留，历史可下拉选择 / 删除（见下） |

所有图标按钮悬停都有说明。

### 表达式过滤

输入框已带 `$.` 前缀，直接从字段名开始写：

| 写法 | 示例 |
|------|------|
| 路径 | `data.user.name`、`data.list[0]`、`data.list[-1]`、`data['x-key']`；根是数组时写 `[0]` |
| JSONPath | `data.list[*].id`、`.id`（即 `$..id` 递归）、`data.list[0:5]`、`data.*` |
| JS 表达式 | `data.list.filter(x => x.status !== 0).map(x => ({ id: x.id, name: x.name }))`、`data.list.length` |

JS 表达式在扩展的沙箱页中执行，不能访问页面和扩展权限。超出安全整数范围的数字以原文保留，参与数值比较时会失真。

## 快捷键

| 按键 | 作用 |
|------|------|
| `/` 或 `⌘/Ctrl+K` | 聚焦筛选框 |
| `↑` `↓` / `k` `j` | 切换选中请求（输入框内为选择历史） |
| `⌘/Ctrl+F` | 在当前 JSON 中搜索 |
| `Esc` | 关闭详情 / 清空搜索 / 清除表达式 |

## 结构

```
manifest.json
src/devtools.html, devtools.js   # 收集请求（chrome.devtools.network），按需读取响应体
src/panel/                       # 面板 UI：列表、详情、JSON 查看器、设置、历史、右键菜单、导出
src/sandbox/                     # 表达式求值沙箱（路径 / JSONPath / JS）
icons/
```
