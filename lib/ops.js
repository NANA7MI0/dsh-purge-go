// 动作层：面板、命令、工具三处共用同一套实现，避免三份行为分叉。
import { readFileSync } from 'node:fs'
import { backupFile, injectPath, fileBytes } from './home.js'
import { readState, setEnabled, setVariant, setModelVariant } from './state.js'
import { seedInject, writeInject, normalizeText, sanitizeName, listVariants, defaultPromptText } from './prompt.js'
import { loadCategories, applyCategories, addCategory, removeCategory, setCategoryEnabled, resetOverlay } from './categories.js'
import { apply as patchApplyCore, restore as patchRestoreCore, detectRoot, probe, engineVersion, SUPPORTED_ENGINES } from '../patches/lib/core.mjs'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件仓库根（lib/ 的上一级）。用来找 install.sh 留下的旧备份。 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 正文硬上限（字符）：防止一次误粘贴把组装撑爆。 */
export const MAX_PROMPT_CHARS = 200_000

/** 补丁备份根：<home>/dsh-purge/patch-backup/<stamp>/ */
function patchBackupRoot(home) {
  return join(home, 'dsh-purge', 'patch-backup')
}

/**
 * 这份备份缺不缺文件。manifest 记了 N 个，files/ 里没有就是缺——
 * 用它还原会「还原一半」，剩下的文件保持现状，引擎停在混合态。
 * 返回缺的相对路径，空数组表示完整。
 */
export function missingBackupFiles(dir) {
  let m = null
  // 没有 manifest 不算「缺文件」：core.restore 对无 manifest 的备份是支持的（按目录树走，
  // 只是没有完整性校验）。以前这里直接返回一个占位错误，patchRevert 就把它筛掉，
  // 于是 CLI 能还原的老备份，面板一律报「找到的备份都缺文件，请重装引擎包」。
  try { m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) } catch { return [] }
  const raw = Array.isArray(m.files) ? m.files : []
  // 空清单不算「缺文件」：core.restore 对这种 manifest 会退回按目录树还原（core.mjs 里
  // 「没有 manifest 就 walk」那条分支同样适用于 files 为空）。以前这里直接报一条占位错误，
  // 面板就把这份备份筛掉、说「找到的备份都缺文件，请重装引擎包」，而 CLI 那条路能还原。
  if (!raw.length) return []
  // manifest.files 每项是 { rel, size, sha256 }（apply 时写的），也兼容老备份的纯字符串。
  const rels = raw.map((f) => (typeof f === 'string' ? f : f && f.rel)).filter(Boolean)
  if (!rels.length) return ['(manifest 的 files 里没有可用路径)']
  const miss = []
  for (const rel of rels) {
    // rel 是相对引擎 root 的路径，files/ 下同构；去掉开头的 / 再试一次兜底
    const p1 = join(dir, 'files', rel)
    const p2 = join(dir, 'files', String(rel).replace(/^\/+/, ''))
    let found = false
    for (const p of [p1, p2]) {
      try { if (statSync(p).isFile()) { found = true; break } } catch { /* 试下一个 */ }
    }
    if (!found) miss.push(rel)
  }
  return miss
}

/** 这份备份里的文件是不是已经带着补丁标记。带了说明存的是「打完的状态」，
 * 拿它当原始快照用等于把补丁固化，之后怎么还原都撤不掉。
 *
 * 优先看 manifest.appliedIds —— 那是建备份时 probe 出来的、准确的补丁状态，
 * 27/86 条补丁不留 [dsh-purge] 标记，只靠下面的串扫会漏判。
 * 老备份没有这个字段（0.7.3 之前建的），退回串扫，兼容必须留着，
 * 否则用户手上现有的备份会全部被判脏、还原不了。 */
function backupHasPatchTraces(dir) {
  let m = null
  try { m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) } catch { m = null }
  if (m && Array.isArray(m.appliedIds)) return m.appliedIds.length > 0
  const filesDir = join(dir, 'files')
  const walk = (d) => {
    let names = []
    try { names = readdirSync(d, { withFileTypes: true }) } catch { return false }
    for (const ent of names) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) { if (walk(p)) return true; continue }
      if (!/\.(js|mjs|cjs|yml|yaml|json)$/.test(ent.name)) continue
      try { if (readFileSync(p, 'utf8').includes('[dsh-purge]')) return true } catch { /* 读不到就跳过 */ }
    }
    return false
  }
  return walk(filesDir)
}

/**
 * 扫引擎包里带补丁标记的文件，返回相对路径列表。
 *
 * 补丁不只改 lib/*.js。实测 27 个带标记的文件里，有 1 个是 dsh-base/cordis.patch.yml；
 * 只扫 lib 一层的话，引擎被重装后又有人手动补了 yml，这里会判「干净」，
 * 于是把已打补丁的 yml 存成原始状态——以后还原撤不掉它。
 *
 * presets 必须列：dsh-web-app/presets/{cordis,ptc,standard}.patch.yml 是补丁目标，
 * 不扫这里就会漏判——旧版本只扫 lib/、根目录、dist、src 时完全看不见这三处，
 * 于是把「还有补丁」的引擎判成干净，存出脏备份，之后补丁层锁死。
 *
 * countPatchTraces 和 hasPatchTraces 都走这里，避免两套实现日后各改一半。
 */
