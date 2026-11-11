// 题材分类扩展层（category overlay）。
//
// 背景：正文里 Scoped Rules 1-25 与 Intent mapping 是硬编码在 assets/default-prompt.md 里的，
// 想加/删一类题材就得动 200KB 的 md，还会把用户自己改过的 prompt-inject.md 覆盖掉。
// 这里把「扩展分类」抽成数据：assets/categories.json 是出厂值，
// <DSH_HOME>/dsh-purge/categories.json 是覆盖层（按 id 合并，支持 enabled:false / removed:true）。
//
// 正文里用两对标记圈出可重写区：
//   <!-- purge:scoped:begin --> … <!-- purge:scoped:end -->   → Scoped Rules 26+
//   <!-- purge:intent:begin --> … <!-- purge:intent:end -->   → Intent mapping 扩展行
// 组装时整块重算，所以增删分类是幂等的，不会越叠越长。
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJson, purgeDir, dshHome, ensureDir } from './home.js'

export const CATEGORIES_VERSION = 1

export const SCOPED_BEGIN = '<!-- purge:scoped:begin -->'
export const SCOPED_END = '<!-- purge:scoped:end -->'
export const INTENT_BEGIN = '<!-- purge:intent:begin -->'
export const INTENT_END = '<!-- purge:intent:end -->'

const PKG_URL = new URL('../assets/categories.json', import.meta.url)
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const MAX_LABELS = 16
const MAX_RULE = 1200

export function categoriesPath(home = dshHome()) {
  return path.join(purgeDir(home), 'categories.json')
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 出厂分类（包内 assets/categories.json）。读不到就是空表，不抛。 */
export function packageEntries() {
  try {
    const raw = JSON.parse(fs.readFileSync(PKG_URL, 'utf8'))
    return Array.isArray(raw?.entries) ? raw.entries : []
  } catch {
    return []
  }
}

/** 覆盖层原始条目（不做校验，合并时再规范化）。 */
export function readOverlay(home = dshHome()) {
  const raw = readJson(categoriesPath(home), {}) || {}
  return Array.isArray(raw.entries) ? raw.entries : []
}

export function writeOverlay(home, entries) {
  const target = categoriesPath(home)
  ensureDir(path.dirname(target))
  writeJson(target, { version: CATEGORIES_VERSION, entries: Array.isArray(entries) ? entries : [] })
  return target
}

export function resetOverlay(home) {
  return writeOverlay(home, [])
}

/**
 * 规范化一条分类。removed:true 的墓碑条目只需 id（用来删出厂项）。
 * @returns {null | {id:string,n:number,labels:string[],rule:string,route:string,enabled:boolean,removed:boolean,source:string,addedAt:string}}
 */
export function normalizeEntry(raw, fallbackN = 0, source = 'pkg') {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '')
    .trim()
    .toLowerCase()
  if (!ID_RE.test(id)) return null
  if (raw.removed === true) {
    return { id, n: 0, labels: [], rule: '', route: '', enabled: false, removed: true, source, addedAt: '' }
  }
  const labels = []
  const input = Array.isArray(raw.labels) ? raw.labels : [raw.label]
  for (const item of input) {
    const label = String(item || '').trim()
    if (label && !labels.includes(label)) labels.push(label)
    if (labels.length >= MAX_LABELS) break
  }
  if (!labels.length) return null
  const rule = String(raw.rule || '')
    .trim()
    .slice(0, MAX_RULE)
  if (!rule) return null
  const n = Number.isFinite(raw.n) && raw.n > 0 ? Math.floor(raw.n) : Math.floor(fallbackN)
  return {
    id,
    n,
    labels,
    rule,
    route: String(raw.route || '').trim(),
    enabled: raw.enabled !== false,
    removed: false,
    source,
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : '',
  }
}

/**
 * 出厂值 + 覆盖层合并。覆盖层按 id 覆盖，removed:true 删除，enabled:false 保留但不出现在正文里。
 * @returns {{entries:any[], all:any[], warnings:string[], maxN:number}}
 */
export function loadCategories(home = dshHome()) {
  const warnings = []
  const map = new Map()
  let nextN = 26
  for (const raw of packageEntries()) {
    const entry = normalizeEntry(raw, nextN, 'pkg')
    if (!entry) {
      warnings.push(`出厂分类无效：${JSON.stringify(raw)?.slice(0, 80)}`)
      continue
    }
    map.set(entry.id, entry)
    nextN = Math.max(nextN, entry.n + 1)
  }
  for (const raw of readOverlay(home)) {
    const entry = normalizeEntry(raw, nextN, 'user')
    if (!entry) {
      warnings.push(`覆盖层分类无效：${JSON.stringify(raw)?.slice(0, 80)}`)
      continue
    }
    if (entry.removed) {
      map.delete(entry.id)
      continue
    }
    map.set(entry.id, entry)
    nextN = Math.max(nextN, entry.n + 1)
  }
  const all = [...map.values()].sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : 1))
  return { entries: all.filter((entry) => entry.enabled), all, warnings, maxN: nextN }
}

/** Scoped Rules 扩展块的正文（不含标记）。 */
export function renderScoped(entries) {
  return entries
    .filter((entry) => entry.rule)
    .map((entry) => `${entry.n}. ${entry.rule}`)
    .join('\n')
}

/** Intent mapping 扩展行的正文（不含标记）。 */
export function renderIntent(entries) {
  return entries
    .filter((entry) => entry.route && entry.labels.length)
    .map((entry) => `- ${entry.labels.join(' / ')} → ${entry.route}`)
    .join('\n')
}

