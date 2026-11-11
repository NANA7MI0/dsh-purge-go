#!/usr/bin/env bash
# 生成发布资产：npm 包 tgz + 自解压安装器 + sha256sums.txt
#
#   bash scripts/build-selfinstall.sh            # 产出到 dist/
#   OUT=out bash scripts/build-selfinstall.sh    # 换输出目录
#
# 产物（版本号取自 package.json）：
#   dist/dsh-purge-go-<ver>.tgz                  npm 包（dsh plugin add / npm pack 同款）
#   dist/dsh-purge-go-<ver>-selfinstall.sh       自解压安装器（Android / PRoot / 任意 Linux 可用）
#   dist/sha256sums.txt                          上面两个文件的校验和
set -euo pipefail

cd "$(dirname "$0")/.."
PKG=dsh-purge-go
VER=$(node -p "require('./package.json').version")
OUT=${OUT:-dist}
mkdir -p "$OUT"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die '找不到 node'
command -v npm >/dev/null 2>&1 || die '找不到 npm'
command -v base64 >/dev/null 2>&1 || die '找不到 base64'

say "== $PKG $VER → $OUT"

# 1. npm 包（package.json 的 files 白名单决定内容）
TGZ="$OUT/$PKG-$VER.tgz"
rm -f "$TGZ"
npm pack --pack-destination "$OUT" --silent >/dev/null
[ -f "$TGZ" ] || die "npm pack 没产出 $TGZ"
say "· tgz: $(du -h "$TGZ" | cut -f1)  $(basename "$TGZ")"

# 2. 自解压安装器 = 模板 + base64(tgz)
[ -f scripts/selfinstall-head.sh ] || die '缺 scripts/selfinstall-head.sh'
SELF="$OUT/$PKG-$VER-selfinstall.sh"
TMP="$SELF.tmp"
{
  sed "s/__VERSION__/$VER/g" scripts/selfinstall-head.sh
  printf '%s\n' '__PAYLOAD_BEGIN__'
  base64 "$TGZ"
  printf '%s\n' '__PAYLOAD_END__'
} > "$TMP"
mv "$TMP" "$SELF"
chmod +x "$SELF"
say "· selfinstall: $(du -h "$SELF" | cut -f1)  $(basename "$SELF")"

# 3. 校验和
( cd "$OUT" && sha256sum "$PKG-$VER.tgz" "$PKG-$VER-selfinstall.sh" > sha256sums.txt )
say "· sha256sums.txt"
sed 's/^/    /' "$OUT/sha256sums.txt"

# 4. 自检：安装器能跑、payload 能解开、包内 lib/index.js 存在
say '· 自检'
bash -n "$SELF" || die '安装器语法错误'
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
mkdir -p "$TMPD/profiles/web"
sed -n '/^__PAYLOAD_BEGIN__$/,/^__PAYLOAD_END__$/p' "$SELF" | sed '1d;$d' | base64 -d > "$TMPD/pkg.tgz"
# 注意：不要写成 tar | grep -q —— grep 提前退出会让 tar 收到 SIGPIPE，
# pipefail 下整条管道变成失败，误报「payload 里没有 …」。
tar -tzf "$TMPD/pkg.tgz" > "$TMPD/pkg.list" || die 'payload tar 无法列出内容'
grep -qxF 'package/lib/index.js' "$TMPD/pkg.list" || die 'payload 里没有 lib/index.js'
grep -qxF 'package/LICENSE' "$TMPD/pkg.list" || die 'payload 里没有 LICENSE'
DSH_HOME="$TMPD" bash "$SELF" --check >/dev/null || die '安装器 --check 失败'

# 5. 真装一遍：npm pack 的 package/ 顶层要能变成 <home>/dsh-go/plugins/dsh-purge-go
printf '{"name":"t","private":true,"dsh":{"profile":{"bundles":[]}}}\n' > "$TMPD/profiles/web/package.json"
if ! DSH_HOME="$TMPD" bash "$SELF" >"$TMPD/install.log" 2>&1; then
  sed 's/^/    /' "$TMPD/install.log"
  die '安装器实装失败'
fi
[ -f "$TMPD/dsh-go/plugins/$PKG/package.json" ] || die "实装后没有 dsh-go/plugins/$PKG/package.json"
grep -q "\"$PKG\"" "$TMPD/profiles/web/package.json" || die 'profile 没登记本包'
[ -f "$TMPD/profiles/web/node_modules/$PKG/package.json" ] || die 'node_modules 软链没指对'
say '  ✓ payload 可解、包结构完整、--check 通过、实装 + profile 登记 + 软链通过'
say ''
say "✓ 完成：$OUT/"
ls -1 "$OUT"
