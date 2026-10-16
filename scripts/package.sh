#!/usr/bin/env bash
# 校验并打包扩展：scripts/package.sh [版本号]
# 不传版本号时使用 manifest.json 中的 version；传入时（如 CI 中由 tag 得到）写入打包产物的 manifest。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="${1:-$(node -p "require('./manifest.json').version")}"
VERSION="${VERSION#v}"

if ! [[ "$VERSION" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]]; then
  echo "版本号不合法：${VERSION}（需为 1~4 段数字，如 1.2.0）" >&2
  exit 1
fi

echo "==> 语法检查"
node -e "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8'))"
find src -name '*.js' -print0 | while IFS= read -r -d '' f; do
  node --experimental-default-type=module --check "$f"
done

echo "==> 打包 v${VERSION}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R manifest.json src icons "$STAGE/"
node -e "
  const fs = require('fs');
  const file = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...manifest, version: process.argv[2] }, null, 2) + '\n');
" "$STAGE/manifest.json" "$VERSION"
find "$STAGE" -name '.DS_Store' -delete

mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/api-lens-$VERSION.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -qr -X "$OUT" .)
echo "==> 输出 $OUT"
