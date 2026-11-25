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
import { readJson, writeJson, purgeDir, dshHome, ensureDir, appendDiag } from './home.js'

/**
 * 同一类失败只写一次诊断。
 *
 * 这个函数在 resolveInject 里被反复调用（面板每 30 秒刷新一次、每次注入都会走一遍），
 * 每次都 append 的话日志会几小时内涨到几十 KB，把真正有用的线索冲掉。
 * 只在进程内去重——重启后第一次仍会记，够用来定位问题。
 */
const DIAG_SEEN = new Set()
function diagOnce(key, message) {
  if (DIAG_SEEN.has(key)) return
  DIAG_SEEN.add(key)
  appendDiag(process.env.DSH_HOME || '', { stage: 'categories', key, message })
}
import { openBox } from './table-read.js'

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

/**
 * 出厂分类。两条路，先明文后密封副本：
 *   · 仓库里开发时读 assets/categories.json（这份不进 git，和 default-prompt.md 一样）；
 *   · 装到用户机器上时只有 lib/categories-table.json（node scripts/embed-categories.mjs 封的），
 *     解开来是同一份 JSON。
 * 为什么封：这份的 rule 会拼进注入正文，明文摆在公开仓库里会被整库文本扫描看见，
 * 主正文当初就是为这个封的（见 lib/table-key.js 开头）。读不到就是空表，不抛。
 */
