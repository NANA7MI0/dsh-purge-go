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
import { fileURLToPath } from "node:url";
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
 * 一条补丁要改哪些文件，统一成 [{ pkg, rel }] 列表。
 *
 * 两种写法，**有 targets 就完全不用 file/rel**——不是合并，是取代：
 *  - p.targets = [{ pkg, rel }]：同一个包里改多个不同文件时用
 *    （dsh-web-app/presets/ 下 standard、ptc、cordis 各要改一句）。
 *    老写法只能表达「几个候选包 + 同一个包内路径」，表达不了这种。
 *  - p.file + p.rel：绝大多数补丁仍是这个，路径与改前逐字等价。
 *
 * 取代是有代价的，写 targets 时要想清楚原来那份 file 列表还覆盖了哪些文件。
 * id 63 踩过一次：原本写 base / preset-ptc / preset-standard / preset-cordis，
 * 加 targets 时只列了三个 preset，base 就这么被静默丢掉了。当时判断「base 那段
 * 会被 preset 整行覆盖、改它没用」——**这个判断是错的**：headless profile 的
 * bundles 只有 dsh-base + dsh-headless，根本不加载 web-app 的 preset，
 * 它读的就是 base 里那份 plan-mode 文案。现在 base 已经加回 targets，
 * 一共四个文件（base + standard + ptc + cordis）；minimal 预设本来就没有计划模式，不在此列。
 *
 * targets 项里没写 rel 的退回 relOf(p)；没写 pkg 的项跳过。
 */
export function targetsOf(p, pkgs) {
  if (Array.isArray(p.targets) && p.targets.length > 0) {
    const out = [];
    for (const t of p.targets) {
      if (!t || typeof t.pkg !== "string" || !t.pkg) continue;
      // 包不存在就跳过这一项，别把它当成「有这个包、只是文件不在」。
      // 不跳的话 status 会从 no_pkg 变成 no_file，被算进面板的 applicable 分母，
      // 用户看到一条永远消不掉的待办（id 43/63 在没装 dsh-web-app 的引擎上就是这样）。
      const rel = Array.isArray(t.rel) ? t.rel : typeof t.rel === "string" ? t.rel.split("/").filter(Boolean) : relOf(p);
      // 包不存在时**照样收进来**，但打上 absent 标记——不这样做的话 probe 完全看不见
      // 「这条补丁的目标包被整个删掉了」，于是一条本该 no_file 的补丁仍判 applied，
      // 「已全部打上」的短路就会让删掉的文件永远修不回来（实测：删掉 dsh-acp-app 整个包，
      // probe 仍报 60 applied，而手动 restore 能把文件补回来）。
      if (Array.isArray(pkgs) && pkgs.length > 0 && !pkgs.includes(t.pkg)) {
        out.push({ pkg: t.pkg, rel, absent: true });
        continue;
      }
      out.push({ pkg: t.pkg, rel });
    }
    if (out.length) return out;
  }
  const rel = relOf(p);
  return candidatesFor(p, pkgs).map((pkg) => ({ pkg, rel }));
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
  // markersAny 在数据里全是布尔 true，不是数组；markers 本身已经用 some() 取「任一命中」，
  // 所以这个开关从来没有存在意义。留着这行是为了兼容将来真写成数组的情况。
  if (Array.isArray(p.markersAny)) ms.push(...p.markersAny);
  if (typeof p.marker === "string") ms.push(p.marker);
  // forbid 不是身份标记，这里不参与判断——把它当 marker 会把结论推反（本该判 hit 却判
  // drifted，面板挂一条假的「被覆盖」）。
  // 它的内容两类都有：60/61 是「打补丁前的原始文案」，40/69/85/86 是「另一变体打出来的产物」。
  // 两种都只说明「当前是不是目标状态」，不能说明「是不是我们打的」，所以都不该进 marked()。
  return ms.some((m) => typeof m === "string" && m.length > 3 && text.includes(m));
}

