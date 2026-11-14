/**
 * core - dsh-purge 补丁层的纯函数实现。
 *
 * 与 purge-patch.mjs（CLI 壳）分离的原因：面板、工具、CLI 三条路径要共用同一份逻辑，
 * 而 CLI 脚本 import 即执行、且用 process.exit 结束进程，无法被库调用。
 *
 * 约定：
 *   - 本模块不读 process.argv、不调 process.exit、不写 console。
 *   - 所有函数返回结构化结果，由调用方决定怎么展示。
 *   - 出错抛 Error，不用 fail() 打断进程。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

/** Package-name aliases: dsh-purge names its target packages loosely. */
export const ALIAS = {
  escalation: ["dsh-escalation", "dsh-permission-escalation", "dsh-tool-escalation"],
  "auto-review": ["dsh-experimental-auto-review", "dsh-auto-review"],
  "conversation-client": ["dsh-conversation-client", "dsh-client-ui-conversation", "dsh-client-ui-chat"],
  "web-app-lib": ["dsh-web-app"],
  "deliverables-prompt": ["dsh-deliverables", "dsh-deliverables-prompt"],
  "hooks-claude-code": ["dsh-hooks-claude-code", "dsh-hook-claude-code"],
  "hooks-codex": ["dsh-hooks-codex", "dsh-hook-codex"],
  "session-format-v0": ["dsh-session-format-v0-to-v1", "dsh-session-format-v0"],
  "user-approval-code": ["dsh-user-approval"],
  "desktop-shell": ["dsh-desktop-shell"],
};

/** 读补丁表。缺文件时抛错而不是 process.exit。 */
export function loadPatches(file) {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.patches || [];
}

/** 找引擎包目录。显式参数 > 环境变量 > 常见安装位置 > npm 全局根。找不到抛错。 */
export function detectRoot(explicit) {
  const fromArg = explicit || process.env.DSH_AI_ROOT;
  if (fromArg) return fromArg;
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
  throw new Error("cannot locate @deepseek-ai; pass --root <dir>");
}

export function listPkgs(root) {
  return fs.readdirSync(root).filter((n) => {
    try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; }
  });
}