export function packageEntries() {
  // 顺序：密文优先，明文只在开发态用。
  //
  // 以前是明文优先。问题是 install.sh 以前会把 assets/ 整份复制进原生目录，
  // 而 0.7.2 之前 assets/categories.json 是被 git 跟踪的——老用户升上来，
  // 原生目录里还留着一份旧明文，于是读到的永远是它，仓库里新封的密文被完全架空。
  // 表现为「修了等于没修」，而且以后改分类也不会生效。
  //
  // 开发时要改分类：设 DSH_PURGE_DEV=1 就用明文（改完跑 embed 脚本封回去）。
  const dev = process.env.DSH_PURGE_DEV === '1'
  const fromPlain = () => {
    const raw = JSON.parse(fs.readFileSync(PKG_URL, 'utf8'))
    return Array.isArray(raw?.entries) ? raw.entries : null
  }
  if (dev) {
    try {
      const hit = fromPlain()
      if (hit) return hit
    } catch { /* 没有明文就往下走 */ }
  }
  try {
    const text = openBox(new URL('./categories-table.json', import.meta.url))
    if (text) {
      const raw = JSON.parse(text)
      if (Array.isArray(raw?.entries)) return raw.entries
    } else {
      // 密文解不开：整层分类会消失，注入静默缩水一千多字节。
      // 面板那边现在能看出「分类层是空的」，但排障需要知道是哪一步坏的。
      diagOnce('categories-sealed', '分类密文解不开（lib/categories-table.json）')
    }
  } catch (error) {
    diagOnce('categories-sealed', '分类密文读取失败：' + String(error?.message || error).slice(0, 80))
  }
  try {
    const hit = fromPlain()
    if (hit) return hit
  } catch { /* 都没有就是空表 */ }
  return []
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
  }
  if (!labels.length) return null
  // 超限直接拒绝，不静默截断：用户写了 1500 字规则、实际只存 1200 字，
  // 而回话只说「已加分类」——他会以为写进去的就是全部，之后怎么改都不对。
  if (labels.length > MAX_LABELS) {
    throw new Error(`别名最多 ${MAX_LABELS} 个，这条写了 ${labels.length} 个`)
  }
  if (labels.some((l) => /<!--\s*purge:/.test(l))) {
    throw new Error('别名里不能出现 <!-- purge: 这样的标记文本')
  }
  const ruleRaw = String(raw.rule || '').trim()
  if (!ruleRaw) return null
  if (ruleRaw.length > MAX_RULE) {
    throw new Error(`规则最多 ${MAX_RULE} 字，这条写了 ${ruleRaw.length} 字`)
  }
  // 规则正文里带标记会把块切断：replaceRegion 用非贪婪匹配第一个结束标记，
  // 一旦规则自己含 <!-- purge:scoped:end -->，块就提前收尾，后面的规则和正文
  // 全跑到块外，而且重算也清不掉（每次重算都从同一个坏位置切）。
  if (/<!--\s*purge:/.test(ruleRaw)) {
    throw new Error('规则正文里不能出现 <!-- purge: 这样的标记文本')
  }
  const rule = ruleRaw
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
    // 出厂条目也逐条兜：密文被改坏、或者以后加了新校验，不能让一条坏数据
    // 把其余三条也带走
    let entry = null
    try {
      entry = normalizeEntry(raw, nextN, 'pkg')
    } catch (error) {
      warnings.push(`出厂分类无效（${String(error?.message || error).slice(0, 40)}）：${JSON.stringify(raw)?.slice(0, 60)}`)
      continue
    }
    if (!entry) {
      warnings.push(`出厂分类无效：${JSON.stringify(raw)?.slice(0, 80)}`)
      continue
    }
    map.set(entry.id, entry)
    nextN = Math.max(nextN, entry.n + 1)
  }
  for (const raw of readOverlay(home)) {
    // patch:true 的条目只带 id + enabled，是「对出厂项的开关改动」，
    // 规则和别名继续从出厂值取——这样插件更新了出厂 rule，用户这边立刻跟着新。
    if (raw && raw.patch === true) {
      const key = String(raw.id || '').trim().toLowerCase()
      const base = map.get(key)
      if (!base) {
        warnings.push(`覆盖层想改的分类不存在：${key}`)
        continue
      }
      map.set(key, { ...base, enabled: raw.enabled !== false })
      continue
    }
    // 逐条兜住：normalizeEntry 现在会对「规则超长 / 别名过多 / 含标记」抛错，
    // 而这里一条坏数据不能拖垮整个分类层——以前没有这层 try，覆盖层里有一条违规，
    // loadCategories 整体抛、resolveInject 的 catch 吞掉，结果是用户所有分类
    // 连同出厂 4 条一起消失，面板上还看不出任何异常。
    let entry = null
    try {
      entry = normalizeEntry(raw, nextN, 'user')
    } catch (error) {
      warnings.push(`覆盖层分类无效（${String(error?.message || error).slice(0, 40)}）：${JSON.stringify(raw)?.slice(0, 60)}`)
      continue
    }
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
  const block = body ? `${begin}\n${body}\n${end}` : `${begin}\n${end}`
  const hasBegin = text.includes(begin)
  const hasEnd = text.includes(end)
  // 标记不成对时先清掉孤零零的那一个再追加。
  //
  // 为什么要单独处理：正文里只剩 begin（手删了 end、或复制了半截），
  // 第一次组装会在文末补一个新块；从第二次开始，非贪婪匹配会从那个 begin
  // 一路切到新块的 end，把中间所有用户自己写的正文替换掉——实测第二遍就把
  // 用户的段落和尾部全吃了，而且每次组装结果还不一样。
  if (hasBegin !== hasEnd) {
    const lone = hasBegin ? begin : end
    const cleaned = text.split(lone).join('').replace(/\n{3,}/g, '\n\n')
    return { text: `${cleaned.trimEnd()}\n\n${block}` }
  }
  const re = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}`)
  // 用函数做替换值，而不是直接传字符串：字符串里的 $& / $` / $' / $1 会被当成
  // 正则替换序列解释掉，规则正文里写个 shell 示例就能把整篇 26KB 正文写坏。
  // 只返回 text：以前还带一个 hit 字段（re.test），但没有任何调用方读它，
  // 而且它在 replace 之后才算，语义上也有点绕。
  return { text: text.replace(re, () => block) }
}

/**
 * 收掉多余空行。
 *
 * 这里不删空标记对：原来 entry 全关时会把 begin/end 一并抹掉，
 * 抹掉之后 hasMarkers() 为假，再想加分类就只剩「文末追加新块」一条路，
 * 原位置永远不再更新，反复开关会越积越多。留着空标记对无害——
 * 装配时会跳过空块，正文里只是多两行注释。
 */
