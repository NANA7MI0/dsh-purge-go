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
find "$REPO" -mindepth 1 -maxdepth 1 \
  ! -name '.git' \
  ! -name 'node_modules' \
  | while IFS= read -r top; do
      bn=$(basename "$top")
      if [ ! -e "$SRC/$bn" ]; then
        # 顶层就有、新代码里完全没有 → 整个删
        rm -rf "$top"
      elif [ -d "$top" ] && [ -d "$SRC/$bn" ]; then
        # 两边都是目录 → 逐层比，删掉新代码里没有的
        ( cd "$top" && find . -mindepth 1 | while IFS= read -r rel; do
            [ -e "$SRC/$bn/$rel" ] || rm -rf "./$rel"
          done )
      fi
    done

echo "已覆盖到 $REPO"