// 下列字段执行器不读，别照着它们改行为：markersAny（布尔，markers 已是任一命中）、
// skipIfMarked（按文件跳过会连别的补丁一起漏）、optional（no_pkg 已不判失败）、
// strictFiles / softSettle（从未实现）、surfaces（桌面专属，靠 no_pkg 兜住）、
// broken（#3/#73/#77 已知打不上，apply 里显式跳过）。

/** 这条 replacement 是否已经落到文件里。追加型（rep 含 pat）只能查完整 rep，
 *  否则永远 partial 且每次 apply 都会再追加一遍（#42 有 4 条是这种）。 */
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
  if (rep !== "" && rep.includes(e.pat)) {
    // 追加型：pat 已经不在文件里了，就不该再当「待处理」。
    // 两种情形都归到这里：① 这条早打过了（rep 也插进去了，pat 可能被后续编辑吃掉）；
    // ② 本机这份文件根本没有这段（版本分支不同）——apply 会因 pat 不存在而跳过。
    // 不这么判的话 #56 的 edit5 会永远 partial：它的 pat 在本机出现 0 次、
    // isDone 又只查完整 rep（永远不在），于是 install.sh --dry 每次都说要改它，
    // 用户反复点「一键注入」也消不掉那条待办。
    if (!text.includes(e.pat)) return true;
    return text.includes(rep);
  }
  return !text.includes(e.pat);
}

/**
 * 逐补丁扫盘判定。
 * @returns {Array<{id,name,status,pkg?,file?,hits?,total?,targets?,files?}>}
 * status: applied | hit | partial | miss | no_needle | no_file | no_pkg
 */