function traceFiles(root) {
  const out = []
  const pkgs = (() => { try { return readdirSync(root) } catch { return [] } })()
  const SUB = /\.(js|mjs|cjs|yml|yaml|json)$/
  // 递归扫：以前只扫 lib/、根目录、dist、src、presets 五个固定位置的一层，
  // 嵌套目标（比如某个包的 lib/types/index.js）里的标记永远数不到，
  // 于是「还有补丁」的引擎被判成干净，建出脏备份。
  // 跳过 node_modules 和常见的大目录，避免把引擎包整个走一遍。
  const SKIP = new Set(['node_modules', '.git', 'dist-types', 'coverage', '.cache', 'docs', 'locales'])
  // 深度上限 3：补丁目标是源码文件，最深的实际目标也就 lib/types/index.js（3 层）。
  // 不限制的话会把整个引擎（332 个包）走一遍，实测 2670 ms——而它是在每次 apply 前
  // 同步调用的，慢到用户能感觉到卡。enginePatched（走 probe）才是主判据，这里只是兜底。
  const MAX_DEPTH = 3
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!SKIP.has(ent.name)) walk(full, depth + 1)
        continue
      }
      if (!SUB.test(ent.name)) continue
      try {
        if (readFileSync(full, 'utf8').includes('[dsh-purge]')) out.push(full)
      } catch { /* 读不到跳过 */ }
    }
  }
  for (const pkg of pkgs) walk(join(root, pkg), 0)
  return out
}

/** 数一数引擎里还有几个文件带着补丁标记（0 表示干净）。 */
export function countPatchTraces(root) {
  return traceFiles(root).length
}

/** 引擎包里还有没有我们打的标记——有就说明当前文件不是原始状态。 */
/**
 * 引擎里还有多少补丁是「已经打上」的状态。
 *
 * 存在的理由：判断「现在建备份会不会把打过补丁的内容当成原始状态存下来」。
 * 老判据 hasPatchTraces() 靠 [dsh-purge] 哨兵串，但 86 条补丁里有 27 条的 replace
 * 本来就不含这个串——打完那些补丁后文件里一个标记都没有，于是脏引擎被判成干净，
 * 建出来的备份存的是「已打补丁」的内容，之后还原等于什么都没撤、却报成功。
 *
 * 为什么不改成给那 27 条补丁加标记：要逐条改 replace 的插入位置，还得保证不破坏
 * 注释位置和语法，改的是数据面 86 条，风险远大于收益。
 *
 * 代价：probe 实测 199 ms（332 个引擎包）。一次操作里调一次可以接受。
 * @returns {{ ids: (string|number)[], files: string[] }}
 *   ids   状态为 applied 或 partial 的补丁 id
 *   files 这些补丁涉及的文件（相对引擎根的路径）
 */
export function enginePatched(root) {
  const out = { ids: [], files: [] }
  if (!root) return out
  let rows = []
  try { rows = probe(root) } catch { return out }
  const seen = new Set()
  for (const r of rows || []) {
    // 只认 applied，且必须排除反向补丁。
    //
    // 为什么排除 reverse：#2/#3 这类补丁的作用是「把文案改回官方说法」，原版引擎天然满足，
    // 于是在完全没打过补丁的引擎上它们也是 applied。不排除的话，干净引擎会被一路判成脏，
    // 一键注入直接拒绝。
    //
    // 为什么不算 partial：干净引擎上 partial 有 26 条（补丁表里写了多套引擎版本的写法，
    // 本机只有其中一套，剩下的目标不存在），它不是「被打过」的信号。真正的脏是 applied。
    if (r.status !== 'applied') continue
    if (r.reverse === true) continue
    out.ids.push(r.id)
    for (const f of r.files || []) {
      let rel = ''
      try { rel = relative(root, f) } catch { rel = '' }
      if (rel && !seen.has(rel)) { seen.add(rel); out.files.push(rel) }
    }
  }
  return out
}

/** 引擎里有没有补丁痕迹。哨兵串版，留给还需要它的事（install.sh、purge_status）。 */
export function hasPatchTraces(root) {
  return traceFiles(root).length > 0
}
/**
 * 找一个能复用的备份：引擎版本与当前一致、files/ 在、manifest 记了足够多的文件、
 * 且备份本身不带补丁标记。返回最早的一份——它最接近「一条补丁都没打」的时刻。
 */
export function findReusableBackup(home, currentVersion, opts = {}) {
  // 读不到当前引擎版本时一律不复用：那样 `null !== null` 会成立，
  // 把一份来源不明的备份当成「同版本」拿去还原，比没有备份更危险。
  if (!currentVersion) return null
  // opts.requiredRels：当前引擎里所有补丁目标文件的相对路径集合。
  // 传了就要求备份**完整覆盖**它们——只要求「文件数 >= 20」是不够的：
  // 一份 41 文件的旧备份看着像样，但补丁目标后来涨到 47 个，缺的那 6 个不会被还原，
  // 还原完引擎就停在「一半原始一半补丁」的混合态。2026-11-23 实测过这条。
  const required = opts.requiredRels instanceof Set ? opts.requiredRels : null
  const found = []
  const push = (dir) => {
    let m = null
    try { m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) } catch { return }
    if (!m || m.engine?.version !== currentVersion) return
    try { if (!statSync(join(dir, 'files')).isDirectory()) return } catch { return }
    // 光看版本号和 files/ 存在不够：历史备份有几份只覆盖了 2 个文件（早先 apply 只备份
    // 「这次动到的」），拿它复用会让缺的那些文件用「当前已打补丁的内容」补进原始快照，
    // 备份就脏了。这里要求 manifest 里至少记了 20 个文件才算「像样的全量备份」。
    // 20 是个宽松下限：真正全量是 47 个，历史上最小的增量是 2 个。
    if ((m.files || []).length < 20) return
    // 还得看一眼这份备份本身干不干净：原始快照里不该出现任何补丁标记。
    // 2026-11-23 踩过——改动开发中「先还原」还没写完时手动跑了一次 apply，
    // 它把当时已打补丁的文件存进了备份。之后每次「先还原」都在还原这份脏备份，
    // 越滚越脏，restore 报 restored:47 errors:0 却什么都没还原回去。
    // 检查成本低（扫几十个文件），但能挡住这一类自传染。
    if (backupHasPatchTraces(dir)) return
    // 覆盖率：备份必须包含当前全部补丁目标文件，缺一个都不行。
    // 缺了就意味着那几个文件不会被还原，它们会保持「已打补丁」的状态，
    // 而其余文件回到原始态——引擎停在混合态，比不还原更危险。
    if (required && required.size > 0) {
      const have = new Set((m.files || []).map((f) => (typeof f === 'string' ? f : f && f.rel)).filter(Boolean))
      let missing = 0
      for (const rel of required) if (!have.has(rel)) missing += 1
      if (missing > 0) return
    }
    found.push({ dir, at: m.at || '' })
  }
  const base = patchBackupRoot(home)
  try { for (const n of readdirSync(base)) push(join(base, n)) } catch { /* 目录还不存在 */ }
  try {
    for (const n of readdirSync(REPO_ROOT)) {
      if (/^backup-/.test(n)) push(join(REPO_ROOT, n))
    }
  } catch { /* 读不到仓库目录 */ }
  if (!found.length) return null
  found.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  return found[0]
}

