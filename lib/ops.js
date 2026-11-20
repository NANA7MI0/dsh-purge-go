// 动作层：面板、命令、工具三处共用同一套实现，避免三份行为分叉。
import { readFileSync } from 'node:fs'
import { backupFile, injectPath, fileBytes } from './home.js'
import { readState, setEnabled, setVariant, setModelVariant } from './state.js'
import { seedInject, writeInject, normalizeText, sanitizeName, listVariants, defaultPromptText } from './prompt.js'
import { loadCategories, applyCategories, addCategory, removeCategory, setCategoryEnabled, resetOverlay } from './categories.js'
import { apply as patchApplyCore, restore as patchRestoreCore, detectRoot, probe, engineVersion } from '../patches/lib/core.mjs'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
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
 * 应用补丁。返回真实结果：errors 非空就是失败，调用方据实显示。
 * 不吞错、不猜成功。
 */
/**
 * 找一个能复用的备份：引擎版本和当前一致、files/ 目录存在、manifest 里记了时间。
 * 返回最早的一个——它最接近「一条补丁都没打」的时刻。
 */
/** 引擎包里还有没有我们打的标记——有就说明当前文件不是原始状态。 */
function hasPatchTraces(root) {
  const pkgs = (() => { try { return readdirSync(root) } catch { return [] } })()
  for (const pkg of pkgs) {
    const lib = join(root, pkg, 'lib')
    let files = []
    try { files = readdirSync(lib) } catch { continue }
    for (const f of files) {
      if (!/\.(js|mjs|cjs)$/.test(f)) continue
      try { if (readFileSync(join(lib, f), 'utf8').includes('[dsh-purge]')) return true } catch { /* 读不到就跳过 */ }
    }
  }
  return false
}
function findReusableBackup(home, currentVersion) {
  const found = []
  const push = (dir) => {
    let m = null
    try { m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) } catch { return }
    if (!m || m.engine?.version !== currentVersion) return
    try { if (!statSync(join(dir, 'files')).isDirectory()) return } catch { return }
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
function pruneOtherBackups(home, keepDir) {
  const kill = (dir) => {
    if (dir === keepDir) return
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉就留着，不影响功能 */ }
  }
  const base = patchBackupRoot(home)
  try { for (const n of readdirSync(base)) kill(join(base, n)) } catch { /* 无目录 */ }
  try {
    for (const n of readdirSync(REPO_ROOT)) {
      if (/^backup-/.test(n)) kill(join(REPO_ROOT, n))
    }
  } catch { /* 读不到就跳过 */ }
}
export function patchApply(home, opts = {}) {
  const root = opts.root || detectRoot()
  // 备份只保留一份，而且必须是「没打过补丁」的那份。
  //
  // 规则：
  //   · 已有备份、且引擎版本和当前一致 → 直接复用，不新建（里面存的就是原始文件）。
  //   · 没有备份、或引擎版本对不上（App 更新换了引擎）→ 旧备份作废，删掉，新建一份。
  //
  // 为什么不每次新建：那样会攒一堆备份，还原时还得挑哪份是全量的、哪份是增量的。
  // 只留一份之后，「还原」就是「把这份写回去」，没有歧义。
  //
  // 为什么版本对不上要删：App 更新后引擎换了，旧备份里的原始文件写不回新引擎
  // （restore 会因 engineMismatch 拒绝）。留着它只会让人点还原时撞墙，
  // 不如在重打补丁时就用新的原始文件覆盖掉。
  const currentVersion = engineVersion(root)
  const reusable = findReusableBackup(home, currentVersion)
  let backupDir = reusable?.dir || ''
  const isNew = !backupDir
  // 要新建备份时先看一眼：引擎里是不是还留着补丁痕迹。
  //
  // 有痕迹说明当前文件已经被改过，这时候备份下来的是「打过补丁」的状态，
  // 以后拿它还原等于什么都没撤——比没有备份更糟，因为它看起来能还原。
  // 典型场景：App 更新换了引擎、旧备份作废，用户直接点「一键注入」。
  if (isNew && hasPatchTraces(root)) {
    return {
      ok: false, applied: 0, failed: 0, files: [], logs: [],
      errors: [{ error: '引擎里还留着上次打的补丁，现在备份会把「已打补丁」的状态存成原始状态。先重装引擎包（见 README 15.2），再点一键注入。' }],
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
  const report = patchApplyCore(root, { backupDir, keepManifestAt: Boolean(reusable) })
  // 清理旧备份放在 apply **之后**，而且只在这次真的写出了新备份时才做。
  // 之前放在前面：若这次没有可打的补丁（byFile 为空，apply 直接早返回），
  // 旧备份已经被删光、新的又没建——用户就失去了还原凭据。
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
  // 一条都没打上（补丁已经是全打上的状态）时，backupDir 里只会躺着
  // 「试过但没打上」的那几个文件，写回去内容一模一样。这种空备份留着有害：
  // patchRevert 取最新的一份，会把真正有用的「打补丁前」快照挤掉。
  if (report.applied === 0 && report.backupDir) {
    try {
      rmSync(report.backupDir, { recursive: true, force: true })
      report.backupDir = ''
    } catch {
      /* 删不掉就算了 */
    }
  }
  return {
    ok,
    applied: report.applied,
    failed: report.failed,
    rolledBack,
    rollbackFailed,
    rollbackMissed: report.rollbackMissed || [],
    backupDir: report.backupDir || '',
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
  const candidates = []
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
    return { ok: false, restored: 0, errors: [{ error: '没有可还原的补丁备份' }], backupDir: '' }
  }
  // 按 manifest 里的真实时间排序，**不按目录名**。
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
  // 用**最早那份备份**还原——它存的是打补丁之前的原样，一次就回到最初状态。
  //
  // 前提是每份备份都是全量的（apply 里已改成备份所有补丁的候选文件），
  // 所以随便挑哪一份都能还原干净；挑最早的是为了回到「一条都没打」的状态。
  //
  // 版本比对在 patchRestoreCore 里做：备份 manifest 里记了 engine.version，
  // 和当前引擎对不上就拒绝还原并报 engineMismatch——防止 App 更新后把旧版引擎的文件
  // 写进新版里。
  // 挑「覆盖最全」的那份备份，不是「最早」也不是「最新」。
  //
  // 为什么要按覆盖判断：历史备份有全量也有增量——早先 apply 只备份这次动到的文件，
  // 那几份 41 个文件的备份还不含后来才加的 dsh-client-ui-conversation/lib/client.js。
  // 只按文件数排，两份都是 41，会挑到不含 client.js 的那份，那个文件的补丁就撤不掉。
  // 按「这份备份覆盖了多少个当前候选文件」排序，才能挑到真正能还原干净的那份。
  const rootNow = opts.root || detectRoot()
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
      const rels = (JSON.parse(readFileSync(join(c.dir, 'manifest.json'), 'utf8')).files || []).map((f) => f.rel)
      if (!needRels.size) return rels.length
      let hit = 0
      for (const rel of rels) if (needRels.has(rel)) hit += 1
      return hit
    } catch { return 0 }
  }
  for (const c of candidates) c.cover = coverage(c)
  const bestCover = Math.max(...candidates.map((c) => c.cover))
  // 同覆盖率时取最早的——它最接近「一条都没打」的状态
  const best = candidates.filter((c) => c.cover === bestCover)
  const oldest = best[0].dir
  const report = patchRestoreCore(oldest, { root: rootNow })
  const latest = oldest
  // 关键：restored === 0 不能算成功。一个文件都没还原，说明备份空或全失败。
  const ok = report.errors.length === 0 && report.restored > 0
  let reason = firstReason(report.errors)
  if (!reason && report.restored === 0) reason = '一个文件都没还原（备份可能为空）'
  return {
    ok,
    restored: report.restored,
    errors: report.errors,
    backupDir: latest,
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

export function seed(home, opts = {}) {
  const result = seedInject(home, { force: opts.force === true })
  return { written: result.written, path: result.path, bytes: result.bytes }
}

export function setPrompt(home, text) {
  const body = normalizeText(text)
  if (!body) throw new Error('正文为空')
  if (body.length > MAX_PROMPT_CHARS) throw new Error(`正文超过 ${MAX_PROMPT_CHARS} 字符上限`)
  const written = writeInject(home, body)
  return { bytes: written.bytes, path: written.path }
}

export function useVariant(home, name) {
  const key = sanitizeName(name)
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
  const modelKey = sanitizeName(model)
  if (!modelKey) throw new Error('模型名为空')
  if (!name || name === 'default') {
    setModelVariant(home, modelKey, '')
    return { model: modelKey, variant: '' }
  }
  const key = sanitizeName(name)
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

// ── 题材分类扩展层 ──────────────────────────────────────────────
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