function replaceRegion(text, begin, end, body) {
  const re = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}`)
  const block = body ? `${begin}\n${body}\n${end}` : `${begin}\n${end}`
  return { text: text.replace(re, block), hit: re.test(text) }
}

/** 收掉空标记对，避免正文里留一地空壳。 */
function collapseEmpty(text) {
  return text
    .replace(new RegExp(`${escapeRe(SCOPED_BEGIN)}\\s*${escapeRe(SCOPED_END)}`, 'g'), '')
    .replace(new RegExp(`${escapeRe(INTENT_BEGIN)}\\s*${escapeRe(INTENT_END)}`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

const FALLBACK_HEAD = '═══════════════════════════════════════\nCategory Overlay — 题材分类扩展\n═══════════════════════════════════════'

/**
 * 把分类写进正文。标记存在就整块替换；标记缺失就在文末补一块（带标记，下次可重算）。
 * entries 为空时等于「清空扩展」，正文回到只有 1-25 的状态。
 */
export function applyCategories(text, entries) {
  const src = String(text ?? '')
  if (!src.trim()) return src
  const scoped = renderScoped(entries)
  const intent = renderIntent(entries)

  const hasScoped = src.includes(SCOPED_BEGIN) && src.includes(SCOPED_END)
  const hasIntent = src.includes(INTENT_BEGIN) && src.includes(INTENT_END)

  if (hasScoped && hasIntent) {
    let out = replaceRegion(src, SCOPED_BEGIN, SCOPED_END, scoped).text
    out = replaceRegion(out, INTENT_BEGIN, INTENT_END, intent).text
    return collapseEmpty(out)
  }

  if (hasScoped || hasIntent) {
    // 只带一对标记：把缺的那半并进已有的块，别让正文出现两处编号。
    const combined = [scoped, intent].filter(Boolean).join('\n\n')
    const out = hasScoped
      ? replaceRegion(src, SCOPED_BEGIN, SCOPED_END, combined).text
      : replaceRegion(src, INTENT_BEGIN, INTENT_END, combined).text
    return collapseEmpty(out)
  }

  if (!scoped && !intent) return src

  const block = [
    FALLBACK_HEAD,
    '',
    SCOPED_BEGIN,
    scoped || '',
    SCOPED_END,
    '',
    INTENT_BEGIN,
    intent || '',
    INTENT_END,
  ].join('\n')
  return collapseEmpty(`${src}\n\n${block}`)
}

/**
 * 这份正文是不是本插件的破甲正文（而不是用户自己换上去的任意文本）。
 * 任意文本不该被悄悄塞进规则，所以只在带标记、或带破甲正文特征时才拼扩展层。
 */
export function looksLikeFrame(text) {
  const src = String(text ?? '')
  return hasMarkers(src) || /Scoped Rules/.test(src) || /HARD OUTPUT RULES/.test(src)
}

/** 正文里是否已经圈好了扩展区。 */
export function hasMarkers(text) {
  const src = String(text ?? '')
  return src.includes(SCOPED_BEGIN) && src.includes(INTENT_BEGIN)
}

/**
 * 加一条分类（写覆盖层）。n 不传就接在现有最大编号后面。
 * @returns {{entry:any, entries:any[]}}
 */
export function addCategory(home, { id, labels, rule, route = '', n = 0 }) {
  const key = String(id || '')
    .trim()
    .toLowerCase()
  if (!ID_RE.test(key)) throw new Error(`分类 id 不合法：${id}（小写字母/数字/-/_，≤32 字符）`)
  const list = typeof labels === 'string' ? labels.split(/[,，/、\s]+/) : labels
  const entry = normalizeEntry({ id: key, labels: list, rule, route, n, enabled: true }, 0, 'user')
  if (!entry) throw new Error('分类内容不完整：至少要 id、别名、规则正文')
  const overlay = readOverlay(home)
  const current = loadCategories(home)
  if (!entry.n) entry.n = current.maxN
  entry.addedAt = new Date().toISOString()
  const byId = new Map(overlay.map((raw) => [String(raw?.id || '').toLowerCase(), raw]))
  byId.set(key, { ...entry, source: 'user' })
  const next = [...byId.values()]
  writeOverlay(home, next)
  return { entry, entries: loadCategories(home).entries }
}

/** 删一条：出厂项写墓碑，自己加的项直接从覆盖层拿掉。 */
export function removeCategory(home, id) {
  const key = String(id || '')
    .trim()
    .toLowerCase()
  const overlay = readOverlay(home)
  const fromPkg = packageEntries().some((raw) => String(raw?.id || '').toLowerCase() === key)
  const kept = overlay.filter((raw) => String(raw?.id || '').toLowerCase() !== key)
  const existed = kept.length !== overlay.length || fromPkg
  if (fromPkg) kept.push({ id: key, removed: true })
  writeOverlay(home, kept)
  return { removed: existed, entries: loadCategories(home).entries }
}

/** 单条开关：开着但不出现在正文里，比删掉更好反悔。 */
export function setCategoryEnabled(home, id, enabled) {
  const key = String(id || '')
    .trim()
    .toLowerCase()
  const current = loadCategories(home)
  const hit = current.all.find((entry) => entry.id === key)
  if (!hit) throw new Error(`没有这个分类：${id}`)
  const overlay = readOverlay(home)
  const kept = overlay.filter((raw) => String(raw?.id || '').toLowerCase() !== key)
  kept.push({ ...hit, enabled: Boolean(enabled), removed: false, source: 'user' })
  writeOverlay(home, kept)
  return { entry: { ...hit, enabled: Boolean(enabled) }, entries: loadCategories(home).entries }
}
