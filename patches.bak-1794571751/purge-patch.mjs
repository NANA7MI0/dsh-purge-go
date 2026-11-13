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
  for (const st of ["hit", "partial", "applied", "miss", "no_file", "no_needle", "no_pkg"]) {
    const g = rows.filter((r) => r.status === st);
    if (!g.length) continue;
    console.log("\n# " + st + " (" + g.length + ")");
    for (const r of g) console.log("  " + r.id + "." + r.name + (r.pkg ? "  [" + r.pkg + "]" : ""));
  }
  fs.writeFileSync(path.join(process.cwd(), "patch-probe.json"), JSON.stringify(rows, null, 1));
} else if (cmd === "apply") {
  let report;
  try {
    report = core.apply(root, { backupDir: flag("backup"), dry: has("dry") });
  } catch (err) {
    fail(err.message);
  }
  for (const line of report.logs) console.log(line);
  if (report.errors.length) process.exitCode = 1;
} else if (cmd === "restore") {
  let report;
  try {
    report = core.restore(flag("backup"), { root });
  } catch (err) {
    fail(err.message);
  }
  for (const line of report.logs) console.log(line);
  if (report.errors.length) process.exitCode = 1;
} else {
  fail("unknown command: " + cmd + " (probe | apply | restore)");
}
