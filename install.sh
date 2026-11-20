#!/bin/sh
# dsh-purge-go 一键安装：打补丁 + 装插件。
#
#   sh install.sh                 打补丁 + 装插件（推荐）
#   sh install.sh --plugin-only   只装插件，不打补丁（注入层生效，引擎限制仍在）
#   sh install.sh --dry           只扫描 + 预演补丁，什么都不改
#   sh install.sh --profile web   指定 profile（默认 web）
#
# 注意：每次更新 App（装新版 APK）都会重装引擎包、把补丁冲掉，
#       之后要重跑一次本脚本，或者跟插件说一句「重打补丁」。
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
PROFILE=web
MODE=full

DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --plugin-only) MODE=plugin; shift ;;
    # --dry 单独一个开关，不跟 MODE 抢变量：原来两者共用 MODE，后出现的会覆盖前面的，
    # 于是 `--dry --plugin-only` 反而会真的装插件。
    --dry)         DRY=1; shift ;;
    --profile)
      if [ -z "$2" ]; then
        printf '✖ --profile 后面要跟 profile 名（例如 web）\n' >&2; exit 1
      fi
      PROFILE=$2; shift 2 ;;
    --profile=*)   PROFILE=${1#--profile=}; shift ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) printf '✖ 不认识的参数：%s\n' "$1" >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }

# --dry 是「只看不改」，--plugin-only 是「只装插件不打补丁」，两个一起给没有意义，
# 而且会让调用者以为拿到的是预演结果。直接拒绝，别让顺序决定行为。
if [ "$DRY" = "1" ] && [ "$MODE" = "plugin" ]; then
  printf '✖ --dry 和 --plugin-only 不能一起用：前者只看不改，后者会真的装插件\n' >&2
  exit 1
fi
# 失败时统一提示一句怎么反馈——用户这时候最需要知道找谁。
die() {
  printf '✖ %s\n' "$*" >&2
  printf '\n  自查没用的话，把上面这段输出发到 NANA7MI0@outlook.com\n' >&2
  printf '  （附上版本号：node -p "require('"'"'%s/package.json'"'"').version"）\n' "$(dirname "$0")" >&2
  exit 1
}

say ""
say "════════════════════════════════════════"
say " dsh-purge-go 安装"
say "════════════════════════════════════════"
say ""

command -v dsh >/dev/null 2>&1 || die "找不到 dsh 命令。确认 dsh-go 已装好，且 dsh 在 PATH 里。"
[ -f "$HERE/package.json" ] || die "这里不是 dsh-purge-go 仓库目录：$HERE"

cd "$HERE" || die "进不去 $HERE"

# ── 第 1 步：打补丁（放在最前，因为它只改文件、不触发宿主重新装配）────
if [ "$MODE" = "plugin" ]; then
  say "▸ 已跳过补丁层（--plugin-only）"
  say ""
  say "  ⚠ 只会装插件，引擎的审批与沙箱限制还在。"
  say "    想补上补丁，随时跑：cd $HERE && sh install.sh"
  say ""
else
  if [ "$DRY" = "1" ]; then
    say "▸ 预演模式：只扫描 + 预演补丁"
    say "  不装插件、不改任何文件。"
  else
    say "▸ 第 1 步 / 3：打补丁到引擎包"
  fi
  say ""

  say "  扫描中 …"
  # --dry 时 probe 结果写到临时目录，别往仓库里留文件（见下面的「什么都没改」）
  if [ "$DRY" = "1" ]; then
    PROBE_OUT_PATH="$(mktemp -d)/patch-probe.json"
  else
    PROBE_OUT_PATH="$HERE/patch-probe.json"
  fi
  if ! PROBE_OUT=$(node patches/purge-patch.mjs probe --out "$PROBE_OUT_PATH" 2>&1); then
    say "$PROBE_OUT" | sed 's/^/  /'
    die "probe 失败。"
  fi
  say "$PROBE_OUT" | grep -E '^tally:' | sed 's/^/  /' || true
  say ""

  if [ "$DRY" = "1" ]; then
    node patches/purge-patch.mjs apply --dry 2>&1 | sed 's/^/  /'
    say ""
    say "  ✔ 预演完成，什么都没改。"
    say "  真安装请去掉 --dry 重跑：sh install.sh"
    say ""
    exit 0
  fi

  # 备份统一放到插件自己的目录：~/.dsh/dsh-purge/patch-backup/<时间戳>
  # 不传 --backup 的话 CLI 会建在仓库目录（backup-<时间戳>），插件的「还原补丁」
  # 就找不到——第一次安装的人点了只会看到「没有可还原的补丁备份」。
  # 加毫秒随机后缀，避免同一秒内重跑覆盖上一份真备份
  # 用 UTC（date -u）与 CLI／插件保持一致：那两处都是 toISOString()。
  # 混用本地时间会让目录名排序错乱——本地比 UTC 快 8 小时，
  # 「19:45 本地」会排到「12:38 UTC」后面，而后者其实更新。
  BACKUP_DIR="$HOME/.dsh/dsh-purge/patch-backup/$(date -u +%Y%m%d%H%M%S)-$$"
  mkdir -p "$BACKUP_DIR"
  # 不能写成 `if node ... | sed`：if 看的是管道最后一个命令（sed）的退出码，
  # sed 恒返回 0，于是补丁全失败也照样打印「✔ 补丁已打上」并以 0 退出。
  # 先把输出收进变量、按 node 自己的退出码判断，再决定要不要打印。
  if APPLY_OUT=$(node patches/purge-patch.mjs apply --backup "$BACKUP_DIR" 2>&1); then
    printf '%s\n' "$APPLY_OUT" | sed 's/^/  /'
    say "  ✔ 补丁已打上"
    say "    备份：$BACKUP_DIR"
    say "    （面板上的「还原补丁」用的就是这里）"
  else
    die "打补丁失败。引擎包可能已被部分修改——跑 sh install.sh --dry 看状态，或查 patch-probe.json。"
  fi
  say ""
fi

# ── 第 2 步：原生界面目录（只有 dsh-go 手机端需要）─────────────────
# dsh-go 的原生插件（输入框上方的胶囊、状态条、面板）不在 profile 里，
# 而是在 $HOME/.dsh/dsh-go/plugins/<包名>/ —— 那一层 app 自己扫，dsh plugin add 不管。
# 不建这个目录，装完没有胶囊、没有面板，README 里让你「点胶囊」就成了空话。
#
# 为什么排在装插件之前：建目录是纯文件操作、不会被打断；装插件是整条流程里唯一
# 可能掐断命令的步骤。顺序反过来会出现「插件装上了、目录没建」——用户拿到一个
# 既没有胶囊也没有面板的插件，连点哪儿修都找不到。
if [ -f /etc/dsh-app/runtime.json ]; then
  NATIVE="$HOME/.dsh/dsh-go/plugins/dsh-go-purge"
  say "▸ 第 2 步 / 3：建原生界面目录"
  say "  $NATIVE"
  say ""
  rm -rf "$NATIVE"
  mkdir -p "$NATIVE"
  LINKED=0
  for f in LICENSE NOTICE README.md CHANGELOG.md assets cordis.patch.yml docs install.sh lib patches package.json; do
    if [ -e "$HERE/$f" ]; then
      if ln -sf "$HERE/$f" "$NATIVE/$f" 2>/dev/null; then
        LINKED=$((LINKED+1))
      else
        say "  ⚠ 链接失败：$f"
      fi
    fi
  done
  if [ "$LINKED" -lt 11 ]; then
    say "  ⚠ 只链上了 $LINKED/11 项，原生界面可能缺文件"
  fi
  say "  ✔ 已链到 $HERE"
  say ""
  say "  这里每一项都是软链，所以以后 git pull 更新仓库，原生界面跟着变，"
  say "  不用再单独同步 package.json 里的 dshGo 清单。"
  say ""
else
  say "（这台机器没有 dsh-go 桥接，跳过原生界面目录）"
  say ""
fi

# ── 第 3 步：装插件（放最后，它会触发宿主重新装配插件层）──────────
say "▸ 第 3 步 / 3：装插件到 profile「$PROFILE」"
say "  $HERE"
say ""
# 旧版引擎上这一步会把正在执行的那条命令掐掉（Error: tool call aborted）。
# 现在实测不再发生；但顺序仍保持「先补丁后插件」，万一某台机器还会打断，
# 补丁早已落地，被打断的只是收尾输出。
say "  这一步会让宿主重新装配插件层。"
say ""

if dsh plugin --profile "$PROFILE" add "$HERE" 2>&1 | sed 's/^/  /'; then
  say "  ✔ 插件已装入"
else
  # 返回非零不一定是真失败（旧版上装配会掐断命令）；别让用户盲目重装，先核对。
  say ""
  say "  ⚠ dsh plugin add 返回非零——先别重装，核对一下是不是已经装上了："
  say "      node -p 'require(process.env.HOME+\"/.dsh/profiles/web/package.json\").dependencies[\"dsh-go-purge\"]'"
  say "    有输出就说明装上了。"
  say ""
fi

# ── 收尾 ────────────────────────────────────────────────────────
say ""
say "════════════════════════════════════════"
say " 装好了"
say "════════════════════════════════════════"
say ""
say "  注入层  ✔ 插件加载时自动落盘正文并开启"
# --plugin-only 时补丁那步是跳过的，别在收尾说「已打到引擎包」
if [ "$MODE" = "plugin" ]; then
  say "  补丁层  ✖ 没打（本次用了 --plugin-only）"
  say "           审批和沙箱限制还在，想补上就跑：cd $HERE && sh install.sh"
else
  say "  补丁层  ✔ 已打到引擎包"
fi
say ""
say "▸ 最后一步：重启引擎让补丁生效"
say ""
say "  am force-stop io.github.ccch1mneyyy.dsh_app"
say ""
say "  然后重新打开 App。（光退出界面不算重启）"
say ""
say "▸ 记住一件事"
say "  以后每次更新 App 都会重装引擎包、把补丁冲掉。"
say "  到时候重跑一次本脚本，或者跟插件说一句「重打补丁」。"
say ""
say "▸ 想撤销"
say "  本次的补丁备份在：${BACKUP_DIR:-（本次没打补丁）}"
say "  命令行撤销：node patches/purge-patch.mjs restore --backup \"$BACKUP_DIR\""
say "  或者直接点面板上的「还原补丁」。"
say ""
