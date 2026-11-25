#!/bin/sh
# dsh-purge-go 一键安装：打补丁 + 装插件。
#
#   sh install.sh                 打补丁 + 装插件（推荐）
#   sh install.sh --plugin-only   只装插件，不打补丁（注入层生效，引擎限制仍在）
#   sh install.sh --dry           只扫描 + 预演补丁，什么都不改
#   sh install.sh --profile web   指定 profile（默认 web）
#   sh install.sh --force-dirty-backup  引擎还留着上次补丁时强行往下走（一般别用）
#   sh install.sh --no-topup      不从 npm 补老备份里缺的文件（排障用，会更容易判「备份不完整」）
#   sh install.sh --repair-native 只重建原生界面目录 + 隐藏旧胶囊（不碰补丁、不重装插件）
#
# 注意：每次更新 App（装新版 APK）都会重装引擎包、把补丁冲掉，
#       之后要重跑一次本脚本，或者跟插件说一句「重打补丁」。
set -e

# 统一用 DSH_HOME（插件侧 dshHome() 认这个），否则用户改了 DSH_HOME 时
# 备份会落在插件找不到的地方——「还原补丁」报没有备份，旧备份也不会被 prune。
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"

HERE=$(cd "$(dirname "$0")" && pwd)
PROFILE=web
MODE=full

DRY=0
FORCE_DIRTY=0
NO_TOPUP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --plugin-only) MODE=plugin; shift ;;
    # 只重建原生界面目录，补丁和插件都不碰——给被旧脚本搞坏、App 起不来的机器用
    --repair-native) MODE=repair; shift ;;
    # --dry 单独一个开关，不跟 MODE 抢变量：原来两者共用 MODE，后出现的会覆盖前面的，
    # 于是 `--dry --plugin-only` 反而会真的装插件。
    --dry)         DRY=1; shift ;;
    # 脏引擎确认强行往下走。purge-patch.mjs 的报错文案里让用户加这个参数，
    # 但本脚本以前不认它——用户照着提示敲，得到的是「不认识的参数」。
    # 现在原样透传给 CLI（CLI 那边本来就有实现）。
    --force-dirty-backup) FORCE_DIRTY=1; shift ;;
    --no-topup)    NO_TOPUP=1; shift ;;
    --profile)
      if [ -z "$2" ]; then
        printf '✖ --profile 后面要跟 profile 名（例如 web）\n' >&2; exit 1
      fi
      PROFILE=$2; shift 2 ;;
    --profile=*)   PROFILE=${1#--profile=}; shift ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) printf '✖ 不认识的参数：%s\n' "$1" >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }

# ── 读机器可读结果行 ────────────────────────────────────────────────
# purge-patch.mjs 每次结束会打一行「__RESULT__ {json}」。本脚本只看这一行判断走哪个分支。
#
# 为什么不 grep 中文提示语：原来 6 处分支靠 grep「还留着上次打的补丁」「本插件只适配过」
# 这类文案，改一句提示就静默走错，最后落到 else 说「引擎可能已被部分修改」，
# 把人吓去白重装一次引擎。这些字符串分散在 core.mjs 与 purge-patch.mjs 两个文件里，
# 改的人根本想不起另一处。
#
# 用 node 解析 JSON：以前是纯 sed，但正则 [^,}]* 遇到值里带逗号（错误消息）就会截断。
# 现在只读 kind/applied 这类原子值，碰不上，但契约上是脆的——换成真解析把这条路封掉。
# 用法：result_field "$OUT" kind
result_field() {
  # 用 node 解析 JSON，不用 sed 抠字段：sed 那版的正则是 [^,}]*，值里一旦带逗号
  # （比如错误消息）或嵌套对象就会截断。现在只读 kind/applied/clean 三个原子值，
  # 碰不上，但契约上是脆的——换 node 解析只多几十毫秒，把这条路彻底封掉。
  # JSON 解析失败就返回空串，调用方的 [ "$x" = "xxx" ] 自然落到 else 分支，不会误判。
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (d) => { s += d })
    process.stdin.on("end", () => {
      const line = s.split("\n").filter((l) => l.startsWith("__RESULT__ ")).pop()
      if (!line) return
      try {
        const v = JSON.parse(line.slice(11))[process.argv[1]]
        if (v !== undefined && v !== null) process.stdout.write(String(v))
      } catch {}
    })
  ' "$2"
}
# --dry 是「只看不改」，--plugin-only 是「只装插件不打补丁」，两个一起给没有意义，
# 而且会让调用者以为拿到的是预演结果。直接拒绝，别让顺序决定行为。
# 原来只挡了 --plugin-only，漏了 --repair-native：那两个模式下 --dry 会被完全忽略，
# 实测会真建 $HOME/.dsh/dsh-go/plugins 全量目录、真写 ui.json，还 exit 0 不报警。
if [ "$DRY" = "1" ] && [ "$MODE" != "full" ]; then
  printf '✖ --dry 只能单独用：--plugin-only 会真装插件，--repair-native 会真写原生目录，都不适合预演\n' >&2
  exit 1
