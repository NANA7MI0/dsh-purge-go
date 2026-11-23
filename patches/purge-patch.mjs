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
import path from "node:path";
import * as core from "./lib/core.mjs";
// 面板和 CLI 必须走同一套「先还原再重打」的逻辑，否则两条路行为分叉：
// 用户点按钮是一个结果，跑 install.sh 是另一个结果，出问题永远查不清。
import { findReusableBackup, pruneOtherBackups, hasPatchTraces, missingBackupFiles } from "../lib/ops.js";
import { dshHome } from "../lib/home.js";

const argv = process.argv.slice(2);
const cmd = argv[0] || "probe";
const flag = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes("--" + n);

function fail(msg) { console.error("error: " + msg); process.exit(1); }

let root;
try {
  root = core.detectRoot(flag("root"));
} catch (err) {
  fail(err.message);
}

if (cmd === "probe") {
  const rows = core.probe(root);
  console.log("root: " + root);
  console.log("tally: " + JSON.stringify(core.tally(rows)));
  const NL = String.fromCharCode(10);
  const NOTE = {
    partial:
      "  正常情况，不用担心，不影响破甲能力。" + NL +
      "  补丁表里每条都写了几套不同引擎版本的写法，你的引擎只会有其中一套；" + NL +
      "  命中那套就已经改好了，剩下的是别的版本和桌面版的备用分支。",
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
      const extra = st === "partial" && r.total ? "  (" + (r.total - r.hits) + "/" + r.total + " 套写法命中)" : "";
      console.log("  " + r.id + "." + r.name + (r.pkg ? "  [" + r.pkg + "]" : "") + extra);
    }
  }
  // 写哪儿由 --out 决定；没写就写 cwd（老行为）。install.sh --dry 会传临时目录，
  // 否则号称「什么都没改」却往仓库里丢一个 patch-probe.json。
  const out = flag("out") || path.join(process.cwd(), "patch-probe.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rows, null, 1));
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
          + "）。用它还原会留下半截状态，所以没有动引擎。请重装引擎包，或删掉这份备份重新注入。");
      }
      let rr = null;
      try {
        rr = core.restore(reusable.dir, { root });
      } catch (err) {
        fail("先把引擎还原成原始状态时出错，已中止（没有继续打补丁）：" + (err?.message || String(err)));
      }
      const rerrs = Array.isArray(rr?.errors) ? rr.errors : [];
      if (rerrs.length) {
        // restore 逐文件复制，出错时前面的文件已经写回去了——必须报出已回退几个，
        // 否则用户以为引擎一点没动，实际已是半截状态。
        fail("还原到原始状态时出错，已中止（没有继续打补丁）。已经回退了 "
          + (rr?.restored || 0) + " 个文件，引擎可能停在半截状态，需要重跑或重装引擎包。第一个错误："
          + (rerrs[0].error || "未知"));
      }
      console.log("  已还原到原始状态（" + (rr.restored || 0) + " 个文件），来源 " + reusable.dir);
    }
  }
  // 与面板 patchApply 对齐：引擎里还留着上次的补丁痕迹时，不能把它当原始状态存进新备份。
  // 面板早就拦了这条，CLI 一直没拦——同一种脏引擎，面板报错要求重装，CLI 却静默往下走。
  //
  // 不能加「没传 --backup 才拦」这种条件：install.sh 每次都传 --backup，那样等于永远不拦。
  // 脏引擎配上任何目标目录，存出来的都是脏快照，跟路径无关。真要强行继续，用 --force-dirty-backup。
  if (!has("dry") && !has("force-dirty-backup")) {
    try {
      if (hasPatchTraces(root)) {
        fail("引擎里还留着上次打的补丁，现在建备份会把「已打补丁」的状态存成原始状态，之后还原也撤不掉。先重装引擎包（见 README 第 6 章）；确认要强行继续就加 --force-dirty-backup。");
      }
    } catch { /* 探测失败就不拦，别把安装卡死 */ }
  }

  let report;
  try {
    report = core.apply(root, { backupDir: flag("backup"), dry: has("dry") });
  } catch (err) {
    fail(err.message);
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
  if ((report.errors || []).length) process.exitCode = 1;
} else if (cmd === "restore") {
  let report;
  try {
    report = core.restore(flag("backup"), { root });
  } catch (err) {
    fail(err.message);
  }
  for (const line of report.logs) console.log(line);
  for (const e of report.errors || []) console.log("  ✖ " + (e.error || String(e)));
  // 还原的 warnings（App 版本变了、root 不一致）也要说——面板那条 toast 只截前 18 个字符，
  // CLI 是唯一能看全的地方。
  for (const w of report.warnings || []) console.log("  ⚠ " + w);
  if ((report.errors || []).length) process.exitCode = 1;
} else {
  fail("unknown command: " + cmd + " (probe | apply | restore)");
}