export function candidatesFor(p, pkgs) {
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

export function relOf(p) {
  if (Array.isArray(p.rel)) return p.rel;
  if (typeof p.rel === "string") return p.rel.split("/").filter(Boolean);
  return ["lib", "index.js"];
}

/**
 * 把 patches.json 里的一条 replacement 转成内部 edit 对象。
 *
 * pattern 有两种写法：
 *  - 字符串：纯字面量，用 split/join 匹配（历史写法，全表绝大多数）
 *  - { source, flags }：正则。上游 kingcharleslzy-ai/dsh-purge 的表里 pattern 就是 RegExp，
 *    导出成 JSON 时会退化成 {}，所以这里也接受对象形式，把正则还原回来。
 */
function toEdit(r) {
  if (!r || typeof r.replace !== "string") return null;
  const p = r.pattern;
  if (typeof p === "string" && p.length > 0) return { pat: p, rep: r.replace };
  if (p && typeof p === "object" && typeof p.source === "string" && p.source.length > 0) {
    const flags = typeof p.flags === "string" ? p.flags : "g";
    return { pat: p.source, rep: r.replace, re: { source: p.source, flags } };
  }
  return null;
}

/** 这条 edit 是不是正则形态。 */
export function isRegexEdit(e) {
  return Boolean(e && e.re && typeof e.re.source === "string");
}

/** 造一个带 g 标志的正则，用来数命中次数。 */
function globalRegex(e) {
  const flags = e.re.flags.includes("g") ? e.re.flags : e.re.flags + "g";
  return new RegExp(e.re.source, flags);
}

/** 这条 edit 在文本里还剩几处没打。字符串走 split，正则走 match。 */
export function countHits(e, text) {
  if (isRegexEdit(e)) {
    const m = text.match(globalRegex(e));
    return m ? m.length : 0;
  }
  return text.split(e.pat).length - 1;
}

export function editsOf(p) {
  const out = [];
  if (Array.isArray(p.replacements)) {
    for (const r of p.replacements) {
      const e = toEdit(r);
      if (e) out.push(e);
    }
  }
  if (Array.isArray(p.patterns) && typeof p.replace === "string") {
    for (const s of p.patterns) if (typeof s === "string") out.push({ pat: s, rep: p.replace });
  }
  return out;
}

export function marked(p, text) {
  const ms = [];
  if (Array.isArray(p.markers)) ms.push(...p.markers);
  if (Array.isArray(p.markersAny)) ms.push(...p.markersAny);
  if (typeof p.marker === "string") ms.push(p.marker);
  if (typeof p.forbid === "string") ms.push(p.forbid);
  return ms.some((m) => typeof m === "string" && m.length > 3 && text.includes(m));
}

/**
 * 逐补丁扫盘判定。
 * @returns {Array<{id,name,status,pkg?,file?,hits?,total?,targets?,files?}>}
 * status: applied | hit | partial | miss | no_needle | no_file | no_pkg
 */
/**
 * 这条 replacement 是否已经落到文件里了。
 *
 * 分两种形态：
 *  - 替换型（rep 不含 pat）：pattern 不在了 = 已打。
 *  - 追加型（rep 里含 pat，比如「在原文后面补一段」）：打完 pattern 依然在文件里，
 *    所以只能看「完整的 rep 在不在」。若按 pattern 计数，这类补丁会永远显示 partial，
 *    而且 apply 每次都会再追加一遍（实测 #42 有 4 条是这种）。
 */
export function isDone(e, text) {
  const rep = e.rep || "";
  // 正则形态：pattern 还在文件里 = 还没打；pattern 不在 = 已打。
  // 正则里的 replace 通常带 $1 之类分组，没法用「rep 含 pat」那套判断。
  if (isRegexEdit(e)) {
    return !new RegExp(e.re.source, e.re.flags).test(text);
  }
  // rep 与 pat 一模一样：这条补丁不改变任何文本（幂等标记型，全表共 3 条）。
  // 替换了等于没替换，所以永远算作「无需处理」——否则它会一直卡在 partial。
  if (rep === e.pat) return true;
  if (rep !== "" && rep.includes(e.pat)) return text.includes(rep);
  return !text.includes(e.pat);
}

export function probe(root, patches) {
  const table = patches || loadPatches(resolvePatchesFile());
  const pkgs = listPkgs(root);
  const rows = [];
  for (const p of table) {
    const cands = candidatesFor(p, pkgs);
    if (!cands.length) { rows.push({ id: p.id, name: p.name, status: "no_pkg" }); continue; }
    const rel = relOf(p);
    const edits = editsOf(p);
    const hitsRows = [];
    for (const pkg of cands) {
      const file = path.join(root, pkg, ...rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      const text = fs.readFileSync(file, "utf8");
      if (!edits.length) { hitsRows.push({ status: "no_needle", pkg, file }); continue; }
      // hits 的语义是「还剩几处没打」，不是「pattern 命中几处」——
      // 追加型补丁打完 pattern 仍在，按命中数算会永远 partial。
      const hits = edits.filter((e) => !isDone(e, text)).length;
      const hasMarker = marked(p, text);
      // 判定以前置条件为准：pattern 还剩几个说了算，marker 只用来区分「打过又被覆盖」和「从没打过」。
      // 旧逻辑「marker 命中即 applied」会让打了 1/3 的补丁显示成已生效（实测 #17 三缺二、#42 十二缺四）。
      let st;
      if (hits === 0) {
        // 全部 pattern 都不在了。有 marker 才是我们打的；没有就是「本来就不需要打」，
        // 不能算 applied——否则 applied 会虚高（实测 #56/#63 属于这种）。
        st = hasMarker ? "applied" : "miss";
      } else if (hits === edits.length) {
        // 一个都没被替换：有 marker 说明以前打过但被引擎升级冲掉了，没 marker 就是从未打过
        st = hasMarker ? "drifted" : "hit";
      } else {
        st = "partial"; // 打了一部分
      }
      hitsRows.push({ status: st, pkg, file, hits, total: edits.length, marker: hasMarker });
    }
    if (!hitsRows.length) { rows.push({ id: p.id, name: p.name, status: "no_file", pkg: cands.join(",") }); continue; }
    const rank = { hit: 4, drifted: 3, partial: 2, applied: 1, miss: 0, no_needle: 0 };
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

export function tally(rows) {
  const t = {};
  for (const r of rows) t[r.status] = (t[r.status] || 0) + 1;
  return t;
}

export function restoreScript(root) {
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

/**
 * 校验一个文件在改写后是否仍然合法。返回 null 表示通过，否则返回原因。
 * 只校验能校验的：.js 走 node --check，.json 走 JSON.parse，.yml/.yaml 走 yaml 解析。
 * 其余扩展名无法可靠校验，返回 null 但由调用方标记为 unverified。
 */
/** 文件的 sha256（用于备份完整性校验）。 */
export function sha256(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  } catch {
    return ""
  }
}

export function verifyFile(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" })
      return null
    } catch (error) {
      return "node --check 失败：" + String(error?.stderr || error?.message || error).slice(0, 200)
    }
  }
  if (ext === ".json") {
    try {
      JSON.parse(fs.readFileSync(file, "utf8"))
      return null
    } catch (error) {
      return "JSON 解析失败：" + (error?.message || String(error))
    }
  }
  if (ext === ".yml" || ext === ".yaml") {
    // yaml 是引擎自带的依赖；解析不了说明写坏了（缩进/引号/锚点）
    try {
      const mod = requireYaml()
      // 拿不到 yaml 时不能假装「校验通过」——返回一句提示，让调用方标成 unverified 而不是放行。
      if (!mod) return "UNVERIFIED: 本机拿不到 yaml 解析器，该文件未被校验"
      const text = fs.readFileSync(file, "utf8")
      // dsh 的 patch 文件用了 !!js 自定义标签，标准解析会报 unknown tag，先剔除再解析
      const cleaned = text.replace(/!!js /g, "")
      mod.parse(cleaned)
      return null
    } catch (error) {
      return "YAML 解析失败：" + (error?.message || String(error)).slice(0, 200)
    }
  }
  return null
}

/** 惰性加载 yaml，拿不到就返回 null（不硬依赖，缺了退化为不校验）。 */
function requireYaml() {
  if (yamlModule !== undefined) return yamlModule
  try {
    yamlModule = createRequire(import.meta.url)("yaml")
  } catch {
    try {
      // 退一步：从引擎的 node_modules 里找
      yamlModule = createRequire(path.join(detectRoot(), "..", "..", "noop.js"))("yaml")
    } catch {
      yamlModule = null
    }
  }
  return yamlModule
}
let yamlModule

/**
 * 应用补丁。
 * 事务语义：任何一步失败（写、校验），把所有已改文件恢复到改写前，并如实返回 failed。
 * @returns {{backupDir:string|null, applied:number, failed:number, files:Array, logs:string[], errors:Array, rolledBack:boolean}}
 */
export function apply(root, opts = {}) {
  const { backupDir, dry = false, patches, cwd = process.cwd() } = opts;
  const table = patches || loadPatches(resolvePatchesFile());
  const rows = probe(root, table);
  const logs = [];
  const errors = [];
  const byFile = new Map();
  for (const r of rows) {
    // miss 也要进：它可能是「等另一条补丁先打出前提」的链式下游（88 依赖 87 产生的
    // dshPurgeNorm/dshPurgeHead）。当时判 miss，87 打完就该能接上。
    // 纳入是安全的——miss 的 pattern 本来就不在文件里，迭代时不会被误改。
    if (r.status !== "hit" && r.status !== "partial" && r.status !== "miss") continue;
    if (!r.files || !r.files.length) continue;
    const p = table.find((x) => x.id === r.id);
    for (const file of r.files) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      // 这里**不能**因为「文件里已经有 marker」就整体跳过。
      // 一条补丁常有多处 pattern，marker 只代表其中**一处**打上了；
      // 剩下没打的 pattern 还留在文件里。原来的 `if (marked(p, text)) continue`
      // 会让这类文件永远停在 partial：marker 在、后几处却再也打不上。
      // 判据改成逐条看：这个 pattern 还在不在。
      // 只挑「还没打」的：追加型补丁的 pattern 打完仍在文件里，
      // 不排除的话每次 apply 都会重复追加一遍。
      // 只登记「这个文件涉及哪条补丁」，具体执行哪些 edit 留到写文件时逐轮重算。
      // 原因：一条补丁的多条变体常是链式的（A 把 const 改 let 并插旧块，B 再把旧块升级），
      // B 的 pattern 只有在 A 执行完之后才存在。以前在这里一次算死候选，B 永远进不来。
      // 不在这里过滤 pattern 在不在——链式下游（88 依赖 87 打出来的 dshPurgeNorm）
      // 在原版文本上一条都对不上，过滤掉就永远轮不到它。执行时逐轮重判。
      const edits = editsOf(p);
      if (!edits.length) continue;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({ id: r.id, name: r.name, edits });
    }
  }
  if (!byFile.size) {
    logs.push("nothing to apply");
    return { backupDir: null, applied: 0, failed: 0, files: [], logs, errors };
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = backupDir || path.join(cwd, "backup-" + stamp);
  const manifest = { root, at: new Date().toISOString(), files: [] };
  for (const file of byFile.keys()) {
    const rel = path.relative(root, file);
    if (!dry) {
      const dst = path.join(dir, "files", rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(file, dst);
      manifest.files.push({ rel, size: fs.statSync(dst).size, sha256: sha256(dst) });
    }
  }
  if (!dry) {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
    fs.writeFileSync(path.join(dir, "restore.sh"), restoreScript(root));
    fs.chmodSync(path.join(dir, "restore.sh"), 0o755);
  }
  // ── 事务式改写：任何一步失败就把已改的全部恢复到改写前 ──
  let ok = 0;
  let bad = 0;
  let rolledBack = false;
  let rollbackFailed = false;
  const files = [];
  const dirty = []; // 已经写过的文件，失败时用来回滚
  const rollbackMissed = []; // 回滚失败的文件——必须回给调用方，不能假装恢复了
  const restoreOne = (file, rel) => {
    try {
      const from = path.join(dir, "files", rel);
      if (!fs.existsSync(from)) throw new Error("备份里没有这个文件");
      fs.copyFileSync(from, file);
      return true;
    } catch (error) {
      const msg = error?.message || String(error);
      rollbackFailed = true;
      rollbackMissed.push({ rel, error: msg });
      errors.push({ rel, error: "回滚失败：" + msg });
      return false;
    }
  };
  for (const [file, jobs] of byFile) {
    const rel = path.relative(root, file);
    const ids = jobs.map((j) => j.id);
    if (dry) {
      // 只报「真的能匹配上」的——miss 的补丁也进了候选表，但它们一条 pattern 都不在，
      // 全报出来会让 --dry 看起来像要改一堆其实改不动的东西。
      const text0 = fs.readFileSync(file, "utf8");
      const real = jobs.filter((j) => {
        const p = table.find((x) => x.id === j.id);
        if (!p) return false;
        return editsOf(p).some((e) =>
          isRegexEdit(e) ? new RegExp(e.re.source, e.re.flags).test(text0) : text0.includes(e.pat),
        );
      });
      if (!real.length) continue;
      const realIds = real.map((j) => j.id);
      logs.push("would edit " + rel + " :: " + realIds.join(","));
      files.push({ rel, ids: realIds, ok: null, dry: true });
      continue;
    }
    let text = fs.readFileSync(file, "utf8");
    const origText = text;
    // 迭代式：每一轮都基于「当前文本」重新判定每条 edit 该不该跑。
    // 链式补丁（A 产生 B 的前提）因此能在一轮之后接上，直到文本不再变化。
    let rounds = 0;
    for (; rounds < 5; rounds++) {
      const before = text;
      for (const j of jobs) {
        const p = table.find((x) => x.id === j.id);
        if (!p) continue;
        for (const e of editsOf(p)) {
          if (isRegexEdit(e)) {
            // 正则形态：能匹配就执行（替换文本自己保证「打过之后不再匹配」）。
            const re = new RegExp(e.re.source, e.re.flags);
            const next = text.replace(re, e.rep);
            if (next !== text) text = next;
            continue;
          }
          if (!text.includes(e.pat) || isDone(e, text)) continue;
          const parts = text.split(e.pat);
          if (parts.length > 1) text = parts.join(e.rep);
        }
      }
      if (text === before) break;
    }
    if (rounds > 1) logs.push("iter " + rel + " :: " + rounds + " 轮收敛");
    try {
      fs.writeFileSync(file, text);
    } catch (error) {
      // 写失败：当前文件可能半写，立刻回滚它 + 之前写过的全部
      restoreOne(file, rel);
      for (const d of dirty) if (d.file !== file) restoreOne(d.file, d.rel);
      rolledBack = true;
      ok = 0; // 回滚之后成功数必须归零，否则会报「改了 N 个成功 1 个失败」
      bad++;
      const msg = "写入失败：" + (error?.message || String(error));
      logs.push("FAIL " + rel + " :: " + msg);
      files.push({ rel, ids, ok: false, error: msg });
      errors.push({ rel, ids, error: msg, rolledBack: true });
      break;
    }
    dirty.push({ file, rel });
    // 校验：.js 走 node --check，.json 走 JSON.parse，.yml/.yaml 走 yaml.parse
    const verifyError = verifyFile(file);
    const unverified = typeof verifyError === "string" && verifyError.startsWith("UNVERIFIED");
    if (unverified) logs.push("WARN " + rel + " :: " + verifyError); // 放行但明说没校验
    const good = verifyError === null || unverified;
    if (good) {
      // 内容没变就别报 ok——miss 状态的补丁也会登记进候选表，但它们一条 pattern 都匹配不上，
      // 报成 ok 会让人以为改了 50 多个文件。
      if (text === origText) {
        logs.push("skip " + rel + " :: 内容无变化");
        continue;
      }
      ok++;
      logs.push("ok   " + rel + " :: " + ids.join(","));
      files.push({ rel, ids, ok: true });
    } else {
      // 校验失败 = 事务失败：把当前文件和之前写过的全部恢复，避免半补丁状态
      restoreOne(file, rel);
      for (const d of dirty) if (d.file !== file) restoreOne(d.file, d.rel);
      rolledBack = true;
      bad++;
      logs.push(
        rollbackFailed
          ? "FAIL(verify, ROLLBACK INCOMPLETE) " + rel + " :: " + verifyError
          : "FAIL(verify, all restored) " + rel + " :: " + verifyError,
      );
      files.push({ rel, ids, ok: false, error: verifyError });
      errors.push({ rel, ids, error: verifyError, rolledBack: true });
      ok = 0; // 全部回滚后，成功数归零——不能报「改了 3 个成功 1 个失败」
      break;
    }
  }
  if (rolledBack && rollbackFailed) {
    logs.push("\nROLLBACK INCOMPLETE: " + rollbackMissed.length + " file(s) could not be restored — 引擎可能处于部分补丁状态");
  } else if (rolledBack) {
    logs.push("\nrolled back: all files restored, nothing is left patched");
  }
  if (!dry) logs.push("\napplied " + ok + " file(s), failed " + bad + " - backup at " + dir);
  return {
    backupDir: dry ? null : dir,
    applied: ok,
    failed: bad,
    files,
    logs,
    errors,
    rolledBack,
    rollbackFailed, // true = 想回滚但没滚干净，调用方必须如实告知用户
    rollbackMissed,
  };
}

/**
 * 从备份还原。
 * @returns {{restored:number, files:Array, logs:string[], errors:Array}}
 */
export function restore(backupDir, opts = {}) {
  if (!backupDir) throw new Error("restore needs a backup directory");
  const src = path.join(backupDir, "files");
  const logs = [];
  const errors = [];
  const files = [];
  if (!fs.existsSync(src)) throw new Error("no files/ in " + backupDir);

  // 优先按 manifest 走：它能告诉我们「该有哪些文件」「原来挂在哪个 root」「哈希对不对」
  const manifestPath = path.join(backupDir, "manifest.json");
  let manifest = null;
  try {
    if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    errors.push({ error: "manifest 读取失败：" + (error?.message || String(error)) });
  }

  const root = opts.root || manifest?.root || detectRoot();
  // manifest 记录的 root 与本次还原的 root 不一致时明确警告——可能是换机器或引擎重装
  const rootMismatch = Boolean(manifest?.root && opts.root && manifest.root !== opts.root);
  // 路径不一致是「警告」不是「错误」：还原本身可能成功，不能因此把 ok 判成 false。
  const warnings = [];
  if (rootMismatch) {
    warnings.push(`备份来自 ${manifest.root}，本次还原到 ${opts.root}，路径不一致`);
  }

  let n = 0;
  const restoreOne = (rel) => {
    const from = path.join(src, rel);
    if (!fs.existsSync(from)) {
      const msg = "备份缺文件，无法还原";
      logs.push("FAIL " + rel + ": " + msg);
      files.push({ rel, ok: false, error: msg });
      errors.push({ rel, error: msg });
      return;
    }
    try {
      fs.copyFileSync(from, path.join(root, rel));
      // 还原后核对哈希（manifest 里有才算）
      const expect = manifest?.files?.find((f) => f.rel === rel)?.sha256;
      if (expect) {
        const actual = sha256(path.join(root, rel));
        if (actual && actual !== expect) {
          const msg = "还原后哈希不符";
          logs.push("FAIL " + rel + ": " + msg);
          files.push({ rel, ok: false, error: msg });
          errors.push({ rel, error: msg });
          return;
        }
      }
      logs.push("restored " + rel);
      files.push({ rel, ok: true });
      n++;
    } catch (error) {
      const msg = error?.message ? error.message : String(error);
      logs.push("FAIL " + rel + ": " + msg);
      files.push({ rel, ok: false, error: msg });
      errors.push({ rel, error: msg });
    }
  };

  if (manifest && Array.isArray(manifest.files) && manifest.files.length) {
    // 按 manifest 逐个还原：manifest 说该有啥就必须有啥，缺了记错
    const actualCount = countFiles(src);
    if (manifest.files.length !== actualCount) {
      errors.push({ error: `备份目录里有 ${actualCount} 个文件，manifest 记了 ${manifest.files.length} 个` });
    }
    for (const f of manifest.files) restoreOne(f.rel);
  } else {
    // 没有 manifest（老备份）：按目录树走，但明说「无完整性校验」
    logs.push("（该备份没有 manifest.json，无法做完整性校验）");
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        restoreOne(path.relative(src, full));
      }
    };
    walk(src);
  }

  logs.push("\nrestored " + n + " file(s)");
  for (const w of warnings) logs.push("WARN " + w);
  return { restored: n, files, logs, errors, warnings, root, rootMismatch, hasManifest: Boolean(manifest) };
}

/** 数一个目录下有多少个文件（用于对照 manifest）。 */
function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else n++;
    }
  };
  try { walk(dir) } catch { /* 读不到按 0 算 */ }
  return n;
}

/** patches.json 与本模块的相对位置：<pkg>/patches/lib/core.mjs → <pkg>/patches/patches.json */
function resolvePatchesFile() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.join(here, "..", "patches.json");
}