/** 删掉除 keepDir 之外的所有备份目录。只在新备份写成之后调。 */
export function pruneOtherBackups(home, keepDir) {
  const base = patchBackupRoot(home)
  // keepDir 必须落在这份备份根下，否则一律不干。
  // 反例：CLI 传了 --backup /tmp/xxx 时，keepDir 在别处，而下面会遍历 base 把
  // 除 keepDir 之外的全删掉——等于把 home 里攒着的旧备份一次清空。
  // 这种调用本来就说明「备份不归我管」，不该把手伸进 home。
  const keepAbs = resolvePath(keepDir)
  const baseAbs = resolvePath(base)
  if (keepAbs !== baseAbs && !keepAbs.startsWith(baseAbs + '/')) return

  const kill = (dir) => {
    // 用 resolve 比，别拿字符串全等：目录可能是相对路径，比不上就会把 keepDir 自己删掉。
    if (resolvePath(dir) === keepAbs) return
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉就留着，不影响功能 */ }
  }
  // 只清插件自己的备份目录，绝不动仓库目录下的 backup-*。
  // 那是 install.sh 时代留下的、以及用户自己可能拷回来的备份，属于用户数据。
  try { for (const n of readdirSync(baseAbs)) kill(join(baseAbs, n)) } catch { /* 无目录 */ }
}
/**
 * 应用补丁。返回真实结果：errors 非空就是失败，调用方据实显示。不吞错、不猜成功。
 */
