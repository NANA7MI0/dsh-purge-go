#!/bin/sh
# dsh-purge-go 一键安装：装插件 + 打补丁，一步到位。
#
#   ./install.sh                 装插件 + 打补丁（推荐）
#   ./install.sh --plugin-only   只装插件，不打补丁（注入层生效，引擎限制仍在）
#   ./install.sh --dry           只预演打补丁会改哪些文件，不真改
#   ./install.sh --profile web   指定 profile（默认 web）
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
PROFILE=web
MODE=full

while [ $# -gt 0 ]; do
  case "$1" in
    --plugin-only) MODE=plugin; shift ;;
    --dry)         MODE=dry; shift ;;
    --profile)     PROFILE=$2; shift 2 ;;
    --profile=*)   PROFILE=${1#--profile=}; shift ;;
    -h|--help)
      sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) printf '✖ 不认识的参数：%s\n' "$1" >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }

say ""
say "════════════════════════════════════════"
say " dsh-purge-go 安装"
say "════════════════════════════════════════"
say ""

command -v dsh >/dev/null 2>&1 || die "找不到 dsh 命令。确认 dsh-go 已装好，且 dsh 在 PATH 里。"
[ -f "$HERE/package.json" ] || die "这里不是 dsh-purge-go 仓库目录：$HERE"

if [ "$MODE" = "dry" ]; then
  say "▸ 预演模式：只扫描 + 预演补丁"
  say "  不装插件、不改任何文件。"
else
  say "▸ 第 1 步 / 2：装插件到 profile「$PROFILE」"
  say "  $HERE"
  say ""
  if dsh plugin --profile "$PROFILE" add "$HERE" 2>&1 | sed 's/^/  /'; then
    say "  ✔ 插件已装入"
  else
    die "装插件失败，原始报错见上。"
  fi
fi

if [ "$MODE" = "plugin" ]; then
  say ""
  say "▸ 已跳过补丁层（--plugin-only）"
  say ""
  say "  ⚠ 现在只有注入层生效，引擎的审批与沙箱限制还在。"
  say "    想补上，随时跑：cd $HERE && ./install.sh"
  say ""
  exit 0
fi

say ""
if [ "$MODE" = "dry" ]; then
  say "▸ 预演补丁（--dry，不会真改）"
else
  say "▸ 第 2 步 / 2：打补丁到引擎包"
fi
say ""

cd "$HERE" || die "进不去 $HERE"

say "  扫描中 …"
if ! PROBE_OUT=$(node patches/purge-patch.mjs probe 2>&1); then
  say "$PROBE_OUT" | sed 's/^/  /'
  die "probe 失败。"
fi
say "$PROBE_OUT" | grep -E '^tally:' | sed 's/^/  /' || true
say ""

if [ "$MODE" = "dry" ]; then
  node patches/purge-patch.mjs apply --dry 2>&1 | sed 's/^/  /'
  say ""
  say "  ✔ 预演完成，什么都没改。"
  say ""
  exit 0
fi

if node patches/purge-patch.mjs apply 2>&1 | sed 's/^/  /'; then
  say "  ✔ 补丁已打上"
else
  die "打补丁失败。引擎包可能已被部分修改——跑 ./install.sh --dry 看状态，或查 patch-probe.json。"
fi

say ""
say "════════════════════════════════════════"
say " 两层都装好了"
say "════════════════════════════════════════"
say ""
say "  注入层  ✔ 插件加载时自动落盘正文并开启"
say "  补丁层  ✔ 已打到引擎包"
say ""
say "▸ 最后一步：重启引擎让补丁生效"
say ""
say "  am force-stop io.github.ccch1mneyyy.dsh_app"
say ""
say "  然后重新打开 App。（光退出界面不算重启）"
say ""
say "▸ 想撤销"
say "  cd $HERE"
say "  node patches/purge-patch.mjs restore --backup ./backup-<时间戳>"
say ""
