#!/usr/bin/env node
/**
 * purge-patch - probe / apply / restore dsh-purge host source patches.
 *
 *   node patches/purge-patch.mjs probe   [--root <node_modules/@deepseek-ai>]
 *   node patches/purge-patch.mjs apply   [--root ...] [--backup <dir>] [--dry]
 *   node patches/purge-patch.mjs restore --backup <dir>
 *
 * The patch table is patches/patches.json (exported from dsh-purge).
 * Every edit is an exact string replacement; a file that fails node --check
 * after editing is restored from the backup automatically.
 *
 * 实现已拆到 lib/core.mjs：本文件只负责解析 argv、调用、打印。
 * 拆分原因：面板与工具要复用同一份逻辑，而 CLI 脚本 import 即执行、
 * 且用 process.exit 结束进程，无法被库调用。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "./lib/core.mjs";
// 面板和 CLI 必须走同一套「先还原再重打」的逻辑，否则两条路行为分叉：
// 用户点按钮是一个结果，跑 install.sh 是另一个结果，出问题永远查不清。
import { findReusableBackup, pruneOtherBackups, hasPatchTraces, enginePatched, missingBackupFiles } from "../lib/ops.js";
import { dshHome } from "../lib/home.js";
// 补备份要用它：面板路径（update-worker）和 CLI 必须做同样的事，否则两条路行为分叉。
import { prepareBackup } from "../lib/prepare.js";

const argv = process.argv.slice(2);
const cmd = argv[0] || "probe";
const flag = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes("--" + n);

// 机器可读结果行：install.sh 读这一行决定走哪个分支，不再 grep 中文提示语。
// 起因：install.sh 原来靠 grep「还留着上次打的补丁」「本插件只适配过」这类文案判分支，
// 改一句提示词就静默走错，最后落到 else 说「引擎可能已被部分修改」，把人吓去重装。
// 格式固定成一行，前缀 __RESULT__，后面是 JSON；人看的输出照旧走 stdout。
function emit(obj) {
  // 走 stderr：stdout 是给用户看的正文，机器行不该混进去。
  // install.sh 用 2>&1 收输出，所以照样读得到。
  //
  // 必须同步写（writeSync 而不是 console.error）：下面的 fail() 紧接着就 process.exit(1)，
  // 而 stderr 被管道接住时是异步刷的，退出太快这一行会丢——丢了 install.sh 就取到空 kind，
  // 静默落到最后一个分支说「引擎可能已被部分修改」，比不改还糟。
  const line = "__RESULT__ " + JSON.stringify(obj) + "\n";
  try {
    fs.writeSync(2, line);
  } catch {
    console.error(line.trimEnd());
  }
}

/**
 * 中止并带上机器可读的 kind。
 * kind 取值见 docs/patches.md「退出码与 kind」；新增时同步 install.sh 的分支。
 */
function fail(msg, kind) {
  // 同样要同步写：紧接着就 exit，异步的 console.error 在管道模式下可能整条丢，
  // 于是用户看到的是「一行输出都没有、退出码 1」——比报错本身更让人摸不着头脑。
  try {
    fs.writeSync(2, "error: " + msg + "\n");
  } catch {
    console.error("error: " + msg);
  }
  emit({ ok: false, kind: kind || "error", message: msg });
  process.exit(1);
}

let root;
try {
  root = core.detectRoot(flag("root"));
} catch (err) {
  fail(err.message, "no_root");
}