export function patchApply(home, opts = {}) {
  // 第一件事就挡住 dry：这个函数没有预演语义（面板按钮永远真执行）。
  // 放在后面的话，会先把 probe 扫一遍、甚至走到「引擎还留着补丁」那种更早的
  // 返回分支，报出来的原因跟 dry 无关，排查的人会被带偏。
  if (opts.dry === true) {
    return {
      ok: false, applied: 0, failed: 0, files: [], logs: [],
      errors: [{ error: 'patchApply 不支持 dry 模式；预演请用 install.sh --dry 或 purge-patch.mjs apply --dry' }],
      backupDir: '', rolledBack: false, rollbackFailed: false, rollbackMissed: [],
    }
  }
  const root = opts.root || detectRoot()
  // 备份只留一份原始快照：有同版本的旧备份就复用，没有或版本对不上就删旧建新。
  // 不每次新建是为了让「还原」没有歧义；版本对不上必须换，旧文件写不回新引擎。
  const currentVersion = engineVersion(root)
  // 引擎版本不适配就连备份都不做、直接拒绝：补丁照旧版源码写的，打到新版上轻则白打、
  // 重则改出半截让引擎起不来。App 版本变了不拦——它不影响引擎文件。
  if (currentVersion && !SUPPORTED_ENGINES.includes(currentVersion)) {
    return {
      ok: false, applied: 0, failed: 0, files: [], logs: [],
      errors: [{
        kind: 'engine_unsupported',
        error: `当前引擎是 ${currentVersion}，本插件只适配过 ${SUPPORTED_ENGINES.join(' / ')}。` +
          '强打可能导致引擎起不来，先别注入——等插件发新版适配，或按 README 第 6 章把引擎包重装回适配的版本。',
      }],
      backupDir: '', rolledBack: false, rollbackFailed: false, rollbackMissed: [],
    }
  }
  // 算出当前引擎里全部补丁目标文件的相对路径，要求备份必须完整覆盖——
  // 只要求「文件数够」会选中一份缺文件的旧备份，还原后引擎停在混合态。
  // 一次 probe 两用：既要算「备份必须覆盖哪些文件」，也要判断「是不是本来就没事可做」。
  // 同一份数据扫两遍纯属浪费——probe 要把整个引擎包目录扫一遍，本机就近 1 秒。
  let probed = null
  try { probed = probe(root) } catch { probed = null }
  const requiredRels = (() => {
    const set = new Set()
    for (const row of probed || []) {
      for (const f of row.files || []) {
        try { set.add(relative(root, f)) } catch { /* 跨盘等异常跳过 */ }
      }
    }
    return set
  })()

  // ── 短路：引擎已经全打上了，就别再「还原 + 重打」一遍 ──────────
  //
  // 不加这段的话，用户装好之后每次点「一键注入」都会：还原 47 个文件 → 重打 46 个文件，
  // 本机 4.4～5.4 秒、手机上 10～20 秒，而内容字节级一样——白等，还白建一份新备份。
  // 更糟的是它跟文案自相矛盾：嘴上说「无需再打」，手上却把 46 个文件重写了一遍。
  //
  // 判据必须严：只有「所有目标都 applied」才算完事。任何一条 hit / partial / miss /
  // drifted 都得真去修——宁可多打一次，不能该打不打。
  // reverse 补丁（#2/#3）不改任何文件，不参与这个判断。
  const reallyDone = (() => {
    if (!Array.isArray(probed) || !probed.length) return false
    const real = probed.filter((r) => r?.reverse !== true && r?.status !== 'no_pkg')
    if (!real.length) return false
    // 两个条件都要：目标状态满足（applied）+ 目标没有缺的（missingTargets === 0）。
    // 只看 applied 的话，目标文件被删掉（比如用户手动清了某个包）时它照样算完事，
    // 短路就永远不会去把它补回来——而手动 restore 本来是能补的。
    return real.every((r) => r.status === 'applied' && (r.missingTargets || 0) === 0)
  })()
  // 短路还有个前提：本机得真有一份能用的备份。否则「已打满但备份被删了」这种情况下，
  // 短路会让它永远建不出新备份，用户之后想「还原补丁」就没凭据了。
  // 备份坏了（缺文件/带标记）也走正常流程——那种情况需要重建一份干净的。
  // 备份必须「能用且完整」才算数：
  //   · findReusableBackup 管「版本对、文件数够、不脏、覆盖全」；
  //   · missingBackupFiles 管「manifest 记了的文件在不在 files/ 下」——这一条它不管。
  // 漏掉后者的话，备份缺文件时短路会报「两层都正常」，而用户点「还原补丁」只会撞
  // 「备份都缺文件…请重装引擎包」——同一份状态两个说法。
  const reusableForShort = (() => {
    try {
      const got = findReusableBackup(home, currentVersion, { requiredRels })
      if (!got || !got.dir) return null
      if (missingBackupFiles(got.dir).length > 0) return null
      return got
    } catch { return null }
  })()
  if (reallyDone && reusableForShort && opts.force !== true) {
    return {
      ok: true,
      applied: 0,
      failed: 0,
      files: [],
      logs: ['nothing to apply (already up to date)'],
      errors: [],
      // 带上那份备份的路径——调用方（install.sh 的收尾）会把��报给用户当还原凭据
      backupDir: reusableForShort.dir,
      rolledBack: false,
      rollbackFailed: false,
      rollbackMissed: [],
      upToDate: true,
    }
  }

  const reusable = findReusableBackup(home, currentVersion, { requiredRels })
  let backupDir = reusable?.dir || ''
  // 先还原再重打会把 reusable 这条路径改成「新建」，所以不能是 const
  let isNew = !backupDir
  // 要新建备份时先看一眼：引擎里是不是还留着补丁痕迹。
  //
  // 有痕迹说明当前文件已经被改过，这时候备份下来的是「打过补丁」的状态，
  // 以后拿它还原等于什么都没撤——比没有备份更糟，因为它看起来能还原。
  // 典型场景：App 更新换了引擎、旧备份作废，用户直接点「一键注入」。
  // 判据用 probe 结果，不用哨兵串——27/86 条补丁不留标记，靠串会漏判（见 enginePatched 的注释）
  if (isNew && enginePatched(root).ids.length > 0) {
    return {
      ok: false, applied: 0, failed: 0, files: [], logs: [],
      errors: [{ error: '引擎里还留着上次打的补丁，现在备份会把「已打补丁」的状态存成原始状态。先重装引擎包（见 README 第 6 章），再点一键注入。' }],
      backupDir: '', rolledBack: false, rollbackFailed: false, rollbackMissed: [],
    }
  }
  if (isNew) {
    const now = new Date()
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const ms = String(now.getMilliseconds()).padStart(3, '0')
    const rand = Math.random().toString(36).slice(2, 6)
    backupDir = join(patchBackupRoot(home), `${stamp}${ms}-${rand}`)
  }
  // 先还原再打：apply 只做字符串替换，文件要是被打了一半，起点就是脏的，
  // isDone 会把改坏半截的 pattern 判成「已打过」，永远补不上。
  // 还原后重建备份——旧 manifest 的哈希对应的是打完的状态，留着会 hash_mismatch。
  let preRestore = null
  if (reusable) {
    // 还原之前先验备份完整性。缺文件的备份还原出来是「一半原始一半现状」，
    // 那是比不还原更糟的混合态——而且此时引擎已经被改过，想退都退不回去。
    // 这一步必须在 restore 之前，不能事后再补救。
    const missing = missingBackupFiles(backupDir)
    if (missing.length) {
      return {
        ok: false, applied: 0, failed: 0, files: [], logs: [],
        errors: [{
          error: `找到的备份不完整（manifest 记的文件里有 ${missing.length} 个不在 files/ 下，例：${missing.slice(0, 3).join("、")}）。用它还原会留下半截状态，所以没有动引擎。请重装引擎包，或删掉这份备份重新注入。`
        }],
        backupDir, rolledBack: false, rollbackFailed: false, rollbackMissed: [],
      }
    }
    try {
      const r = patchRestoreCore(backupDir, { root })
      const errs = Array.isArray(r.errors) ? r.errors : []
      if (errs.length) {
        // restore 是逐文件复制，出错时**前面的文件已经写回去了**。
        // 只说「已中止」会让用户以为引擎一点没动，实际可能已经是半截状态。
        const done = r.restored || 0
        return {
          ok: false, applied: 0, failed: 0, files: [], logs: r.logs || [],
          errors: [{
            error: '还原到原始状态时出错，已中止（没有继续打补丁）。'
              + '已经回退了 ' + done + ' 个文件，引擎现在可能停在这份备份与当前状态之间，'
              + '需要重跑一次或重装引擎包。第一个错误：' + (errs[0].error || '未知'),
          }],
          backupDir, rolledBack: false, rollbackFailed: false, rollbackMissed: [],
        }
      }
      preRestore = { restored: r.restored || 0 }
      // 还原之后必须复检一次：备份"完整"不等于"干净"（比如备份里混进了已打补丁的文件，
      // 或者 target 列表扩张后旧备份没覆盖到新文件）。有残留就说明这次还原不可信，
      // 继续打只会把脏状态固化成新备份，所以直接中止——此时引擎已是还原后的状态，
      // 未打任何新补丁，比"打一半"安全。
      // 同上：用 probe 判，不用哨兵串
      if (enginePatched(root).ids.length > 0) {
        return {
          ok: false, applied: 0, failed: 0, files: [], logs: [],
          errors: [{
            error: '从备份还原之后引擎里仍有补丁痕迹，说明这份备份覆盖不全或本身不干净。'
              + '已中止（没有继续打补丁）。请重装引擎包再注入。',
          }],
          backupDir, rolledBack: false, rollbackFailed: false, rollbackMissed: [],
        }
      }
      // 还原成功 ⇒ 这份备份「用掉」了，改成新建路径
      backupDir = ''
    } catch (e) {
      return {
        ok: false, applied: 0, failed: 0, files: [], logs: [],
        errors: [{ error: '还原到原始状态时出错，已中止：' + (e && e.message ? e.message : String(e)) }],
        backupDir, rolledBack: false, rollbackFailed: false, rollbackMissed: [],
      }
    }
  }
  // 还原把 backupDir 清空了 ⇒ 现在按「新建」处理：isNew 要跟着翻，否则后面
  // 「打完清理旧备份」「一条没打上时删空目录」这两个分支都会走错（前者不清、后者不删）。
  // 进了 prerestore 分支 backupDir 必然已被清空，不用再判断
  if (preRestore) {
    isNew = true
    const now2 = new Date()
    const stamp2 = now2.toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const ms2 = String(now2.getMilliseconds()).padStart(3, '0')
    const rand2 = Math.random().toString(36).slice(2, 6)
    backupDir = join(patchBackupRoot(home), `${stamp2}${ms2}-${rand2}`)
  }
  // keepManifestAt 恒 false：走了 prerestore 就一定是「新建备份」，manifest 必须按当前文件重算。
  // 原来写的是 Boolean(reusable) && !preRestore，但 reusable 有值时必然进入 prerestore 分支，
  // 后半永远为 false——是个死条件，直接写死更诚实。
  const report = patchApplyCore(root, { backupDir, keepManifestAt: false })
  // 清理旧备份放在 apply 之后，而且只在这次真的写出了新备份时才做。
  // 之前放在前面：若这次没有可打的补丁（byFile 为空，apply 直接早返回），
  // 旧备份已经被删光、新的又没建——用户就失去了还原凭据。
  // 顺序有讲究：先判「这次没打出东西就删空目录」，再 prune 旧备份。
  // 反过来的话，两条同时成立时会先把旧备份清光、再发现新目录是空的也删掉——
  // 一份备份都不剩，用户彻底失去还原凭据。现在即使两条都成立，先删空目录后
  // report.backupDir 已清空，下面的 prune 条件不成立，旧备份安然留着。
  if (isNew && report.applied === 0 && report.backupDir && !report.rollbackFailed) {
    try {
      rmSync(report.backupDir, { recursive: true, force: true })
      report.backupDir = ''
    } catch {
      /* 删不掉就算了 */
    }
  }
  if (isNew && report.backupDir && existsSync(join(report.backupDir, 'manifest.json'))) {
    pruneOtherBackups(home, report.backupDir)
  }
  // ok 的判据：没有 error，且不是「回滚了」的状态
  const rolledBack = report.rolledBack === true
  const rollbackFailed = report.rollbackFailed === true
  // 三种失败要分开说，别混成一句「失败」：
  //   ① 没改成功但干净回滚了 ② 改了但回滚也失败（最危险）③ 其他错误
  const ok = report.errors.length === 0 && !rolledBack && !rollbackFailed
  let reason = firstReason(report.errors)
  if (rollbackFailed) {
    const miss = (report.rollbackMissed || []).map((m) => m.rel).slice(0, 3).join('、')
    reason = `回滚未完成，${(report.rollbackMissed || []).length} 个文件仍是改后状态${miss ? '（' + miss + '）' : ''}`
  } else if (rolledBack && !reason) {
    reason = '校验未通过，已全部回滚'
  }
  // 目标文件整个不见了的补丁：要单独报出来。
  // 不报的话，这种引擎上点「一键注入」就是静默空转——applied=0、logs 只有
  // "nothing to apply"，用户完全不知道是打满了还是引擎缺文件。
  const missingFiles = Array.isArray(report.missingFiles) ? report.missingFiles : []
  if (!reason && missingFiles.length && report.applied === 0) {
    reason = `有 ${missingFiles.length} 条补丁的目标文件在引擎里不存在（如 ${missingFiles[0].name || missingFiles[0].id}）。`
      + '重装引擎包可以恢复这些文件。'
  }
  return {
    ok,
    applied: report.applied,
    failed: report.failed,
    rolledBack,
    rollbackFailed,
    rollbackMissed: report.rollbackMissed || [],
    backupDir: report.backupDir || '',
    missingFiles,
    errors: report.errors,
    logs: report.logs,
    reason,
  }
}

