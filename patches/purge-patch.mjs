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
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCHES = JSON.parse(fs.readFileSync(path.join(HERE, "patches.json"), "utf8"));

const argv = process.argv.slice(2);
const cmd = argv[0] || "probe";
const flag = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes("--" + n);

/** Package-name aliases: dsh-purge names its target packages loosely. */
const ALIAS = {
  escalation: ["dsh-escalation", "dsh-permission-escalation", "dsh-tool-escalation"],
  "auto-review": ["dsh-experimental-auto-review", "dsh-auto-review"],
  "conversation-client": ["dsh-conversation-client", "dsh-client-ui-chat"],
  "web-app-lib": ["dsh-web-app"],
  "deliverables-prompt": ["dsh-deliverables", "dsh-deliverables-prompt"],
  "hooks-claude-code": ["dsh-hooks-claude-code", "dsh-hook-claude-code"],
  "hooks-codex": ["dsh-hooks-codex", "dsh-hook-codex"],
  "session-format-v0": ["dsh-session-format-v0-to-v1", "dsh-session-format-v0"],
  "user-approval-code": ["dsh-user-approval"],
  "desktop-shell": ["dsh-desktop-shell"],
};

function fail(msg) { console.error("error: " + msg); process.exit(1); }

function detectRoot() {
  const explicit = flag("root") || process.env.DSH_AI_ROOT;
  if (explicit) return explicit;
  const candidates = [
    "/opt/dsh/node_modules/@deepseek-ai",
    path.join(os.homedir(), ".npm-global/lib/node_modules/@deepseek-ai"),
    "/usr/local/lib/node_modules/@deepseek-ai",
    "/usr/lib/node_modules/@deepseek-ai",
  ];
  try {
    const g = execFileSync("npm", ["root", "-g"], { stdio: "pipe" }).toString().trim();
    candidates.push(path.join(g, "@deepseek-ai"));
  } catch { /* npm may be absent */ }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  fail("cannot locate @deepseek-ai; pass --root <dir>");
}

function listPkgs(root) {
  return fs.readdirSync(root).filter((n) => {
    try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; }
  });
}

function candidatesFor(p, pkgs) {
  const files = Array.isArray(p.file) ? p.file : [p.file];
  const out = [];
  for (const f of files) {
    if (!f) continue;
    const base = String(f).replace(/_/g, "-");
    let found = false;
    for (const t of [base, "dsh-" + base].concat(ALIAS[base] || [])) {
      if (pkgs.includes(t)) { out.push(t); found = true; }
    }
    if (!found) out.push(...pkgs.filter((n) => n.endsWith("-" + base) || n.includes(base)));
  }
  return [...new Set(out)];
}

function relOf(p) {
  if (Array.isArray(p.rel)) return p.rel;
  if (typeof p.rel === "string") return p.rel.split("/").filter(Boolean);
  return ["lib", "index.js"];
}

function editsOf(p) {
  const out = [];
  if (Array.isArray(p.replacements)) {
    for (const r of p.replacements) {
      if (typeof r.pattern === "string" && typeof r.replace === "string") out.push({ pat: r.pattern, rep: r.replace });
    }
  }
  if (Array.isArray(p.patterns) && typeof p.replace === "string") {
    for (const s of p.patterns) if (typeof s === "string") out.push({ pat: s, rep: p.replace });
  }
  return out;
}

function marked(p, text) {
  const ms = [];
  if (Array.isArray(p.markers)) ms.push(...p.markers);
  if (Array.isArray(p.markersAny)) ms.push(...p.markersAny);
  if (typeof p.marker === "string") ms.push(p.marker);
  if (typeof p.forbid === "string") ms.push(p.forbid);
  return ms.some((m) => typeof m === "string" && m.length > 3 && text.includes(m));
}

