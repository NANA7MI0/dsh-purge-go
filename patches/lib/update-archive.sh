#!/bin/sh
# 连不上 github.com 时用归档更新：下载 codeload 的 tar.gz，解出来，整份替换仓库。
#
# 用法：sh patches/lib/update-archive.sh [仓库目录]
#       不给仓库目录就自己反查（从 profile 里的软链）。
#
# 为什么要有这个脚本：README 里那条「归档下载」的手工命令原来是
#   tar xzf ... --strip-components=1 -C .
# 直接解到仓库根。它只覆盖、不删除 —— 上游删掉或改名过的文件会留在原地，
# 于是「新旧两套模块同时存在」。而面板和 update-worker 走的是 replace-repo.sh
# （先铺后删、跳过 .git）。同一件事两套行为，用户按文档做和点按钮做结果不同。
#
# 现在这条命令改成调这个脚本，和代码内部走同一个 replace-repo.sh。
set -e

HERE=$(cd "$(dirname "$0")" && pwd)

# 仓库目录：优先用参数，其次从插件注册处反查
REPO="$1"
if [ -z "$REPO" ]; then
  REPO=$(readlink -f "$HOME/.dsh/profiles/web/node_modules/dsh-go-purge" 2>/dev/null || true)
  if [ -z "$REPO" ] || [ ! -d "$REPO" ]; then
    echo "找不到插件仓库。请显式给路径：sh update-archive.sh /path/to/dsh-purge-go" >&2
    exit 2
  fi
fi
if [ ! -d "$REPO" ]; then
  echo "仓库目录不存在：$REPO" >&2
  exit 2
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/dshpurge-arch.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

echo "▸ 下载归档 …"
node --input-type=module -e "
const url = 'https://codeload.github.com/NANA7MI0/dsh-purge-go/tar.gz/refs/heads/main'
const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
if (!res.ok) throw new Error('HTTP ' + res.status)
const buf = Buffer.from(await res.arrayBuffer())
if (buf.length < 1024) throw new Error('内容只有 ' + buf.length + ' 字节，不像压缩包')
const fs = await import('node:fs')
fs.writeFileSync(process.argv[1], buf)
console.log('  ' + (buf.length / 1024 / 1024).toFixed(1) + ' MB')
" "$TMP/repo.tgz"

echo "▸ 解包 …"
mkdir -p "$TMP/new"
tar xzf "$TMP/repo.tgz" --strip-components=1 -C "$TMP/new"

echo "▸ 替换仓库（先铺新的、再删多余的）…"
sh "$HERE/replace-repo.sh" "$TMP/new" "$REPO"

echo ""
echo "▸ 装到引擎（打补丁 + 同步原生目录 + 装插件）…"
cd "$REPO"
sh install.sh
