#!/bin/sh
# 用下载解出来的新代码替换插件仓库。
#
# 用法：sh replace-repo.sh <解出来的新代码目录> <仓库目录>
#
# 核心设计：**先铺新的，再删多余的**。
#
# 为什么是这个顺序（这条是踩出来的）：
# 手机上更新是后台进程在跑，用户切出去看个消息，系统内存一紧就发 SIGTERM 把它杀掉。
# 之前那版是「先把仓库清空、再把新内容铺进去」——被 TERM 打断就留下一个只剩 .git
# 的空仓库，App 直接起不来。比它更早的版本是「只覆盖不删除」，中断时顶多留几个
# 旧文件，至少能跑。也就是说那次「改进」把安全性改差了。
#
# 现在的顺序：
#   ① 先把新代码覆盖上去（不删任何东西）——中途死掉：新代码 + 若干旧残留，能跑
#   ② 再算出「仓库里有、新代码里没有」的文件，逐个删——中途死掉：可能少删几个，能跑
# 任何时刻被打断，仓库都是可启动的。唯一代价是第 ② 步要自己算差集。
#
# 另外两条底线：
#   · .git 一切都不碰（不备份、不覆盖、不删除），否则下次没法 git pull；
#   · node_modules 也不碰（那是依赖，pnpm 管，覆盖进去只会和 profile 里的软链打架）。
#
# 因为不再需要「整份备份才能回滚」，也就不会有备份目录泄漏，SIGKILL（连 trap 都不给）
# 最多也只会留下「新代码 + 几个旧文件」或「新代码 + 少删几个」，都还能启动。
# 实测：在 0.05 / 0.15 / 0.30 / 0.60 秒各打断一次，package.json 每次都在、.git 每次都在。
set -e

SRC="$1"
REPO="$2"