export function probe(root, patches) {
  const table = patches || loadPatches(resolvePatchesFile());
  const pkgs = listPkgs(root);
  const rows = [];
  for (const p of table) {
    const targets = targetsOf(p, pkgs);
    if (!targets.length) { rows.push({ id: p.id, name: p.name, status: "no_pkg", reverse: p.reverse === true }); continue; }
    // 全都没了（包被删/文件被删）→ no_pkg，维持原有语义。
    // 但「一部分在、一部分没了」不能当 applied——那会让 existsSync 那层的 continue
    // 变成盲区：删掉的目标文件永远补不回来，短路还一直说正常。
    const absentTargets = targets.filter((t) => t.absent === true).length;
    const edits = editsOf(p);
    const hitsRows = [];
    let fileMissing = 0;
    for (const { pkg, rel, absent } of targets) {
      if (absent) { fileMissing += 1; continue; }
      const file = path.join(root, pkg, ...rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { fileMissing += 1; continue; }
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
    if (!hitsRows.length) {
      // 去重：一条补丁的多个 targets 常指向同一个包的不同文件，直接 join 会重复列出同一个包名 N 次
      rows.push({ id: p.id, name: p.name, status: "no_file", reverse: p.reverse === true, pkg: [...new Set(targets.map((t) => t.pkg))].join(",") });
      continue;
    }
    const rank = { hit: 4, drifted: 3, partial: 2, applied: 1, miss: 0, no_needle: 0 };
    let top = hitsRows[0];
    for (const r of hitsRows) if ((rank[r.status] ?? 0) > (rank[top.status] ?? 0)) top = r;
    // 「全部 applied」还要加上「目标一个都没缺」——否则删掉的目标文件会让这条补丁
    // 明明没打全却判 applied（existsSync 那层 continue 成了盲区）。
    const anyMissing = fileMissing > 0 || absentTargets > 0;
    const allApplied = hitsRows.every((r) => r.status === "applied");
    rows.push(Object.assign(
      { id: p.id, name: p.name, status: allApplied && !anyMissing ? "applied" : top.status },
      top,
      {
        status: allApplied && !anyMissing ? "applied" : top.status,
        // 缺了几个目标：面板算「是否全打上」时要看它，光看 status 不够
        missingTargets: fileMissing,
        targets: hitsRows.length,
        files: hitsRows.map((r) => r.file),
        // reverse：这条补丁的 markers 写的是「官方原版文案」，所以它在任何没打过补丁的
        // 引擎上都会判 applied——它不改任何东西，只是「万一那段被别的补丁改花了，改回来」。
        // 面板算「补丁是否都打上了」时要把它从分母里剔掉，否则 #2/#3 会让 58 变成 60，
        // 看着像 60 条都被改过，实际只有 58 条。
        reverse: p.reverse === true,
      },
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
/** 读引擎版本（任何 @deepseek-ai 包都行，优先 dsh-base）。读不到就返回 null，不阻断流程。 */
export function engineVersion(root) {
  const names = ["dsh-base", "dsh-session", "dsh-agent-loop"];
  for (const n of names) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(root, n, "package.json"), "utf8")).version;
      if (typeof v === "string" && v) return v;
    } catch { /* 这个包不在，试下一个 */ }
  }
  return null;
}

/** 备份要记的引擎身份：版本 + 真实 root。 */
/** App 版本：从 $DSH_HOME/dsh-app/diagnostics.md 的「- App：ver+code · ver · code」
 * 取中间那段。只有这儿写了版本号（/opt/dsh-app 无 package.json）。读不到返回 null。 */
export function appVersion() {
  try {
    const home = process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh')
    const txt = fs.readFileSync(path.join(home, 'dsh-app', 'diagnostics.md'), 'utf8')
    const m = txt.match(/^- App[：:]\s*(.+)$/m)
    if (!m) return null
    const parts = m[1].split('·').map((s) => s.trim()).filter(Boolean)
    return parts[1] || parts[0] || null
  } catch {
    return null
  }
}

/** 插件当前适配的引擎版本。加新的就在这儿加一行，README 那张表跟着改。 */
export const SUPPORTED_ENGINES = ['0.2.2-rc.1']

export function engineInfo(root) {
  return { version: engineVersion(root), app: appVersion() };
}
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
  // 引擎版本门放在这里，不放调用方：面板早就拦了，CLI 一直没拦，
  // 同一台 9.9.9-unknown 的引擎，面板拒绝、install.sh 却真把 46 个文件改了。
  // 用户按 README 重跑一次 install.sh，正好做了面板劝他别做的事。
  // 放在 core.apply 里，两条路都绕不过去。
  const version = engineVersion(root);
  if (version && !SUPPORTED_ENGINES.includes(version)) {
    return {
      backupDir: dry ? null : "",
      applied: 0,
      failed: 0,
      files: [],
      logs: [],
      errors: [{
        kind: "engine_unsupported",
        error: "当前引擎是 " + version + "，本插件只适配过 " + SUPPORTED_ENGINES.join(" / ")
          + "。强打可能导致引擎起不来，先别注入——等插件发新版适配，或按 README 第 6 章把引擎包重装回适配的版本。",
      }],
    };
  }
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
    // broken 标的是「已知打不上」的补丁（#3/#73/#77）。以前这个字段没人读，
    // 每次 apply 都白扫一遍、还可能改出半截。现在直接跳过并留一行日志。
    if (p?.broken === true) {
      logs.push("skip " + r.id + " " + (r.name || "") + " :: 标注为 broken，不尝试");
      continue;
    }
    for (const file of r.files) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      // 这里不能因为「文件里已经有 marker」就整体跳过。
      // 一条补丁常有多处 pattern，marker 只代表其中一处打上了；
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
    // 字段要和正常路径一致：少了 rolledBack/rollbackFailed/rollbackMissed，
    // 任何用 if (!report.rolledBack) 判失败的新调用方都会被误导。
    return {
      backupDir: null, applied: 0, failed: 0, files: [], logs, errors,
      rolledBack: false, rollbackFailed: false, rollbackMissed: [],
    };
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = backupDir || path.join(cwd, "backup-" + stamp);
  // 记下引擎版本：还原时要用它判断「这份备份是不是当前这版引擎的」。
  // 没有它的话，App 更新后如果不重打补丁就直接点还原，会把旧版引擎的原始文件
  // 写进新版引擎里——版本对不上，轻则补丁失效，重则引擎起不来。
  // 复用已有备份时保留原来的 at：那个时间是「第一次打补丁之前」，还原靠它判断先后。
  // 重写 at 会让这份备份看起来像是刚建的，语义就丢了。
  let prevManifest = null
  if (opts.keepManifestAt && !dry) {
    try { prevManifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch { /* 没有就按新的写 */ }
  }
  // 复用分支只保留 at（「第一次打补丁之前」那个时间），engine 里的版本和 App 版本要按当前刷成新的。
  // 不刷的话：App 从 1.2.0 升到 1.2.1 → 备份里 engine.app 还是旧的（现在只警告不拒绝，
  // engine.app 仍是 1.2.0 → 再点还原还是被拒，永远出不来。
  const manifest = prevManifest
    ? { ...prevManifest, engine: { ...engineInfo(root), app: appVersion() }, files: prevManifest.files || [] }
    : { root, at: new Date().toISOString(), engine: engineInfo(root), files: [] }
  // 备份覆盖所有补丁的候选文件，不只是这次动到的：还原用的是最早那份，
  // 它若只包含首次 apply 动到的文件，后来新增的目标就没东西可还原。
  const backupTargets = new Set(byFile.keys());
  for (const r of rows) {
    for (const f of r.files || []) {
      try { if (fs.existsSync(f) && fs.statSync(f).isFile()) backupTargets.add(f) } catch { /* 读不到就跳过 */ }
    }
  }
  // 复用备份时，缺哪些文件要区别对待：
  //
  //   - 备份里已经有 → 跳过（它存的是打补丁前的原样，磁盘上那份已经打过了，照抄会污染）；
  //   - 备份里没有 → 只有当磁盘上这份还是干净的才能补进去。
  //     如果磁盘上这份已经带 [dsh-purge] 标记，说明备份不完整（早先 apply 只备份了
  //     「这次动到的文件」，后来补丁的目标变多了），补进去的就是脏内容——
  //     而且 manifest 的 sha256 记的正是这份脏内容，还原时校验还会通过。
  //     这种情况必须拒绝复用，让上层提示用户先重装引擎包。
  const dirtyMissed = [];
  for (const file of backupTargets) {
    const rel = path.relative(root, file);
    if (dry) continue;
    const dst = path.join(dir, "files", rel);
    if (prevManifest && fs.existsSync(dst)) continue;
    if (prevManifest) {
      let cur = "";
      try { cur = fs.readFileSync(file, "utf8"); } catch { /* 读不到就当干净 */ }
      if (cur.includes("[dsh-purge]")) { dirtyMissed.push(rel); continue; }
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(file, dst);
    if (!manifest.files.some((f) => f.rel === rel)) {
      manifest.files.push({ rel, size: fs.statSync(dst).size, sha256: sha256(dst) });
    }
  }
  if (dirtyMissed.length) {
    return {
      backupDir: null, applied: 0, failed: 0, files: [], logs,
      errors: [{
        error: `备份不完整：它还缺 ${dirtyMissed.length} 个目标文件（如 ${dirtyMissed[0]}），而这些文件现在已经被打过补丁。继续复用会把脏内容存成原始状态。先按 README 第 6 章重装引擎包，再点一键注入。`,
      }],
      rolledBack: false, rollbackFailed: false, rollbackMissed: [],
    };
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
      // 判据必须与 probe 一致，都用 isDone()：
      //   · 旧写法用 "pattern 在不在文件里"，对**追加型**补丁（rep 含 pat）恰好反着——
      //     那类补丁打完 pattern 仍在，于是已打过也会被算成「要改」；
      //     而链式补丁里最后一条 pattern 已不在时，又会被算成「不用改」。
      //     实测后果：probe 报 applied 59 + partial 1，而 apply --dry 一条都不输出，
      //     用户按 README 跑 dry 排障看到的是空白。
      //   · isDone 的语义就是「这条 edit 落没落进文件」，与后续真实执行同一套判断。
      const real = jobs.filter((j) => {
        const p = table.find((x) => x.id === j.id);
        if (!p) return false;
        return editsOf(p).some((e) => !isDone(e, text0));
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
      // 原子写：先写同目录临时文件、再 rename 覆盖。原来是直接 writeFileSync，
      // 写到一半被中断（OOM / 断电 / Ctrl-C / 进程被杀）会留下截断的引擎文件，
      // 而且这种半截状态不走后面的校验和回滚。
      const tmp = file + ".purge-tmp-" + process.pid;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
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
  if (rolledBack) {
    // 回滚了就把 files 里那些「已经改成功」的条目降级成 rolledBack，
    // 否则调用方按 files 渲染明细会看到「改了 3 个成功」，而实际全撤了。
    for (const f of files) {
      if (f.ok === true) {
        f.ok = false;
        f.rolledBack = true;
        f.error = f.error || "已随事务回滚";
      }
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
  let manifestBroken = false;
  try {
    if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    manifestBroken = true;
    errors.push({ error: "manifest 读取失败：" + (error?.message || String(error)) });
  }
  // manifest 存在但解析不了，和「老备份本来没有 manifest」是两回事：
  // 前者说明这份备份自己坏了，继续走无校验路径会把 41 个引擎文件覆盖掉再报失败、且不回滚。
  // 直接拒绝，让用户换一份备份或重装引擎。
  if (manifestBroken) {
    return { restored: 0, files: [], logs: ["REFUSED: manifest unreadable"], errors, warnings: [], root: opts.root || detectRoot(), rootMismatch: false, hasManifest: true, engineMismatch: false, appMismatch: false, backupVersion: null, currentVersion: null, backupApp: null, currentApp: null };
  }

  const root = opts.root || manifest?.root || detectRoot();
  // manifest 记录的 root 与本次还原的 root 不一致时明确警告——可能是换机器或引擎重装
  const rootMismatch = Boolean(manifest?.root && opts.root && manifest.root !== opts.root);
  // 路径不一致是「警告」不是「错误」：还原本身可能成功，不能因此把 ok 判成 false。
  const warnings = [];
  if (rootMismatch) {
    warnings.push(`备份来自 ${manifest.root}，本次还原到 ${opts.root}，路径不一致`);
  }

  // 版本校验：备份是给哪个引擎版本打的，就必须还原到那个版本上。
  // 这是「App 更新后没重打补丁就点还原」的唯一防线——那种情况下最新备份是旧版的，
  // 硬写回去等于用旧文件覆盖新引擎，补丁失效算轻的，版本对不上会让引擎起不来。
  // 备份没记版本（旧备份）时只警告不拦，否则老用户全被卡死。
  const currentVersion = engineVersion(root);
  const backupVersion = manifest?.engine?.version ?? null;
  const currentApp = appVersion();
  const backupApp = manifest?.engine?.app ?? null;
  // 三层判断，从「不要紧」到「有风险」：
  //
  //   ① App 版本变了、引擎版本没变 → 引擎文件本身没换，只是 App 外壳更新了。
  //      备份里的原始文件仍然是这版引擎的原始文件，还原本身没风险；
  //      但按设计「备份必须是当前状态的原始版」，所以还是提示重建一次。
  //   ② 引擎版本变了、但新版在 SUPPORTED_ENGINES 里 → 我们已经适配过，重新打补丁即可。
  //   ③ 引擎版本变了、且没适配过 → 拒绝还原，并明确告诉用户：这时候点一键注入可能把引擎弄崩。
  const appMismatch = Boolean(backupApp && currentApp && backupApp !== currentApp);
  const engineMismatch = Boolean(backupVersion && currentVersion && backupVersion !== currentVersion);
  const engineSupported = engineMismatch && SUPPORTED_ENGINES.includes(currentVersion);
  if (engineMismatch && !engineSupported) {
    // ③ 没适配过这个引擎：拒绝，并且说清风险。
    // 这时候让用户去点「一键注入」是危险的——补丁按旧版代码写，打到新版上可能把引擎弄崩。
    errors.push({
      error: `备份来自引擎 ${backupVersion}，当前引擎是 ${currentVersion}，这个版本本插件还没适配。` +
        "现在不能还原，也先别点「一键注入」——补丁是照旧版代码写的，打到新版引擎上有可能让它起不来。" +
        "等插件发新版适配之后再动，或者先按 README 第 6 章把引擎包重装回原版。",
      kind: 'engine_unsupported',
    });
  } else if (engineMismatch && engineSupported) {
    // ② 引擎变了但我们适配过：可以放心重打。
    errors.push({
      error: `备份来自引擎 ${backupVersion}，当前是 ${currentVersion}。这个版本已经适配，` +
        "点「一键注入」重打一次就会生成当前版本的备份。",
      kind: 'engine_supported',
    });
  } else if (appMismatch) {
    // ① 只有 App 变了：引擎包本身没换（engine.version 相同），备份里的原始文件
    // 跟当前磁盘上的文件是同一份，还原回去没有风险。**只警告，不拒绝。**
    //
    // 2026-11-23 改：原来这里 push 到 errors 并 return，结果是一条死锁——
    // 面板「一键注入」现在必经一次 restore 还原，而 restore 因为 App 版本变了就拒，
    // 于是补丁打不上、还原也撤不掉；唯一的刷新入口（apply 里重建 manifest）永远到不了。
    // 报错文案还写着「点一键注入重打一次即可」，而用户点的正是它——自相矛盾。
    warnings.push(`备份是在 App ${backupApp} 上打的，现在是 ${currentApp}。引擎包没变，可以正常还原；`
      + "下次注入会生成对齐当前 App 版本的新备份。");
  } else if (backupVersion === null && manifest !== null) {
    warnings.push("这份备份是很早以前打的，没记引擎版本，无法确认是否匹配");
  }
  // 引擎版本不匹配时必须立刻返回——不能记一条错就接着写文件，那等于明知会写坏还照写一遍。
  // （App 版本不匹配不再进这个判断，理由见上。）
  if (engineMismatch) {
    logs.push("REFUSED: version mismatch");
    return { restored: 0, files, logs, errors, warnings, root, rootMismatch, hasManifest: true, engineMismatch, appMismatch, backupVersion, currentVersion, backupApp, currentApp };
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
      // 先校验备份文件本身，再写进引擎包。原来的顺序是先 copy 再核对目标，
      // 备份一旦损坏，坏内容已经落到引擎里了，只留一行错误、不会退回去。
      const expect = manifest?.files?.find((f) => f.rel === rel)?.sha256;
      if (expect) {
        const srcHash = sha256(from);
        if (srcHash && srcHash !== expect) {
          const msg = "备份文件与 manifest 不符，未写入";
          logs.push("FAIL " + rel + ": " + msg);
          files.push({ rel, ok: false, error: msg });
          errors.push({ rel, error: msg });
          return;
        }
      }
      fs.copyFileSync(from, path.join(root, rel));
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
  return { restored: n, files, logs, errors, warnings, root, rootMismatch, hasManifest: Boolean(manifest), engineMismatch: false, backupVersion, currentVersion };
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
  // 必须用 fileURLToPath 而不是 .pathname：后者不解码百分号，
  // 仓库路径里有空格或中文时（/tmp/sp ace、~/我的项目）会变成 %20 直接 ENOENT。
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "patches.json");
}
