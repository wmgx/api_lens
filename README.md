# API Lens

Edge / Chrome DevTools 扩展：在 DevTools 中新增「API Lens」标签页，查看当前标签页的网络请求，重点优化 JSON 接口的查看与排查——JSON 格式化 / 折叠 / 搜索、`$.path` 与 JS 表达式过滤、复制 cURL、自动提取 `x-tt-logid` 等 Header、导出 HAR。

## 安装

1. 在 [Releases](https://github.com/wmgx/api_lens/releases) 下载最新的 `api-lens-x.y.z.zip` 并解压（或直接克隆本仓库）
2. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`），开启「开发人员模式」
3. 点击「加载解压缩的扩展」，选择解压后的目录（包含 `manifest.json`）
4. 按 `F12` 打开 DevTools，切换到 **API Lens** 标签页

完整功能与用法见 [doc/README.md](doc/README.md)。

## 开发与发布

```bash
./scripts/package.sh          # 语法检查并打包到 dist/api-lens-<manifest 版本>.zip
./scripts/package.sh 1.3.0    # 指定版本号打包（写入产物中的 manifest）
```

- 推送到 `main` 或提交 PR：GitHub Actions 自动校验并打包，zip 可在该次运行的 Artifacts 中下载
- 推送 `v*` tag（如 `git tag v1.3.0 && git push origin v1.3.0`）：自动打包并发布 Release，版本号取自 tag