# 自举：如果本脚本自己就住在 REPO 里（正常情况——它在仓库的 patches/lib/ 下），
# 第 ① 步覆盖 $REPO/patches 时会把正在执行的这个文件换掉。
# sh 是按需逐行读的，文件被换掉之后偏移量错位，执行到一半就报
# "not found" / "Unterminated quoted string"，exit 127。
# 实测：任何有版本差异的归档更新都会崩，而代码已经换好了，
# 上层 set -e 让后面的 install.sh 永不执行——仓库换了、插件没装。
#
# 解法：先把自己复制到 /tmp 再重新执行那份。这样被覆盖的是仓库里的副本，
# 正在跑的是 /tmp 里那份，不受影响。
SELF="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")"
case "$SELF" in
  "$REPO"/*)
    TMP_SELF="/tmp/dsh-purge-replace-$$.sh"
    cp "$SELF" "$TMP_SELF"
    set +e
    sh "$TMP_SELF" "$@"
    _rc=$?
    rm -f "$TMP_SELF"
    exit $_rc
    ;;
esac

if [ -z "$SRC" ] || [ -z "$REPO" ]; then
  echo "usage: sh replace-repo.sh <new-code-dir> <repo-dir>" >&2
  exit 2
fi

# 没解出东西就别动仓库：SRC 为空时 cp 会把仓库自己复制进自己，越弄越乱。
if [ ! -f "$SRC/package.json" ]; then
  echo "新代码目录里没有 package.json，已中止，仓库原样未动" >&2
  exit 3
fi
if [ ! -d "$REPO" ]; then
  echo "仓库目录不存在：$REPO" >&2
  exit 4
fi

# ── 第 ① 步：覆盖（只增不删）────────────────────────────────────────
# 逐个拷、跳过 .git 与 node_modules：直接 cp -a "$SRC/." 会把源里的 .git 也铺过去，
# 毁掉用户仓库的 git 元数据（实测过：源里放个 .git 目录，覆盖后仓库 .git/config 就变了）。
#
# 拷贝顺序有讲究：**先拷 package.json 和 lib/**，再拷其余的。
# 实测过按字母序拷时，在 0.05~0.3 秒这个区间打断，package.json 还没轮到，
# 仓库里文件有一堆、但没有 package.json —— 插件照样加载不了。
# 先拷这两个，任何时刻打断至少是「能起来、只是新功能没全」。
# 本脚本自己的路径。覆盖 $REPO/patches 时会连它一起换掉——
# 而这个文件正在被 sh 逐行读取执行，换掉之后读到的是新版本的字节偏移，
# 于是执行到一半报 "not found" / "Unterminated quoted string"，exit 127。
# 实测：任何有版本差异的归档更新都会崩，而代码已经换好了，
# 上层 set -e 让后面的 install.sh 永不执行——仓库换了、插件没装。
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

copy_one() {
  f="$1"
  [ -e "$f" ] || return 0
  b=$(basename "$f")
  [ "$b" = ".git" ] && return 0
  [ "$b" = "node_modules" ] && return 0
  cp -a "$f" "$REPO/" 2>/dev/null || cp -R "$f" "$REPO/"
}

for essential in package.json lib assets patches; do
  copy_one "$SRC/$essential"
done
for f in "$SRC"/* "$SRC"/.[!.]*; do
  b=$(basename "$f")
  case "$b" in
    package.json|lib|assets|patches) continue ;;
  esac
  copy_one "$f"
done

# ── 第 ② 步：删掉「仓库里有、新代码里没有」的 ──────────────────────
# 上游删掉或改名过的文件必须真的消失，否则新旧两套同时存在。
# 用 find 比而不是 rm -rf 整个目录：这样一条一条删，中途被打断最多少删几个，
# 不会把还没覆盖到的目录整个抹掉。
# 用户自己放在仓库根下的东西，一律不删。
#
# 为什么要有这份清单：这一步的语义是「删掉新代码里没有的、上一版留下的旧文件」，
# 但用户也会把自己的东西放在仓库根下——补丁备份 backup-*（还原补丁的唯一凭据）、
# 随手写的笔记、手工改过的 *.bak。归档更新（面板兜底 + update-archive.sh）走的就是这里，
# 之前会把它们整批 rm -rf 掉，而面板上什么提示都没有。
#
# 判据只认「看起来像用户数据」的少数几类，不扩大成「什么都不删」——
# 只要不删，上游改名/删掉的文件就会永久留在仓库里，新旧两套同时存在。
keep_user_data() {
  case "$1" in
    .git|node_modules) return 0 ;;
    backup-*|*.bak|*.orig|*.rej) return 0 ;;
    patch-probe.json) return 0 ;;
    .dsh-*|.env|.env.*) return 0 ;;
  esac
  return 1
}

# 哪些路径是「本仓库自己的文件」。
#
# 有 git 就用 git：git ls-files 列出来的，才是这个仓库跟踪过的文件；
# 凡是不在这张表里的（用户自己放的备份、笔记、临时文件），一律不碰。
# 这比按名字猜可靠得多——猜清单要么漏（用户数据被删），要么过宽（上游删掉的文件永远留着）。
#
# 没有 git（文档推荐的归档装法就没有 .git）就退回保守策略：只删带代码/文档扩展名的，
# 其余当作可能的用户数据留着，并把留下的东西打印出来让用户自己看到。
repo_tracked() {
  if [ -d "$REPO/.git" ] && command -v git >/dev/null 2>&1; then
    ( cd "$REPO" && git ls-files ) 2>/dev/null
    return 0
  fi
  return 1
}
TRACKED=""
HAS_GIT=0
# 「没有 git 一律不删」这条提示只打一次，别每个文件都念一遍
NOGIT_NOTICE=0
if TRACKED=$(repo_tracked); then
  HAS_GIT=1
fi

# 这个路径该不该删。$1 = 相对仓库根的路径
should_remove() {
  keep_user_data "$(basename "$1")" && return 1
  if [ "$HAS_GIT" = "1" ]; then
    # 精确命中：这个路径本身就是被跟踪的文件
    printf '%s\n' "$TRACKED" | grep -Fqx -- "$1" && return 0
    # 目录：git ls-files 只列文件、不列目录名，所以顶层目录名（比如 docs）永远
    # 精确匹配不上。要判「这个目录下面有没有被跟踪的文件」——有就说明它是仓库的目录，
    # 里面已经删掉的旧文件也该跟着清掉。
    # 以前没这一步，上游整个删掉/改名的目录会被当成「用户文件」永久留着。
    # 目录：问 git 这个目录下有没有被跟踪的文件，不用正则拼前缀。
    # 拼前缀的写法会被路径里的 . 坑到（.github 会匹配 xgithub/），
    # 而 git ls-files 本来就按路径前缀匹配，语义正好。
    if [ -n "$( cd "$REPO" && git ls-files -- "$1" 2>/dev/null | head -1 )" ]; then
      return 0
    fi
    return 1
  fi
  # 没有 git：**什么都不删**，只覆盖。
  #
  # 为什么不再按扩展名猜：归档解出来的仓库没有 .git（docs/install.md 自己说的），
  # 而用户往仓库根放的东西恰好都是 .md / .json / .sh——按扩展名猜等于把它们全删了。
  # 两边风险不对等：少删几个上游改名留下的旧文件，顶多是新旧两套并存；
  # 误删一次用户数据，是找不回来的。
  # 分不清就不动，把「可能残留」的东西打印出来，让用户自己决定要不要清。
  return 1
}

# 提示放在循环外：should_remove 是在 find | while 的子 shell 里跑的，
# 那里设的变量传不回父 shell，放里面会每条文件念一遍。
if [ "$HAS_GIT" != "1" ]; then
  echo "  （这个安装没有 .git，无法区分「上游删掉的旧文件」和「你自己放的文件」，一律不删）"
fi

find "$REPO" -mindepth 1 -maxdepth 1 \
  ! -name '.git' \
  ! -name 'node_modules' \
  | while IFS= read -r top; do
      bn=$(basename "$top")
      if keep_user_data "$bn"; then
        echo "  保留用户的：$bn"
        continue
      fi
      if [ ! -e "$SRC/$bn" ]; then
        # 顶层就有、新代码里完全没有
        if should_remove "$bn"; then
          echo "  删掉旧的：$bn"
          rm -rf -- "$top"
        else
          echo "  保留（不是仓库的文件）：$bn"
        fi
      elif [ -d "$top" ] && [ -d "$SRC/$bn" ]; then
        # 两边都是目录 → 逐层比，删掉新代码里没有的
        ( cd "$top" && find . -mindepth 1 | while IFS= read -r rel; do
            rel=${rel#./}
            [ -e "$SRC/$bn/$rel" ] && continue
            if should_remove "$bn/$rel"; then
              rm -rf -- "./$rel"
            else
              echo "  保留（不是仓库的文件）：$bn/$rel"
            fi
          done )
      fi
    done

echo "已覆盖到 $REPO"