function collapseEmpty(text) {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

const FALLBACK_HEAD = '═══════════════════════════════════════\nCategory Overlay — 题材分类扩展\n═══════════════════════════════════════'

/**
 * 把分类写进正文。标记存在就整块替换；标记缺失就在文末补一块（带标记，下次可重算）。
 * entries 为空时等于「清空扩展」，正文回到只有 1-25 的状态。
 */
/**
 * 把分类块算进正文。
 * @param {string} text 正文
 * @param {Array} entries 分类条目
 * @param {{enabled?: boolean}} [opts] enabled 显式为 false 时**只删块、不追新块**——
 *   用户关掉分类扩展层后，正文里已经烘焙进去的旧块必须能清干净，否则「关掉」等于没关。
 */
export function applyCategories(text, entries, opts = {}) {
  const src = String(text ?? '')
  if (!src.trim()) return src
  // 传空串给 replaceRegion 就等于把整块删掉，不需要另写一条删除路径
  const off = opts.enabled === false
  const scoped = off ? '' : renderScoped(entries)
  const intent = off ? '' : renderIntent(entries)

  // 先把不成对的孤立标记清掉，再判断。
  //
  // 为什么要先清：正文里只剩 SCOPED_BEGIN（手删了 END、或复制了半截）时，
  // 下面两组判断都是 false，会走「文末追加新块」——孤立的 BEGIN 留在原处。
  // 第二次组装时 BEGIN（旧的）+ END（新块的）凑成一对了，replaceRegion 的非贪婪匹配
  // 就从那个旧 BEGIN 一路切到新块的 END，把中间所有用户自己写的正文整段替换掉。
  // 实测第二遍就把用户段落和尾部全吃了，而且每次结果还不一样。
  const stripLone = (text, begin, end) => {
    const hb = text.includes(begin)
    const he = text.includes(end)
    if (hb === he) return text
    return text.split(hb ? begin : end).join('').replace(/\n{3,}/g, '\n\n').trimEnd()
  }
  const cleaned = stripLone(stripLone(src, SCOPED_BEGIN, SCOPED_END), INTENT_BEGIN, INTENT_END)
  const base = cleaned !== src ? cleaned : src

  const hasScoped = base.includes(SCOPED_BEGIN) && base.includes(SCOPED_END)
  const hasIntent = base.includes(INTENT_BEGIN) && base.includes(INTENT_END)

  if (hasScoped && hasIntent) {
    let out = replaceRegion(base, SCOPED_BEGIN, SCOPED_END, scoped).text
    out = replaceRegion(out, INTENT_BEGIN, INTENT_END, intent).text
    return collapseEmpty(out)
  }

  if (hasScoped || hasIntent) {
    // 只带一对标记：把缺的那半并进已有的块，别让正文出现两处编号。
    const combined = [scoped, intent].filter(Boolean).join('\n\n')
    const out = hasScoped
      ? replaceRegion(base, SCOPED_BEGIN, SCOPED_END, combined).text
      : replaceRegion(base, INTENT_BEGIN, INTENT_END, combined).text
    return collapseEmpty(out)
  }

  if (!scoped && !intent) return base

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
  return collapseEmpty(`${base}\n\n${block}`)
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
  // 出厂项只把「开关」写进覆盖层，不再整条复制。
  //
  // 以前这里 push 的是 { ...hit }——连 rule、labels 一起存。后果是：用户开关过一次之后，
  // 那条分类的规则就被钉在当时的版本上；以后插件更新了出厂 rule，覆盖层按 id 覆盖，
  // 用户的机器上永远是老规则，而且他自己看不见、也不知道要删覆盖层才能恢复。
  //
  // 用户自己加的分类（source==='user'）要整条存，因为出厂值里本来就没有它。
  if (hit.source === 'user') {
    kept.push({ ...hit, enabled: Boolean(enabled), removed: false, source: 'user' })
  } else {
    kept.push({ id: key, enabled: Boolean(enabled), removed: false, patch: true })
  }
  writeOverlay(home, kept)
  return { entry: { ...hit, enabled: Boolean(enabled) }, entries: loadCategories(home).entries }
}