fi
# 失败时统一提示一句怎么反馈——用户这时候最需要知道找谁。
die() {
  printf '✖ %s\n' "$*" >&2
  printf '\n  自查没用的话，把上面这段输出贴到：\n' >&2
  printf '    https://github.com/NANA7MI0/dsh-purge-go/issues\n' >&2
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

if [ "$MODE" != "repair" ]; then
# ── 第 1 步：打补丁（放在最前，因为它只改文件、不触发宿主重新装配）────
if [ "$MODE" = "plugin" ]; then
    say "▸ 已跳过补丁层（--plugin-only）"
    say ""
    say "  本次只装插件：审批与沙箱两个配置项保持原样。"
    say "    想补上：cd $HERE && sh install.sh"
    say ""
else
    if [ "$DRY" = "1" ]; then
      say "▸ 预演模式：只扫描 + 预演补丁"
      say "  不装插件、不改任何文件。"
    else
      say "▸ 第 1 步 / 4：打补丁到引擎包"
    fi
    say ""

    say "  扫描中 …"
    # --dry 时 probe 结果写到临时目录，别往仓库里留文件（见下面的「什么都没改」）
    if [ "$DRY" = "1" ]; then
      # 记一下这个临时目录，退出时清掉——不加这句每跑一次 --dry 就在 /tmp 留个空目录。
      PROBE_TMP=$(mktemp -d)
      PROBE_OUT_PATH="$PROBE_TMP/patch-probe.json"
      trap 'rm -rf "$PROBE_TMP"' EXIT
    else
      PROBE_OUT_PATH="$HERE/patch-probe.json"
    fi
    if ! PROBE_OUT=$(node patches/purge-patch.mjs probe --out "$PROBE_OUT_PATH" 2>&1); then
      say "$PROBE_OUT" | grep -v '^__RESULT__ ' | sed 's/^/  /'
      die "probe 失败。"
    fi
    say "$PROBE_OUT" | grep -E '^tally:' | grep -v '^__RESULT__ ' | sed 's/^/  /' || true
    say ""

    if [ "$DRY" = "1" ]; then
      # 不能 node ... | sed 然后无条件报成功：if 看的是 sed 的退出码，恒 0，
      # 补丁预演炸了也照样印「预演完成」。先收输出、按 node 自己的退出码判。
      # --out 指到临时文件：probe 默认写 <cwd>/patch-probe.json，而 --dry 承诺「什么都没改」，
      # 往仓库里扔一个 16 KB 的文件会让这句承诺变成假话
      DRY_TMP="/tmp/dsh-purge-dry-$$.json"
      # 退出前删掉临时文件：--dry 承诺「什么都没改」，留个 16 KB 的 json 在 /tmp
      # 虽然不影响仓库，但反复调试会攒一堆。trap 保底，正常路径也删。
      trap 'rm -f "$DRY_TMP" 2>/dev/null || true' EXIT INT TERM
      if DRY_OUT=$(node patches/purge-patch.mjs apply --dry --out "$DRY_TMP" 2>&1); then
        rm -f "$DRY_TMP" 2>/dev/null || true
        printf '%s\n' "$DRY_OUT" | grep -v '^__RESULT__ ' | sed 's/^/  /'
        say ""
        say "  ✔ 预演完成，什么都没改。"
        say "  真安装请去掉 --dry 重跑：sh install.sh"
        say ""
        exit 0
      else
        printf '%s\n' "$DRY_OUT" | grep -v '^__RESULT__ ' | sed 's/^/  /'
        # 版本没适配也会让 --dry 返回非 0，那不是「预演失败」，是「明确告诉你打不了」，
        # 两者对用户的意思完全不同：前者要查，后者只要等。先分流。
        if [ "$(result_field "$DRY_OUT" kind)" = "engine_unsupported" ]; then
          die "引擎版本本插件还没适配，所以预演也打不了。这不是故障——等插件发新版适配即可。"
        fi
        if [ "$(result_field "$DRY_OUT" kind)" = "dirty_engine" ]; then
          die "引擎里还留着上次打的补丁。这个状态下真装会跳过补丁层（不是预演失败）——先重装引擎包，再跑一次。"
        fi
        die "预演本身失败了（上面的输出里有原因）。这不是「什么都没改」，是没能判断该改什么。"
      fi
    fi

    # 备份统一放到插件自己的目录：~/.dsh/dsh-purge/patch-backup/<时间戳>
    # 不传 --backup 的话 CLI 会建在仓库目录（backup-<时间戳>），插件的「还原补丁」
    # 就找不到——第一次安装的人点了只会看到「没有可还原的补丁备份」。
    # 加毫秒随机后缀，避免同一秒内重跑覆盖上一份真备份
    # 用 UTC（date -u）与 CLI／插件保持一致：那两处都是 toISOString()。
    # 混用本地时间会让目录名排序错乱——本地比 UTC 快 8 小时，
    # 「19:45 本地」会排到「12:38 UTC」后面，而后者其实更新。
    BACKUP_DIR="$DSH_ROOT/dsh-purge/patch-backup/$(date -u +%Y%m%d%H%M%S)-$$"
    # 加 || die：set -e 下不可写时脚本会无声退出（一句提示都没有），
    # 用户只看到「什么都没发生」。写不了备份就该明确说，因为没备份就没法还原。
    mkdir -p "$BACKUP_DIR" || die "建不了备份目录 $BACKUP_DIR（磁盘满或没有写权限）。补丁层没打，先解决这个再重跑。"
    # 不能写成 `if node ... | sed`：if 看的是管道最后一个命令（sed）的退出码，
    # sed 恒返回 0，于是补丁全失败也照样打印「✔ 补丁已打上」并以 0 退出。
    # 先把输出收进变量、按 node 自己的退出码判断，再决定要不要打印。
    # 透传两个开关：CLI 的报错文案里提到过它们，脚本不认就等于提示无效。
    APPLY_ARGS=""
    [ "$FORCE_DIRTY" = "1" ] && APPLY_ARGS="$APPLY_ARGS --force-dirty-backup"
    [ "$NO_TOPUP" = "1" ] && APPLY_ARGS="$APPLY_ARGS --no-topup"
    # shellcheck disable=SC2086
    if APPLY_OUT=$(node patches/purge-patch.mjs apply --backup "$BACKUP_DIR" $APPLY_ARGS 2>&1); then
      printf '%s\n' "$APPLY_OUT" | grep -v '^__RESULT__ ' | sed 's/^/  /'
      # applied 是「这次改了几个文件」。为 0 说明一条都没新打（引擎已是全打上的状态、
      # 或这批补丁都对不上）——这时报「✔ 补丁已打上」并列出刚 mkdir 出来的空目录，
      # 用户之后点「还原补丁」只会撞一个没有 manifest 的空壳。所以要分开说。
      # 末尾的 || true 不能省：set -e 下 grep 没匹配会返回 1，整条赋值失败 → 脚本静默退出，
      # 下面的「取不到数」分支根本走不到，用户只会看到命令无声结束。
      # 从结果行读，不再 grep 日志文本——「applied N file」这句以后改措辞就失效了，
      # 和这次统一 __RESULT__ 是同一件事。
      APPLIED_N=$(result_field "$APPLY_OUT" applied)
      # 取不到数字（输出格式变了、或压根没有 applied 行）与「真的是 0」必须分开：
      # 前者是「不知道」，绝不能当成 0 去删备份。
      # APPLIED_N 为空 = 没打出 applied N file 行（最常见的原因就是一条都没打，
      # core.apply 早返回只印 nothing to apply）；为 0 = 打了 0 个。
      # 两者的区分只在「有没有 manifest.json」：没有就是 mkdir 出来的空壳，
      # 不能当备份报出去——用户照着它还原只会撞 no files/。
      if [ -z "$APPLIED_N" ] || [ "$APPLIED_N" = "0" ]; then
        if [ -f "$BACKUP_DIR/manifest.json" ]; then
          # 有 manifest：里面是当前磁盘文件的副本（此刻已是原始状态），是有效快照，留着。
          if [ -z "$APPLIED_N" ]; then
            say "  ? 没能从输出里读出改了几个文件——按原样保留这次建的备份，自己看一眼上面的日志"
          else
            say "  ✔ 补丁层已是最新（这次没有需要新打的）"
          fi
          say "    备份：$BACKUP_DIR（存的是当前原始文件）"
        else
          # 空壳：删掉它，把 BACKUP_DIR 指回上一份真备份（有的话）。
          # 空值保护不能省：$BACKUP_DIR 为空时 rmdir "" 会被当成 rmdir /。
          [ -n "$BACKUP_DIR" ] && rmdir "$BACKUP_DIR" 2>/dev/null || true
          # 只挑有 manifest 的：历史失败可能留下空壳目录，选中它等于把空目录报成备份，
          # 用户照抄下面那条 restore 命令只会撞 no files/。
          PREV_BK=""
          for d in $(ls -dt "$DSH_ROOT"/dsh-purge/patch-backup/* 2>/dev/null); do
            if [ -f "$d/manifest.json" ]; then PREV_BK="$d"; break; fi
          done
          BACKUP_DIR="${PREV_BK:-}"
          say "  ✔ 补丁层已是最新（这次没有需要新打的）"
          if [ -n "$BACKUP_DIR" ]; then
            say "    备份：$BACKUP_DIR"
          else
            say "    （这次没有新建备份，也没有历史备份）"
          fi
        fi
      else
        say "  ✔ 补丁已打上（$APPLIED_N 个文件）"
        say "    备份：$BACKUP_DIR"
        say "    （面板上的「还原补丁」用的就是这里）"
      fi
    else
      printf '%s\n' "$APPLY_OUT" | grep -v '^__RESULT__ ' | sed 's/^/  /'
      # 这次 mkdir 出来的目录如果是空壳（apply 在写 manifest 之前就失败了），删掉。
      # 留着的话：下次 realBackup()/findReusableBackup() 会挑到「最新的一份」，
      # 而那里面没有 manifest，读失败——实测把整条「先还原再重打」卡死过一次。
      if [ -n "$BACKUP_DIR" ] && [ ! -f "$BACKUP_DIR/manifest.json" ]; then
        rmdir "$BACKUP_DIR" 2>/dev/null || true
      fi
      # 三种情况分开说，判序不能反：
      #   ① 回滚没滚干净 → 半截状态，最严重，先判，否则会被下面两支误说成「干净」。
      #   ② 干净回滚 —— 两种来源都算：前置的 prerestore（插件侧文案「已还原到原始状态」）
      #      与 core.apply 自己的「校验失败自动全量回滚」（文案 "rolled back: all files restored"）。
      #      首次安装或备份版本不符时压根没有 prerestore，只剩后者——只认前者会把
      #      「干净回滚」错报成「引擎可能已被部分修改」，把人吓去重装引擎。
      #   ③ 都没有 → 可能真停在半截。
      #   ⓿ 引擎版本没适配 → 一个字节都没动，别按「半截」吓人。
      #      core.apply 的版本门在任何写操作之前就返回，这个分支必须先判，
      #      否则会落到最后一个 else 说「引擎包可能已被部分修改」，用户会去白重装一次引擎。
      if [ "$(result_field "$APPLY_OUT" kind)" = "engine_unsupported" ]; then
        die "补丁没打上：当前引擎版本本插件还没适配，一个文件都没动（引擎完好）。等插件发新版适配，别强行重装去试。看上面那句里的版本号。"
      elif [ "$(result_field "$APPLY_OUT" kind)" = "dirty_engine" ]; then
        # 脏引擎：引擎里还有上次打的补丁，所以拒绝把它存成「原始状态」。
        # 这个场景**必须重装引擎包**——不重装永远建不出干净备份，补丁永远打不上。
        # 不能并到下面「不用重装」那支里（第十九轮实测：那样上下两行互相打架，
        # 而 die 还会让后面的插件安装整段不执行，用户连插件都装不上）。
        # 这里不死掉：补丁层跳过，接着把插件装上——插件本身不依赖补丁。
        say ""
        say "  ⚠ 补丁层跳过：引擎里还留着上次打的补丁，不能把它存成原始状态。"
        say "    插件照常装好，破甲能用的部分（提示词注入）不受影响。"
        say "    想把补丁也打上：先重装引擎包（见 README 第 6 章），再跑一次本脚本。"
        say ""
        APPLY_SKIPPED=1
        # 收尾不要再报这次那个目录：它刚被 rmdir 掉（apply 在写 manifest 前就退了），
        # 报出来的路径不存在，下面那条 restore 跑起来必然失败。
        #
        # 也不用回扫历史备份：能走到这个分支，就说明 purge-patch.mjs apply 的
        # 「先还原再重打」那一步已经用 findReusableBackup 找过一遍、拿到了 null
        # （拿到非 null 它会先还原，根本不会脏着继续）。同一个函数、同样的参数、
        # 同一个时刻，这里再查一次必然是 null——那是段死查询，白扫 0.3～0.45 秒。
        BACKUP_DIR=""
      elif [ "$(result_field "$APPLY_OUT" kind)" = "incomplete_backup" ]; then
        # 备份缺文件：一个字节都没动，但**出路是重装**（CLI 那句第一选项就是重装）。
        # 不能跟下面「不用重装」混在一支——第二十轮实测：照「删备份重跑」做，
        # 删完立刻落到脏引擎分支再要求重装，白跑一轮。
        die "补丁没打上：一个字节都没动（引擎完好）。这份备份缺文件，删掉它重跑也行，但更省事的是直接重装引擎包（见 README 第 6 章），然后重跑本脚本。"
      elif [ "$(result_field "$APPLY_OUT" kind)" = "restore_partial" ]; then
        # 还原到一半出错：core.restore 逐文件复制，前面的已经写回去了，引擎不确定是否完好。
        # 这里**必须**让人重装——说成「一个字节都没动」会让人带着半截引擎继续用。
        die "补丁没打上，而且这次是「还原到一半出的错」——引擎可能停在半截状态（一部分原始、一部分还是打过补丁的）。先别重启，按 README 第 6 章重装引擎包，再重跑本脚本。"
      elif [ "$(result_field "$APPLY_OUT" kind)" = "rollback_incomplete" ]; then
        die "补丁打了一半、回滚也没滚干净——引擎可能已是半截状态，App 可能起不来。别重启，先看上面的日志，必要时重装引擎包。"
      elif [ "$(result_field "$APPLY_OUT" kind)" = "apply_failed" ]; then
        # core.apply 自己抛了异常，没走到回滚那套逻辑。说不准改了没有，按最坏的说。
        die "打补丁时程序出错了，没能确认引擎有没有被改。先跑 sh install.sh --dry 看当前状态；还是不对劲就按 README 第 6 章重装引擎包。"
      elif [ "$(result_field "$APPLY_OUT" kind)" = "no_root" ]; then
        # 找不到引擎目录：一个字节都没动，重装引擎包也不解决——根本没找到要改哪儿。
        die "找不到引擎目录（/opt/dsh/node_modules/@deepseek-ai 之类）。这不是引擎坏了，是这个插件没装上或装到别处了；先重装 App 或确认引擎版本，再跑本脚本。"
      elif [ "$(result_field "$APPLY_OUT" clean)" = "true" ]; then
        # clean=true 表示引擎现在是干净的原始状态（要么打之前还原过、要么 core 全量回滚成功）。
        # 以前这里还让用户自己去日志里找「rolled back」，等于没结论。
        die "补丁没打上，但引擎是干净的原始状态，不用重装。跑 sh install.sh --dry 看是哪条打不上；要还是不行，来提 issue（附上 --dry 的输出）。"
      else
        die "打补丁失败，且没能确认回滚干净——引擎包可能已被部分修改。跑 sh install.sh --dry 看状态，或查 patch-probe.json。"
      fi
    fi
    say ""
fi

fi

# ── 第 2 步：原生界面目录（只有 dsh-go 手机端需要）─────────────────
# dsh-go 的原生插件（输入框上方的胶囊、状态条、面板）不在 profile 里，
# 而是在 $HOME/.dsh/dsh-go/plugins/<包名>/ —— 那一层 app 自己扫，dsh plugin add 不管。
# 不建这个目录，装完没有胶囊、没有面板，README 里让你「点胶囊」就成了空话。
#
# 为什么排在装插件之前：建目录是纯文件操作、不会被打断；装插件是整条流程里唯一
# 可能掐断命令的步骤。顺序反过来会出现「插件装上了、目录没建」——用户拿到一个
# 既没有胶囊也没有面板的插件，连点哪儿修都找不到。
#
# 这里出过一次严重事故：老实现是 rm -rf 然后逐个 ln，中途失败就留下一个残缺目录。
# App 启动时逐个读这个目录里的文件，读不到 LICENSE 就把整个 runtime 拉黑、
# 连安全模式都起不来（safe mode 只换 profile，这一层是全局扫的）。
# 所以下面改成「先建到 .tmp、逐个校验、全部通过再整体换」：
#   ① 任何一个文件建好读不到，就整批放弃，旧目录原样不动；
#   ② 换上去用 mv（同一文件系统内是原子操作），不留下半截状态；
#   ③ 源目录落在 /tmp 这类临时位置时改为复制——否则临时目录一清，软链全部悬空。
if [ -f /etc/dsh-app/runtime.json ]; then
  NATIVE="$DSH_ROOT/dsh-go/plugins/dsh-go-purge"
  NEW="$NATIVE.tmp.$$"
  OLD="$NATIVE.old.$$"
  say "▸ 第 2 步 / 4：建原生界面目录"
  say "  $NATIVE"
  say ""

  # 一律复制，不做软链。
  #
  # 以前的实现是软链到仓库——好处是 git pull 之后插件自动就是新的。
  # 代价太大：仓库目录一被删/一被移走，11 条软链全悬空，App 启动时读不到
  # LICENSE 就把整个 runtime 拉黑，侧边栏全灰、App 内终端点不开，
  # 普通用户唯一的出路是重装 App，历史对话全丢。
  # 复制只需要 1.1 MB，换来的是「仓库没了也照常启动」。

  rm -rf "$NEW"
  mkdir -p "$NEW" || die "建不了临时目录：$NEW"
  LINKED=0
  FAILED=""
  # 清单里不放 assets：那份明文只在本机开发时用（改分类要从它 embed 出密文），
  # 运行时读的是 lib/categories-table.json，明文不进 git 也不进 npm 包。
  # 以前把它列成必需项，全新 clone 和 npm 包里都没有它，第 2 步会直接 die。
  for f in LICENSE NOTICE README.md CHANGELOG.md cordis.patch.yml docs install.sh lib patches package.json; do
    if [ ! -e "$HERE/$f" ]; then
      FAILED="$FAILED $f(源里没有)"
      continue
    fi
    # 不能 `cp ... 2>/dev/null`：set -e 下 cp 一失败就整个脚本静默退出（stderr 还被吞了），
    # 用户只看到输出停在「第 2 步 / 4」，不知道发生了什么，还留下 .tmp.<pid> 残骸。
    # 用 if 兜住，失败记进 FAILED 继续下一项，最后统一报。
    if ! cp -R "$HERE/$f" "$NEW/$f" 2>/dev/null; then
      FAILED="$FAILED $f(复制失败)"
      continue
    fi
    if [ -r "$NEW/$f" ]; then
      LINKED=$((LINKED+1))
    else
      FAILED="$FAILED $f(建好读不到)"
    fi
  done

  if [ -n "$FAILED" ]; then
    rm -rf "$NEW"
    say "  ⚠ 这些没弄好：$FAILED"
    say "  ⚠ 已经放弃替换，原来的 $NATIVE 一点没动"
    die "第 2 步失败，原生目录保持原样"
  fi

  if [ -e "$NATIVE" ]; then
    mv "$NATIVE" "$OLD" || { rm -rf "$NEW"; die "挪不开旧目录，已放弃替换"; }
  fi
  if ! mv "$NEW" "$NATIVE"; then
    [ -e "$OLD" ] && mv "$OLD" "$NATIVE"
    rm -rf "$NEW"
    die "替换原生目录失败，已还原"
  fi
  rm -rf "$OLD"

  say "  ✔ $LINKED 项就位（复制，共约 1.1 MB）"
  say ""
  say "  这里是一份完整副本，不是指向仓库的快捷方式——仓库以后被删、被移走，"
  say "  这个目录仍然完整，App 照常启动。代价是 git pull 之后要再同步一次；"
  say "  点面板上的「更新」会自动做这件事。"
  say ""
else
  say "（这台机器没有 dsh-go 桥接，跳过原生界面目录）"
  say ""
fi

# ── 第 3 步：隐藏 App 自带的「插件」胶囊 ────────────────────────────
# 装完插件后输入框上方会出现两颗：本插件的「破甲状态」，和 App 自带的「插件」入口。
# 本仓库只有一个插件，那颗入口点进去就是这个面板——功能重复，还容易让人以为有两套。
# dsh-go 的 ui.json 支持隐藏指定元素。这里只往 hide 数组里追加一项：
# 用户自己配的其它项原样保留，已经有就不重复加。
if [ -f /etc/dsh-app/runtime.json ]; then
  say "▸ 第 3 步 / 4：隐藏 App 自带的「插件」胶囊"
  UI_JSON="$DSH_ROOT/dsh-go/ui.json"
  UI_RESULT=$(node -e '
    const fs = require("fs"), p = process.argv[1]
    let j = { version: 1 }
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"))
      // 合法 JSON 也可能是 null / 数组 / 字符串——直接当对象用会抛 TypeError，
      // 而外层 || UI_RESULT=skip 会把它说成「已经隐藏过了」，用户看到的是「跳过」，
      // 实际什么都没写成。
      j = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : { version: 1 }
    } catch (error) {
      // 文件存在但解析不了：先留一份原文再重建，别把用户别的配置弄丢
      try {
        if (require("fs").existsSync(p)) require("fs").copyFileSync(p, p + ".bak")
      } catch {}
    }
    if (!Array.isArray(j.hide)) j.hide = []
    if (j.hide.includes("pluginCapsule")) { console.log("skip") }
    else {
      j.hide.push("pluginCapsule")
      require("fs").mkdirSync(require("path").dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n")
      console.log("added")
    }
  ' "$UI_JSON" 2>/dev/null) || UI_RESULT=failed
  case "$UI_RESULT" in
    added) say "  ✔ 已写进 $UI_JSON（重启 App 后生效，其余隐藏项原样保留）" ;;
    skip)  say "  · 已经隐藏过了，跳过" ;;
    # 写失败也报「已经隐藏过了」会让人以为没事：那颗胶囊还在，配置一个字没动。
    *)     say "  ⚠ 写不进 $UI_JSON，隐藏没生效（那颗「插件」胶囊还会在）" ;;
  esac
  say ""
fi

if [ "$MODE" != "repair" ]; then
# ── 第 4 步：装插件（放最后，它会触发宿主重新装配插件层）──────────
# repair 模式到这就结束：只重建原生目录，不动补丁和插件。
say "▸ 第 4 步 / 4：装插件到 profile「$PROFILE」"
say "  $HERE"
say ""
# 旧版引擎上这一步会把正在执行的那条命令掐掉（Error: tool call aborted）。
# 现在实测不再发生；但顺序仍保持「先补丁后插件」，万一某台机器还会打断，
# 补丁早已落地，被打断的只是收尾输出。
say "  这一步会让宿主重新装配插件层。"
say ""

# 不能写成 `if dsh ... | sed`：if 看的是管道最后一条（sed）的退出码，恒 0，
# 于是插件根本没装上也会报「✔ 插件已装入」并 exit 0——用户拿到一个空插件却以为装好了。
# 与上面补丁那段是同一个坑：先把输出收进变量、按 dsh 自己的退出码判断。
if PLUGIN_OUT=$(dsh plugin --profile "$PROFILE" add "$HERE" 2>&1); then
  printf '%s\n' "$PLUGIN_OUT" | grep -v '^__RESULT__ ' | sed 's/^/  /'
  say "  ✔ 插件已装入"
  PLUGIN_OK=1
else
  printf '%s\n' "$PLUGIN_OUT" | grep -v '^__RESULT__ ' | sed 's/^/  /'
  # 返回非零不一定是真失败。实测最常见的原因是 dsh-atomic-write 的写锁超时
  # （另一个进程正持有锁，pnpm add 拿不到），而依赖其实已经写进 profile 了。
  # 与其让用户自己去敲命令核对，不如这里直接读一次 profile。
  # 读的是「本次装的 profile」，不是写死的 web：加了 --profile other 时读错目录，
  # 会把「装配失败但依赖已在 other 里」误判成「真没装上」，让用户白重装一遍。
  # 只看 dependencies 不够：插件要真正被加载，还得在 dsh.profile.bundles 里。
  # 只写了 dependencies 而 bundles 里没有时，重启 App 也不会装配它——
  # 用户看到「装好了」，打开面板却什么都没有。两个都在才算装上了。
  DEP_LINE=$(DSH_PROFILE_CHECK="$PROFILE" node -e '
    try {
      const h = (process.env.DSH_HOME || process.env.HOME + "/.dsh")
      const j = require(h + "/profiles/" + process.env.DSH_PROFILE_CHECK + "/package.json")
      const v = j && j.dependencies && j.dependencies["dsh-go-purge"]
      const bundles = (j && j.dsh && j.dsh.profile && j.dsh.profile.bundles) || []
      const listed = Array.isArray(bundles) && bundles.includes("dsh-go-purge")
      if (v && listed) process.stdout.write(String(v))
    } catch {}
  ' 2>/dev/null) || DEP_LINE=""
  say ""
  if [ -n "$DEP_LINE" ]; then
    # 装上了：装配那一步被锁挡了，重启后生效。别让用户去重装。
    say "  ⚠ 装配那一步失败了（多半是写锁超时），但插件已经在 profile 里（$DEP_LINE）"
    say "    重启 App 一次让它装配上，不用重跑本脚本。"
    PLUGIN_OK=1
  else
    PLUGIN_FAILED=1
    say "  ⚠ dsh plugin add 失败了，profile 里也确实没有——真没装上。"
    say "    常见原因是另一个进程正占着写锁。等十几秒重跑一次：cd $HERE && sh install.sh"
  fi
  say ""
fi

fi

# ── 收尾 ────────────────────────────────────────────────────────
say ""
say "════════════════════════════════════════"
# dsh plugin add 返回非零时不能还说「装好了」——那时插件可能压根没装上，
# 用户拿着一个空插件去重启、打开面板发现什么都没有，只能猜。
if [ "$MODE" = "repair" ]; then
  # repair 根本不装插件，PLUGIN_OK 永远为空。以前会打出「装完了，但插件是否装上没确认」，
  # 等于在说一件这次没做的事。
  say " 原生界面目录修好了"
elif [ "${PLUGIN_OK:-0}" = "1" ]; then
  say " 装好了"
else
  # 返回非零不等于没装上（旧版上装配会掐断命令），所以这里不能断言失败——
  # 上面那段已经给了核对命令，这里跟着说「状态未知」，别自己打自己脸。
  say " 装完了，但插件是否装上没确认"
fi
say "════════════════════════════════════════"
say ""
if [ "$MODE" = "repair" ]; then
  # 同上：不做的事就别报状态。
  say "  注入层  — 本次没动（--repair-native 不碰插件）"
elif [ "${PLUGIN_OK:-0}" = "1" ]; then
  say "  注入层  ✔ 插件加载时自动落盘正文并开启"
elif [ "${PLUGIN_FAILED:-0}" = "1" ]; then
  say "  注入层  ✖ 插件没装上，注入层不会生效"
  say "           等十几秒重跑一次：cd $HERE && sh install.sh"
else
  say "  注入层  ? 取决于插件有没有真装上——按上面的提示处理"
fi
# 收尾这句必须跟上面实际做的事一致：
#   --plugin-only        → 本来就没打
#   脏引擎跳过（SKIPPED） → 走到这里是因为拒绝把已打补丁的引擎存成原始状态
#   其余                 → 正常打上了
if [ "$MODE" = "repair" ]; then
  # --repair-native 本来就不碰补丁：这里报「已打到引擎包」是假的，用户会以为补丁是新的。
  say "  补丁层  — 本次没动（--repair-native 只重建原生界面目录）"
elif [ "$MODE" = "plugin" ]; then
  say "  补丁层  ✖ 没打（本次用了 --plugin-only）"
  say "           想补上就跑：cd $HERE && sh install.sh"
elif [ "${APPLY_SKIPPED:-}" = "1" ]; then
  say "  补丁层  ✖ 跳过（引擎里还留着上次打的补丁）"
  say "           先重装引擎包（见 README 第 6 章），再跑一次本脚本"
else
  say "  补丁层  ✔ 已打到引擎包"
fi
say ""
# 补丁没打上（或跳过）时说「让补丁生效」是空的——重启也不会有效果。
if [ "$MODE" = "repair" ]; then
  # 这条分支以前漏了：上面刚说「补丁层本次没动」，这里又说「重启让补丁生效」，
  # 用户当场就能看出自相矛盾。repair 做的是重建原生界面目录，重启是为了让它生效。
  say "▸ 最后一步：重启 App 让原生界面重建生效"
  say ""
  say "  （这次没打补丁，重启不会改变补丁层）"
elif [ "$MODE" = "plugin" ]; then
  # --plugin-only 时引擎是干净的、只是这次没打。不能说「要先重装引擎包」——
  # 那和上面「想补上就跑 sh install.sh」当面打架，而且重装引擎纯属多余。
  say "▸ 最后一步：重启引擎让插件生效"
  say ""
  say "  （补丁层这次没打，重启只让插件生效；想打补丁就重跑一次本脚本；这个模式没检查引擎状态）"
elif [ "${APPLY_SKIPPED:-}" = "1" ]; then
  say "▸ 最后一步：重启引擎让插件生效"
  say ""
  say "  （补丁层这次跳过了，重启只让插件生效——那部分要先重装引擎包再跑一次）"
else
  say "▸ 最后一步：重启引擎让补丁生效"
fi
say ""
say "  从屏幕最底下往上划一下，调出「最近任务」；"
say "  把这个 App 的卡片往上划掉，再点图标打开。"
say ""
say "  关键是「划掉」——只按返回键退到桌面不算，"
if [ "$MODE" = "repair" ]; then
  say "  那样 App 还在后台跑，重建的原生界面不会生效。"
elif [ "$MODE" = "plugin" ] || [ "${APPLY_SKIPPED:-}" = "1" ]; then
  say "  那样界面收起来了、引擎还在后台跑，插件不会重新装配。"
else
  say "  那样界面收起来了、引擎还在后台跑，补丁不生效。"
fi
say ""
say "  没有别的办法：am 这类 Android 命令在 proot 里跑不了，"
say "  划掉 App 是唯一可靠的重启方式。"
say ""
say "▸ 记住一件事"
say "  以后每次更新 App 都会重装引擎包、把补丁冲掉。"
say "  到时候重跑一次本脚本，或者跟插件说一句「重打补丁」。"
say ""
say "▸ 想撤销"
if [ -n "$BACKUP_DIR" ]; then
  say "  本次的补丁备份在：$BACKUP_DIR"
  say "  命令行撤销：node patches/purge-patch.mjs restore --backup \"$BACKUP_DIR\""
  say "  或者直接点面板上的「还原补丁」。"
else
  say "  本次没打补丁，所以没有新备份（历史备份不受影响，还在原地）。"
fi
say ""