if (cmd === "probe") {
  const rows = core.probe(root);
  console.log("root: " + root);
  console.log("tally: " + JSON.stringify(core.tally(rows)));
  const NL = String.fromCharCode(10);
  const NOTE = {
    partial:
      "  要具体看，不能一概当正常。" + NL +
      "  partial 的意思是「这条补丁还有几处没改到位」，不是「已经生效」。" + NL +
      "  看下面每条括号里的 (没改到/总数)：小说明大部分改好了，接近总数说明基本没打上。",
    miss:
      "  一条都对不上：引擎里这段代码已经改了样子，或这条只管桌面端。" + NL +
      "  不影响手机端的破甲能力。",
    hit: "  全部匹配，可以打（跑 apply）。",
    applied: "  已经打过了。",
    no_needle: "  补丁数据里 pattern 为空或不可用，数据残缺。",
    no_pkg: "  目标包在手机引擎里不存在，改的是手机上没装的代码。",
    no_file: "  目标文件不存在。",
  };
  for (const st of ["hit", "partial", "applied", "miss", "no_file", "no_needle", "no_pkg"]) {
    const g = rows.filter((r) => r.status === st);
    if (!g.length) continue;
    console.log("\n# " + st + " (" + g.length + ")");
    if (NOTE[st]) console.log(NOTE[st]);
    // applied 通常是几十条，逐条列只会刷屏——只报数量。
    if (st === "applied") continue;
    for (const r of g) {
      // 和工具卡用同一句话：hits 是「还剩几处没改到位」
      const extra = st === "partial" && r.total ? "  (还剩 " + r.hits + " 处没改到位，共 " + r.total + " 处写法)" : "";
      console.log("  " + r.id + "." + r.name + (r.pkg ? "  [" + r.pkg + "]" : "") + extra);
    }
  }
  // 写哪儿由 --out 决定；没写就写 cwd（老行为）。install.sh --dry 会传临时目录，
  // 否则号称「什么都没改」却往仓库里丢一个 patch-probe.json。
  // 默认写系统临时目录，不写当前目录：工具的 runPatchScript 把 cwd 设成插件包目录，
  // 于是「probe 只看当前分布、不改文件」的 probe 会往插件包里扔一个 16 KB 的
  // patch-probe.json。--dry 也走这里，而 --dry 承诺「不在仓库里留文件」。
  const out = flag("out") || path.join(os.tmpdir(), "dsh-purge-probe-" + process.pid + ".json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rows, null, 1));

  // probe 也给结果行：现在 install.sh 不读它（只读上面那行 tally 给人看），
  // 但「每次结束都打一行」这条契约要一致——少一处，将来谁想读就会读到空，
  // 那时静默走错分支比现在多写一行糟得多。
  const t = core.tally(rows);
  emit({ ok: true, command: "probe", applied: t.applied || 0, no_pkg: t.no_pkg || 0, kind: "ok" });
} else if (cmd === "apply") {
  // ── 先还原、再重打（与面板 patchApply 同一套逻辑）────────────────────
  //
  // 为什么要先还原：core.apply 是在「磁盘上现在这个文件」上做字符串替换。
  // 文件要是上次打到一半崩了、或被别的工具改过，起点就是脏的——pattern 被改坏半截时
  // isDone 会判成「已打过」，永远补不上，而面板还显示已生效，用户看不出来。
  // 先还原成原始状态，重打就是幂等的：同样输入永远得到同样结果。
  //
  // --dry 不还原：预演的前提就是「什么都不改」，真去写引擎文件就违背了。
  // --no-prerestore 留给排障用（万一还原本身出问题，还能退回老行为）。
  //
  // 补备份：面板走的 update-worker 会先 prepareBackup 把老备份补齐，CLI 以前没有这一步。
  // 补丁目标会长大（0.7.0 加了 presets、ptc、pipeline.js），0.6.8 的旧备份覆盖不全，
  // findReusableBackup 判 null → 不预还原 → 落到下面的脏引擎分支 → 补丁层整个跳过。
  // 用户照 README 跑 `git pull && sh install.sh`，拿到的是「插件装好了、补丁没打」。
  // 挪到这儿之后两条路行为一致。
  let preRestored = false
  if (!has("dry") && !has("no-prerestore") && !has("no-topup")) {
    try {
      const prep = await prepareBackup(dshHome(), { root });
      if (prep?.filled?.length) {
        console.log("  补齐了老备份里缺的 " + prep.filled.length + " 个文件（备份目录 " + prep.dir + "）");
      }
      if (prep?.failed?.length) {
        // 补不上要说出来：不然后面还原时缺文件、报「备份不完整」，用户不知道是没联网补的。
        console.log("  ⚠ 有 " + prep.failed.length + " 个文件没能补齐（" + (prep.failed[0].why || "原因未知") + "），还原可能被判不完整");
      }
    } catch (err) {
      // 补不上不该挡住安装：还原那步还会各自校验，缺文件会走 fail 报清楚。
      console.log("  （补齐老备份时出错，跳过：" + (err?.message || String(err)) + "）");
    }
  }
  if (!has("dry") && !has("no-prerestore")) {
    let reusable = null;
    try {
      // 要求备份完整覆盖当前全部补丁目标，缺一个都不复用（详见 lib/ops.js 里 findReusableBackup 的注释）。
      const requiredRels = (() => {
        const set = new Set();
        try {
          for (const row of core.probe(root)) {
            for (const f of row.files || []) {
              try { set.add(path.relative(root, f)); } catch { /* 跳过 */ }
            }
          }
        } catch { /* 扫不到就不要求 */ }
        return set;
      })();
      reusable = findReusableBackup(dshHome(), core.engineVersion(root), { requiredRels });
    } catch (err) {
      // 找备份失败不该挡住安装（比如 home 目录还没建）；留一行提示即可。
      console.log("  （找旧备份时出错，跳过先还原：" + (err?.message || String(err)) + "）");
    }
    if (reusable?.dir) {
      // 与面板 patchApply 一致：还原前先验备份完整性。
      // 缺文件的备份还原出来是「一半原始一半现状」，比不还原更糟——那时引擎已被改过，退不回去。
      const missing = missingBackupFiles(reusable.dir);
      if (missing.length) {
        fail("找到的备份不完整（manifest 记的文件里有 " + missing.length
          + " 个不在 files/ 下，例：" + missing.slice(0, 3).join("、")
          + "）。用它还原会留下半截状态，所以没有动引擎。请重装引擎包，或删掉这份备份重新注入。", "incomplete_backup");
      }
      let rr = null;
      try {
        rr = core.restore(reusable.dir, { root });
      } catch (err) {
        // 用 restore_partial 而不是 restore_failed：core.restore 是逐文件复制，
        // 抛异常时前面的文件已经写回去了，引擎极可能是半截状态。
        // install.sh 对这两个 kind 要说不同的话——说错会让人带着半截引擎继续用。
        fail("先把引擎还原成原始状态时出错，已中止（没有继续打补丁）。"
          + "这一步是逐文件写回的，出错时可能已经改了一部分，引擎不确定是否完好；"
          + "先别重启，按 README 第 6 章重装引擎包最稳。原因：" + (err?.message || String(err)), "restore_partial");
      }
      const rerrs = Array.isArray(rr?.errors) ? rr.errors : [];
      if (rerrs.length) {
        // restore 逐文件复制，出错时前面的文件已经写回去了——必须报出已回退几个，
        // 否则用户以为引擎一点没动，实际已是半截状态。
        fail("还原到原始状态时出错，已中止（没有继续打补丁）。已经回退了 "
          + (rr?.restored || 0) + " 个文件，引擎可能停在半截状态，需要重跑或重装引擎包。第一个错误："
          + (rerrs[0].error || "未知"), "restore_partial");
      }
      console.log("  已还原到原始状态（" + (rr.restored || 0) + " 个文件），来源 " + reusable.dir);
      // 记下来给下面 emit 用：这是「原来就是干净的」的两种来源之一，
      // 另一种是 core.apply 自己回滚。install.sh 靠这个区分「引擎完好」和「可能半截」。
      preRestored = true;
    }
  }
  // 与面板 patchApply 对齐：引擎里还留着上次的补丁痕迹时，不能把它当原始状态存进新备份。
  // 面板早就拦了这条，CLI 一直没拦——同一种脏引擎，面板报错要求重装，CLI 却静默往下走。
  //
  // 不能加「没传 --backup 才拦」这种条件：install.sh 每次都传 --backup，那样等于永远不拦。
  // 脏引擎配上任何目标目录，存出来的都是脏快照，跟路径无关。真要强行继续，用 --force-dirty-backup。
  if (!has("force-dirty-backup")) {
    try {
      // 判据用 probe，不用 [dsh-purge] 哨兵串：27/86 条补丁不留标记，靠串会漏判
      if (enginePatched(root).ids.length > 0) {
        // --dry 也要拦并报同样的分类：docs 里写着「--dry 预演的正是真装会改的同一批文件」，
        // 以前 dry 绕过这层检查，预演打「预演完成」，真装却因为脏引擎直接跳过补丁层——
        // 用户按预演结果决定要不要装，装完发现结果不一样。
        fail("引擎里还留着上次打的补丁，现在建备份会把「已打补丁」的状态存成原始状态，之后还原也撤不掉。先重装引擎包（见 README 第 6 章）；确认要强行继续就加 --force-dirty-backup。", "dirty_engine");
      }
    } catch (error) {
      // fail() 自己会 process.exit，走不到这里；这里是 probe 本身抛错时的兜底
      if (String(error?.message || '').includes('引擎里还留着')) throw error
    }
  }

  let report;
  try {
    report = core.apply(root, { backupDir: flag("backup"), dry: has("dry") });
  } catch (err) {
    fail(err.message, "apply_failed");
  }
  // 只留一份「没打过补丁」的原始快照，和面板路径保持一致——
  // 不然每跑一次 install.sh 就多攒一份，还原时还得挑是哪份。
  //
  // 三个条件缺一不可：这次真改出了东西（applied > 0）、没有错误、backupDir 非空。
  // applied=0 时 report.backupDir 要么为空（apply 早返回），要么存的是「已还原成原始」
  // 的那份副本——后者是有效快照，这时候清掉别人等于把用户的还原凭据顺手删了。
  if (!has("dry") && report && report.backupDir && report.errors.length === 0 && Number(report.applied) > 0) {
    try {
      pruneOtherBackups(dshHome(), report.backupDir);
    } catch {
      /* 清不掉不影响补丁本身 */
    }
  }
  for (const line of report.logs) console.log(line);
  // errors 必须打出来。原来只印 logs，于是「引擎版本没适配」「备份不完整」这类拒绝
  // 在 CLI 上表现为「一个字都不输出 + exit 1」，用户完全不知道发生了什么；
  // 而面板那边同样的拒绝会给一句完整的话。两条路给的信息必须一样多。
  for (const e of report.errors || []) console.log("  ✖ " + (e.error || String(e)));

  // 机器可读结果：install.sh 只看这一行，不再 grep 上面的中文。
  // kind 优先取 core.apply 给的（engine_unsupported / incomplete_backup），
  // 没给就是 apply_errors；全成功则是 ok。dry 单独标出来，安装脚本据此不把预演当成功。
  const errs = report.errors || [];
  emit({
    ok: errs.length === 0,
    command: "apply",
    dry: has("dry"),
    applied: Number(report.applied) || 0,
    errors: errs.length,
    // kind 的优先级：core.apply 明确标的（engine_unsupported / incomplete_backup）
    //   → 回滚没滚干净（report.rollbackFailed，core 早就返回了这个布尔，只是没人用）
    //   → 一般性失败。
    // 引擎里还留着补丁痕迹、这次一条也没打，走的是 fail("dirty_engine")，不会到这儿。
    kind: errs.length
      ? (errs[0].kind || (report.rollbackFailed ? "rollback_incomplete" : "apply_errors"))
      : "ok",
    // 这两个原来只能从日志文本里 grep（"已还原到原始状态" / "rolled back: all files restored"），
    // 改一句提示就失效。core 早就算好了，直接带出来。
    rolledBack: !!report.rolledBack,
    rollbackFailed: !!report.rollbackFailed,
    // 「引擎现在是干净的」有两种来源，install.sh 两支都要认：
    //   ① 打之前就还原成了原始状态（preRestored）
    //   ② 打了一半失败、core.apply 自己全量回滚成功（rolledBack && !rollbackFailed）
    // 只判 ② 会把 ① 那种情况错报成「引擎可能已被部分修改」，把人吓去白重装一次引擎。
    clean: !!(preRestored || (report.rolledBack && !report.rollbackFailed)),
  });
  if (errs.length) process.exitCode = 1;
} else if (cmd === "restore") {
  let report;
  try {
    report = core.restore(flag("backup"), { root });
  } catch (err) {
    // 和 apply 那条路径统一用 restore_partial：core.restore 逐文件写回，
    // 抛异常时前面的文件已经改过了，说成「没动」会让人带着半截引擎继续用。
    fail(err.message, "restore_partial");
  }
  for (const line of report.logs) console.log(line);
  for (const e of report.errors || []) console.log("  ✖ " + (e.error || String(e)));
  // 还原的 warnings（App 版本变了、root 不一致）也要说——面板那条 toast 只截前 18 个字符，
  // CLI 是唯一能看全的地方。
  for (const w of report.warnings || []) console.log("  ⚠ " + w);

  // 还原也要给结果行：install.sh 的「还原补丁」那条路同样靠它判成败，
  // 少了这行就退回「grep 中文」，改一句提示又走错。
  const rerrs = report.errors || [];
  emit({
    ok: rerrs.length === 0 && Number(report.restored) > 0,
    command: "restore",
    restored: Number(report.restored) || 0,
    errors: rerrs.length,
    // restored=0 但没报错：备份是空的/什么都不用还原。调用方要和「还原成功」分开看。
    kind: rerrs.length ? "restore_partial" : Number(report.restored) > 0 ? "ok" : "restore_empty",
  });
  // ok=false 的时候退出码必须非 0。以前只看 rerrs：空备份（restored=0、无错误）会 emit
  // 一个 ok:false，然后 exit 0——工具侧按退出码判成功，于是「补丁已还原」报得理直气壮，
  // 实际一个字节都没动。
  if (rerrs.length || !(Number(report.restored) > 0)) process.exitCode = 1;
} else {
  fail("unknown command: " + cmd + " (probe | apply | restore)", "unknown_command");
}