function probe(root) {
  const pkgs = listPkgs(root);
  const rows = [];
  for (const p of PATCHES) {
    const cands = candidatesFor(p, pkgs);
    if (!cands.length) { rows.push({ id: p.id, name: p.name, status: "no_pkg" }); continue; }
    const rel = relOf(p);
    const edits = editsOf(p);
    // 每条补丁要对**所有**候选包分别判定：多目标补丁（file 是数组）只打第一个包是错的。
    const hitsRows = [];
    for (const pkg of cands) {
      const file = path.join(root, pkg, ...rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      const text = fs.readFileSync(file, "utf8");
      if (!edits.length) { hitsRows.push({ status: "no_needle", pkg, file }); continue; }
      const hits = edits.filter((e) => text.includes(e.pat)).length;
      const st = marked(p, text) ? "applied" : hits === edits.length ? "hit" : hits === 0 ? "miss" : "partial";
      hitsRows.push({ status: st, pkg, file, hits, total: edits.length });
    }
    if (!hitsRows.length) { rows.push({ id: p.id, name: p.name, status: "no_file", pkg: cands.join(",") }); continue; }
    // 汇总成一条：只要有任一包可打就是 hit/partial，全打过才是 applied
    const rank = { hit: 3, partial: 2, applied: 1, miss: 0, no_needle: 0 };
    let top = hitsRows[0];
    for (const r of hitsRows) if ((rank[r.status] ?? 0) > (rank[top.status] ?? 0)) top = r;
    const allApplied = hitsRows.every((r) => r.status === "applied");
    rows.push(Object.assign(
      { id: p.id, name: p.name, status: allApplied ? "applied" : top.status },
      top,
      { status: allApplied ? "applied" : top.status, targets: hitsRows.length, files: hitsRows.map((r) => r.file) },
    ));
  }
  return rows;
}

function tally(rows) {
  const t = {};
  for (const r of rows) t[r.status] = (t[r.status] || 0) + 1;
  return t;
}

function restoreScript(root) {
  // ROOT 不写死：优先环境变量 DSH_AI_ROOT，其次第一个参数，最后回落到生成时的路径。
  const lines = [
    "#!/bin/sh",
    "set -e",
    'D="$(dirname "$0")"',
'ROOT="${DSH_AI_ROOT:-${1:-' + root + '}}"',
    'if [ ! -d "$ROOT" ]; then',
    '  echo "engine package dir not found: $ROOT" >&2',
    '  echo "usage: DSH_AI_ROOT=/path/to/@deepseek-ai sh $0" >&2',
    "  exit 1",
    "fi",
    'cd "$D/files"',
    'find . -type f | while read -r f; do cp -f "$f" "$ROOT/$f"; done',
    'echo "restored into $ROOT"',
  ];
  return lines.join("\n") + "\n";
}


function apply(root, backupDir, dry) {
  const rows = probe(root);
  const byFile = new Map();
  for (const r of rows) {
    if (r.status !== "hit" && r.status !== "partial") continue;
    if (!r.files || !r.files.length) continue;
    const p = PATCHES.find((x) => x.id === r.id);
    // 多目标补丁：每个目标文件都要单独打
    for (const file of r.files) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (marked(p, text)) continue;
      const edits = editsOf(p).filter((e) => text.includes(e.pat));
      if (!edits.length) continue;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({ id: r.id, name: r.name, edits: edits });
    }
  }
  if (!byFile.size) { console.log("nothing to apply"); return; }
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = backupDir || path.join(process.cwd(), "backup-" + stamp);
  for (const file of byFile.keys()) {
    const rel = path.relative(root, file);
    if (!dry) {
      const dst = path.join(dir, "files", rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(file, dst);
    }
  }
  if (!dry) {
    fs.writeFileSync(path.join(dir, "restore.sh"), restoreScript(root));
    fs.chmodSync(path.join(dir, "restore.sh"), 0o755);
  }
  let ok = 0;
  let bad = 0;
  for (const [file, jobs] of byFile) {
    const rel = path.relative(root, file);
    if (dry) { console.log("would edit " + rel + " :: " + jobs.map((j) => j.id).join(",")); continue; }
    let text = fs.readFileSync(file, "utf8");
    for (const j of jobs) {
      for (const e of j.edits) {
        const parts = text.split(e.pat);
        if (parts.length > 1) text = parts.join(e.rep);
      }
    }
    fs.writeFileSync(file, text);
    let good = true;
    if (file.endsWith(".js")) {
      try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }); } catch { good = false; }
    }
    if (good) { ok++; console.log("ok   " + rel + " :: " + jobs.map((j) => j.id).join(",")); }
    else {
      fs.copyFileSync(path.join(dir, "files", rel), file);
      bad++;
      console.log("FAIL(syntax, restored) " + rel);
    }
  }
  if (!dry) console.log("\napplied " + ok + " file(s), failed " + bad + " - backup at " + dir);
}

function restore(backupDir) {
  if (!backupDir) fail("restore needs --backup <dir>");
  const root = detectRoot();
  const src = path.join(backupDir, "files");
  if (!fs.existsSync(src)) fail("no files/ in " + backupDir);
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const rel = path.relative(src, full);
      fs.copyFileSync(full, path.join(root, rel));
      console.log("restored " + rel);
      n++;
    }
  };
  walk(src);
  console.log("\nrestored " + n + " file(s)");
}

const root = detectRoot();
if (cmd === "probe") {
  const rows = probe(root);
  console.log("root: " + root);
  console.log("tally: " + JSON.stringify(tally(rows)));
  for (const st of ["hit", "partial", "applied", "miss", "no_file", "no_needle", "no_pkg"]) {
    const g = rows.filter((r) => r.status === st);
    if (!g.length) continue;
    console.log("\n# " + st + " (" + g.length + ")");
    for (const r of g) console.log("  " + r.id + "." + r.name + (r.pkg ? "  [" + r.pkg + "]" : ""));
  }
  fs.writeFileSync(path.join(process.cwd(), "patch-probe.json"), JSON.stringify(rows, null, 1));
} else if (cmd === "apply") {
  apply(root, flag("backup"), has("dry"));
} else if (cmd === "restore") {
  restore(flag("backup"));
} else {
  fail("unknown command: " + cmd + " (probe | apply | restore)");
}