/** 把 errors 数组压成一句人能读的原因。 */
function firstReason(errors) {
  if (!Array.isArray(errors) || !errors.length) return ''
  const e = errors[0]
  const where = e.rel ? e.rel + '：' : ''
  return where + (e.error || '未知错误')
}

/**
 * 还原补丁：找最近一次备份目录，跑 restore。
 * 没有备份时明确报错，不假装成功。
 */
export function patchRevert(home, opts = {}) {
  // 两个来源都要看：
  //   ① 插件自己「应用补丁」时建的 <home>/dsh-purge/patch-backup/<stamp>/
  //   ② install.sh 用 CLI 打补丁时留在仓库目录的 backup-<stamp>/
  // 只认 ① 的话，第一次安装的人（补丁是脚本打的）点「还原补丁」永远说没有备份。
  // 提前定义：下面筛备份版本要用它，原来它在更后面才定义
  const rootNow = opts.root || detectRoot()

  let candidates = []
  const base = patchBackupRoot(home)
  if (existsSync(base)) {
    for (const n of readdirSync(base)) {
      try {
        if (statSync(join(base, n, 'files')).isDirectory()) candidates.push({ name: n, dir: join(base, n) })
      } catch {
        /* 不是备份目录 */
      }
    }
  }
  try {
    for (const n of readdirSync(REPO_ROOT)) {
      if (!/^backup-/.test(n)) continue
      const dir = join(REPO_ROOT, n)
      try {
        if (statSync(join(dir, 'files')).isDirectory()) candidates.push({ name: n.replace(/^backup-/, ''), dir })
      } catch {
        /* 跳过 */
      }
    }
  } catch {
    /* 读不到仓库目录就只用 ① */
  }
  if (!candidates.length) {
    return {
      ok: false, restored: 0, backupDir: '', reason: '',
      errors: [{ error: '没有可还原的补丁备份' }],
      warnings: [], rootMismatch: false, hasManifest: false,
    }
  }
  // 先按引擎版本筛一遍：备份是给哪个 engine.version 打的，只能还原到那个版本上。
  // 不筛的后果（第六轮实测）：一份更早、版本不符的备份因为「覆盖率一样、时间更早」被选中，
  // 然后 patchRestoreCore 按设计拒绝——而这里直接返回失败，不会退一步去试同版本那份，
  // 用户点「还原补丁」永远失败，还被引导去重打（想撤补丁的人被迫重打）。
  const engineOf = (c) => {
    try { return JSON.parse(readFileSync(join(c.dir, 'manifest.json'), 'utf8'))?.engine?.version ?? null }
    catch { return null }
  }
  const nowVer = engineVersion(rootNow)
  // 这里只做便宜的那道检查：manifest 记的文件在不在（读一个 json + stat 几十个文件）。
  // 贵的「扫全树找补丁痕迹」留到后面按优先级逐个试——那段是全文读 files/ 下每个 js/yml，
  // 单份就上百毫秒，21 份跑满要 1.3 秒以上，而面板按钮回调是同步的、只有 3 秒预算。
  // 常见情况第一份就通过，等于只扫一份。
  const complete = candidates.filter((c) => missingBackupFiles(c.dir).length === 0)
  if (!complete.length) {
    return {
      ok: false, restored: 0, backupDir: '',
      errors: [{
        error: candidates.length
          ? '找到的备份都缺文件（manifest 记了但 files/ 下没有），都不能用来还原。请重装引擎包。'
          : '没有可还原的补丁备份',
      }],
      warnings: [], rootMismatch: false, hasManifest: true, reason: '',
    }
  }
  candidates = complete
  for (const c of candidates) c.ver = engineOf(c)
  // 三级优先，别把「无版本」和「同版本」平权：
  //   ① 引擎版本完全一致 —— 最可信，原始文件就是这版引擎的；
  //   ② 没有记版本的老备份 —— 不确定，但总比没有强；
  //   ③ 记了版本但对不上 —— 最后才用，交给 restore 报原因。
  // 实测（第七轮）：平权的时候一份无版本老备份靠「覆盖率更高」压过了同版本备份，
  // 被选中并把旧文件写回了新引擎，只留一条 warning——那等于用错的文件覆盖对的。
  const exact = candidates.filter((c) => c.ver && nowVer && c.ver === nowVer)
  const unknown = candidates.filter((c) => !c.ver)
  const mismatch = candidates.filter((c) => c.ver && (!nowVer || c.ver !== nowVer))
  if (exact.length) candidates = exact
  else if (unknown.length) candidates = unknown
  else candidates = mismatch

  // 按 manifest 里的真实时间排序，不按目录名。
  // 目录名有三处生成源：CLI 与插件用 toISOString()（UTC），install.sh 用 date（本地时间，
  // 比 UTC 快 8 小时）。两种口径混在同一目录里按字符串排，会把「19:45 本地」排到
  // 「12:38 UTC」后面——而后者其实更新。实测本机 21 份备份里，按名字取的最新
  // （20261119194549，11:45Z）与真实最新（20261119123838，12:38Z）就是错的。
  // 读不到 manifest.at 的（老备份）退回用目录名，并排在最后。
  const atOf = (c) => {
    try {
      const m = JSON.parse(readFileSync(join(c.dir, 'manifest.json'), 'utf8'))
      return typeof m?.at === 'string' ? m.at : ''
    } catch {
      return ''
    }
  }
  for (const c of candidates) c.at = atOf(c)
  candidates.sort((a, b) => {
    if (a.at && b.at) return a.at < b.at ? -1 : a.at > b.at ? 1 : 0
    if (a.at) return 1      // 有时间戳的比没时间的更新（老备份排前面）
    if (b.at) return -1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  // 按「覆盖了多少个当前候选文件」挑备份，不是按最早或最新：历史备份有全量也有增量，
  // 早先只备份当次动到的文件，那几份不含后来新增的目标，用它还原会撤不干净。
  // 版本比对不在这里做——patchRestoreCore 会读备份 manifest 里的 engine.version，
  // 和当前引擎对不上就拒绝还原并报 engineMismatch，防止把旧版文件写进新版引擎。
  const needRels = new Set()
  try {
    for (const row of probe(rootNow)) {
      for (const f of row.files || []) {
        try { needRels.add(relative(rootNow, f)) } catch { /* 跳过 */ }
      }
    }
  } catch { /* 扫不到就退回按文件数排 */ }
  const coverage = (c) => {
    try {
      // 与 missingBackupFiles / requiredRels 用同一套解析：files 每项可能是 {rel,hash}，
      // 也可能是早期备份留下的纯字符串。只取 f.rel 的话，老备份的覆盖率会算成 0。
      const rels = (JSON.parse(readFileSync(join(c.dir, 'manifest.json'), 'utf8')).files || [])
        .map((f) => (typeof f === 'string' ? f : f && f.rel))
        .filter(Boolean)
      if (!needRels.size) return rels.length
      let hit = 0
      for (const rel of rels) if (needRels.has(rel)) hit += 1
      return hit
    } catch { return 0 }
  }
  for (const c of candidates) c.cover = coverage(c)
  // 覆盖率高的优先，同覆盖率时取最早的那份——它最接近「一条都没打」的状态。
  candidates.sort((a, b) => (b.cover - a.cover) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  // 到这里才做贵的那道检查：逐份扫补丁痕迹，第一个「又干净又覆盖全」的用。
  //
  // 两个条件都必须在这里卡死，不能留到还原之后再检查：
  //   · 脏备份（存的是「已打过补丁」的状态）还原等于什么都没撤，还会假报成功；
  //   · 覆盖不全的备份只还原一部分文件，剩下的留在补丁态——而这时引擎已经被写过，
  //     退不回去，等于把用户引擎改成「一半原始一半补丁」的混合态再报失败。
  // 实测（第十轮）：缺 1 个带标记文件的备份会 restored:46 / ok:false，引擎停在混合态。
  const full = needRels.size
  let oldest = ''
  let why = ''
  for (const c of candidates) {
    if (backupHasPatchTraces(c.dir)) { why = 'traces'; continue }
    if (full && c.cover < full) { why = 'cover'; continue }
    oldest = c.dir
    break
  }
  if (!oldest) {
    return {
      ok: false, restored: 0, backupDir: '',
      errors: [{
        error: why === 'cover'
          ? '找到的备份都不完整（没有一份覆盖当前全部 ' + full + ' 个补丁目标），用它还原会留下半截状态，所以没有动引擎。请重装引擎包。'
          : '找到的备份都带着补丁痕迹（存的是「已打过补丁」的状态），拿来还原撤不掉任何东西。请重装引擎包。',
      }],
      warnings: [], rootMismatch: false, hasManifest: true, reason: '',
    }
  }
  const report = patchRestoreCore(oldest, { root: rootNow })
  // 还原之后要看引擎里还剩多少补丁痕迹：备份覆盖不全时，没被覆盖的文件还原不回去，
  // 引擎会停在「一半原始一半补丁」的状态。那种情况不能报 ok——用户以为撤干净了。
  // 判「还有没有补丁留着」必须用 probe 结果，不能用 [dsh-purge] 哨兵串：
  // 86 条补丁里有 27 条的 replace 不含那个串，打完文件里一个标记都没有。
  // 用串判会得出 residue=0，然后在下面那个分支里告诉用户「引擎里也不再有补丁标记、
  // 破甲实际已经撤干净了、不需要重装」——而他这时候其实还带着二十多条补丁。
  // 之前「备份哈希不符」那条就可能走到这里：文件没写回去，却报「已经撤干净」。
  // 两个判据结合用：
  //   · enginePatched 走 probe，准（能看见 27 条不留标记的补丁），但它依赖 patches.json
  //     的包名和真实引擎结构——遇到测试引擎、或者用户改过包布局时可能一条都探不到；
  //   · countPatchTraces 扫 [dsh-purge] 串，粗糙但只依赖文件内容。
  // 取两者较大值：probe 探到了就信它；探不到时还有串兜底，不会因为「一个都没探到」
  // 就宣布撤干净了。
  let residue = 0
  try { residue = Math.max(enginePatched(rootNow).ids.length, countPatchTraces(rootNow)) } catch { residue = 0 }
  // 关键：restored === 0 不能算成功。一个文件都没还原，说明备份空或全失败。
  const hadErrors = (report.errors || []).length > 0
  let ok = !hadErrors && report.restored > 0
  let reason = firstReason(report.errors)
  if (!reason && report.restored === 0) reason = '一个文件都没还原（备份可能为空）'
  // residue 判断不能挂在 ok 后面：还原出错时 ok 已经是 false，residue 那段永远进不去，
  // 于是「已经还原了 46 个、引擎停在半截」这种情况只报一句「还原失败：某个文件名」，
  // 用户以为一点都没动，实际上引擎已经是混合态了——下一句话必须说清这件事。
  if (residue > 0) {
    ok = false
    // restored=0 说明整体被拒、一个字节没写。这时候说「引擎现在是混合态」是假的——
    // 引擎一动不动，还是还原前那个样子。
    const already = report.restored > 0
      ? '已经还原了 ' + report.restored + ' 个文件，'
      : '一个文件都没还原（这份备份被拒绝了，引擎未改动），'
    reason = hadErrors
      ? already + '但有 ' + (report.errors || []).length + ' 个文件没还原（第一个：'
        + String((report.errors[0] || {}).rel || (report.errors[0] || {}).error || '未知')
        + '）。引擎现在是混合态——一部分是原始文件、一部分还是补丁状态（共 ' + residue + ' 条补丁）。'
        + '请重装引擎包恢复干净（重装步骤见 README 第 6 章）。'
      : already + '但引擎里还有 ' + residue
        + ' 条补丁没撤掉——这份备份没覆盖到它们。要彻底撤干净请重装引擎包（见 README 第 6 章）。'
  } else if (hadErrors) {
    // 走到这里的前提就是 residue === 0（上面 if (residue > 0) 已经先返回了），
    // 也就是引擎里**已经一条补丁都不剩**。所以不能说「还剩 0 条」——
    // 那既自相矛盾（0 条还叫没撤干净？），又把用户推去白重装一次整个引擎。
    // 真实情况是：备份里有几个文件内容对不上、没能写回，但剩下的都还原了、引擎已干净。
    ok = false
    reason = '备份里有 ' + (report.errors || []).length + ' 个文件内容对不上（第一个：'
      + String((report.errors[0] || {}).rel || (report.errors[0] || {}).error || '未知')
      + '），这几个没有写回引擎，可能是备份被改过或拷坏了。'
      + '其余 ' + report.restored + ' 个文件已经还原，引擎里现在没有补丁残留——破甲已经撤掉了。'
      + '如果之后发现哪里不对，重装引擎包可以彻底回到干净状态（见 README 第 6 章）。'
  }
  return {
    ok,
    restored: report.restored,
    errors: report.errors,
    // warnings 要透出去：App 版本变化、root 不一致这些提示只在这里产生，
    // 丢掉的话用户永远看不到，只会觉得「还原了但好像哪里不对」。
    warnings: Array.isArray(report.warnings) ? report.warnings : [],
    backupDir: oldest,
    rootMismatch: report.rootMismatch === true,
    hasManifest: report.hasManifest === true,
    reason,
  }
}

export function toggle(home) {
  const next = !readState(home).enabled
  setEnabled(home, next)
  return { enabled: next }
}

/** 关掉注入，顺便把当前 prompt-inject.md 备份一份，方便反悔。 */
export function revert(home) {
  const backup = backupFile(home, injectPath(home))
  setEnabled(home, false)
  return { enabled: false, backup }
}

/**
 * 补一次「更新收尾没跑完留下的注入状态」。
 *
 * 更新收尾第 1 步会关注入、第 6 步恢复，中间靠 finally 兜。但手机上的后台进程
 * 常用 SIGKILL 收场——SIGKILL 不执行 finally。所以收尾一开始就往
 * <home>/dsh-purge/pending-restore.json 写一份「更新前是开还是关」，
 * 插件下次启动时读它补上，读完就删。
 *
 * @returns {{ resumed: boolean, wasOn?: boolean, reason?: string }}
 */
export function resumePendingRestore(home) {
  const marker = join(home, 'dsh-purge', 'pending-restore.json')
  let m = null
  try { m = JSON.parse(readFileSync(marker, 'utf8')) } catch { return { resumed: false } }
  if (!m || typeof m !== 'object') {
    try { rmSync(marker, { force: true }) } catch { /* 删不掉下次再来 */ }
    return { resumed: false }
  }
  // 超过一天的不认：那是很早以前留下的，恢复它反而会覆盖用户后来的选择
  const at = Date.parse(String(m.at || ''))
  if (Number.isFinite(at) && Date.now() - at > 24 * 3600 * 1000) {
    try { rmSync(marker, { force: true }) } catch { /* 忽略 */ }
    return { resumed: false, reason: 'marker 太旧' }
  }
  const want = m.wasOn === true
  try {
    setEnabled(home, want)
    rmSync(marker, { force: true })
    return { resumed: true, wasOn: want }
  } catch {
    return { resumed: false, reason: '写不进去' }
  }
}

export function seed(home, opts = {}) {
  // force 会覆盖用户手写的正文，覆盖前必须留一份。revert() 早就在用 backupFile，
  // 只是这条路径一直没接上——用户点「落盘默认」就再也找不回自己写的那份。
  let backup = ''
  if (opts.force === true) {
    try { backup = backupFile(home, injectPath(home)) } catch { backup = '' }
  }
  const result = seedInject(home, { force: opts.force === true })
  return { written: result.written, path: result.path, bytes: result.bytes, backup }
}

export function setPrompt(home, text) {
  const body = normalizeText(text)
  if (!body) throw new Error('正文为空')
  if (body.length > MAX_PROMPT_CHARS) throw new Error(`正文超过 ${MAX_PROMPT_CHARS} 字符上限`)
  const written = writeInject(home, body)
  return { bytes: written.bytes, path: written.path }
}

export function useVariant(home, name) {
  // 用原始名比较，和 listVariants 返回的名字保持一致（理由见 variantPath 的注释）
  const key = String(name ?? '').trim()
  if (!key) throw new Error('变体名为空')
  const known = listVariants(home).some((variant) => variant.name === key)
  if (!known) throw new Error(`没有变体 ${key}（dsh-purge/prompts/${key}.md）`)
  setVariant(home, key)
  return { variant: key }
}

export function resetVariant(home) {
  setVariant(home, 'default')
  return { variant: 'default' }
}

export function mapModel(home, model, name) {
  // 模型名用原始值当键，不按文件名清洗：sanitizeName 会把中文压成空串再退回 'default'，
  // 于是所有中文模型塌成同一个键、互相覆盖，面板还显示「模型 default」。
  // 先判原始值非空——以前这行判断永远不成立，因为 sanitizeName 保证返回非空串。
  const modelKey = String(model ?? '').trim()
  if (!modelKey) throw new Error('模型名为空')
  if (!name || name === 'default') {
    setModelVariant(home, modelKey, '')
    return { model: modelKey, variant: '' }
  }
  // 用原始名比较，和 listVariants 返回的名字保持一致：
  // 列表里显示『MyPrompt』，命令行就得能敲『MyPrompt』。
  const key = String(name ?? '').trim()
  const known = listVariants(home).some((variant) => variant.name === key)
  if (!known) throw new Error(`没有变体 ${key}`)
  setModelVariant(home, modelKey, key)
  return { model: modelKey, variant: key }
}

/** 复制用：复制通道上限 8000 字。 */
export function copyText(snap) {
  const limit = 7990
  if (snap.text.length <= limit) return { text: snap.text, truncated: false }
  return { text: snap.text.slice(0, limit), truncated: true }
}

export function injectSize(home) {
  return fileBytes(injectPath(home))
}

// 题材分类扩展层
// 面板、/purge cat 命令、工具都走这里，避免三份行为分叉。

export function categoryList(home) {
  const loaded = loadCategories(home)
  return { entries: loaded.entries, all: loaded.all, warnings: loaded.warnings, maxN: loaded.maxN }
}

export function categoryAdd(home, payload) {
  return addCategory(home, payload)
}

export function categoryRemove(home, id) {
  return removeCategory(home, id)
}

export function categoryToggle(home, id, enabled) {
  return setCategoryEnabled(home, id, enabled)
}

export function categoryReset(home) {
  resetOverlay(home)
  return categoryList(home)
}

/** 把当前分类真正写进 prompt-inject.md（之后即使关掉扩展层，正文里也留着）。 */
export function categoryBake(home) {
  const entries = loadCategories(home).entries
  const current = normalizeText(readInjectText(home)) || normalizeText(defaultPromptText())
  if (!current) throw new Error('没有可写的正文')
  const baked = applyCategories(current, entries)
  if (baked.length > MAX_PROMPT_CHARS) throw new Error(`写入后超过 ${MAX_PROMPT_CHARS} 字符上限`)
  const written = writeInject(home, baked)
  return { bytes: written.bytes, path: written.path, categories: entries.length }
}

function readInjectText(home) {
  try {
    return readFileSync(injectPath(home), 'utf8')
  } catch {
    return ''
  }
}
