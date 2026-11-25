// 视图与状态数据。面板的 view() 每次渲染都重新读盘，所以「点了按钮 → refresh → 看到新值」
// 不依赖 data 绑定；状态条只有 data 通道，就用 emit 推 { text, tone }。

import { dshHome, injectPath, fileBytes, isFile } from './home.js'

import { readState } from './state.js'
import { DEFAULT_VARIANT, listVariants, resolveInject } from './prompt.js'
import { loadCategories } from './categories.js'
import { lastAssembly } from './assemble.js'
import { probe, tally, detectRoot } from '../patches/lib/core.mjs'

const KB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)

const SOURCE_LABEL = {
  'prompt-inject.md': 'prompt-inject.md',
  builtin: '包内默认正文',
  variant: '变体',
  'variant:model': '变体（按模型）',
  off: '已关闭',
  empty: '空',
}

/**
 * 补丁层现场：走 patches/core 的 probe() 实时扫盘，30 秒缓存。
 * 扫一次要读 86 条 × 若干目标文件，面板每帧都扫会卡，所以缓存；
 * 但缓存只影响「多久刷新一次」，不影响真假——数据始终来自真实读文件。
 */
// 缓存必须按 root 分开存：面板传 config.aiRoot、tools 不传（走 detectRoot），
// 共用一个槽的话，30 秒窗口内两边会互相读到对方的结果，切换引擎路径后也会显示旧数据。
const patchCache = new Map()

export function patchSnapshot(root) {
  const key = root || '(default)'
  const hit = patchCache.get(key)
  const now = Date.now()
  if (hit?.value && now - hit.at < 30_000) return hit.value
  let value
  try {
    const r = root || detectRoot()
    const rows = probe(r)
    value = { ok: true, root: r, rows, tally: tally(rows), total: rows.length, error: '' }
  } catch (error) {
    value = { ok: false, root: '', rows: [], tally: {}, total: 0, error: error?.message || String(error) }
    // 失败不缓存：一次瞬时读盘失败（App 更新窗口期）不该让面板和工具连着 30 秒都报错
    patchCache.set(key, { at: 0, value: null })
    return value
  }
  patchCache.set(key, { at: now, value })
  return value
}

/**
 * 预热补丁缓存：在不影响加载路径的时机（例如后台定时器）调一次，
 * 让之后打开面板时直接命中缓存，避免第一次打开卡一下。
 */
export function warmPatchCache(root) {
  try {
    patchSnapshot(root)
    return true
  } catch {
    return false
  }
}

/** 让下一次 patchSnapshot 重新扫盘（应用/还原之后调）。 */
export function invalidatePatches() {
  patchCache.clear()
}

/** 一次完整的现场快照（面板、状态条、工具都用它）。 */
export function snapshot(home = dshHome(), options = {}) {
  const state = readState(home)
  const inject = injectPath(home)
  // categories 必须透传：注入路径（assemble.js、index.js）都传了它，
  // 只有这里没传，于是关掉分类扩展层之后，面板按「含分类」的字节数显示，
  // 与实际注入的正文对不上——用户按面板判断「正文多大」必然错。
  const resolved = resolveInject(home, {
    state,
    // model 也要传：不传的话「按模型指定」在面板上永远看不出效果，
    // 而实际注入是按模型走了的——两个数会对不上。
    model: options.model,
    maxBytes: options.maxPromptBytes,
    categories: options.categories,
  })
  const last = lastAssembly()
  return {
    home,
    enabled: state.enabled !== false,
    // 用「实际命中」的那个，不用 state 里记的：
    // 变体文件被删掉之后 state 还留着旧名，面板和状态条会一直显示一个根本没用上的变体，
    // 而实际注入的是 prompt-inject.md——用户看到的和实际发生的不一致。
    variant: resolved.variant || state.variant || DEFAULT_VARIANT,
    // 只有「全局变体文件被删了、实际回落到正文」才算 stale。
    // 被 byModel 覆盖不算：那不是失效，是「这个模型另有一条指定」，属正常状态。
    // 以前这里不区分，全局设了 x、又给某模型指定 m 之后，面板会提示「x 已失效」，
    // 而实际只是被模型级配置盖住了。
    variantStale: resolved.source !== 'variant:model'
      && (state.variant || DEFAULT_VARIANT) !== DEFAULT_VARIANT
      && resolved.variant !== (state.variant || DEFAULT_VARIANT),
    variantRecorded: state.variant || DEFAULT_VARIANT,
    variantFromModel: resolved.source === 'variant:model',
    byModel: state.byModel || {},
    variants: listVariants(home),
    injectPath: inject,
    injectExists: isFile(inject),
    injectBytes: fileBytes(inject),
    text: resolved.text,
    bytes: resolved.bytes,
    chars: resolved.text.length,
    lines: resolved.text ? resolved.text.split('\n').length : 0,
    source: resolved.source,
    sourceLabel: SOURCE_LABEL[resolved.source] || resolved.source,
    // 分类层条数：密文缺失/解不开时这里会掉到 0，面板据此报异常。
    // 以前这个数只活在 resolveInject 的返回值里，没有任何界面读它，
    // 于是「出厂 4 条分类整层消失、正文静默缩水 1788 字节」是彻底看不见的。
    categories: Number(resolved.categories) || 0,
    // 分类读失败/被跳过时的说明（loadCategories 的 warnings）
    categoryWarnings: (() => {
      try { return loadCategories(home).warnings || [] } catch { return [] }
    })(),
    truncated: resolved.truncated === true,
    last,
    // 注意：这里不调 patchSnapshot()。
    // patchSnapshot 会跑 probe()（扫整个引擎包目录 + 读补丁表的目标文件），
    // 放进 snapshot() 等于把补丁扫描塞进插件加载和状态条刷新路径，会卡住引擎。
    // 补丁层由 patchSnapshot() 单独按需取，状态条只用上面的轻量字段。
  }
}

/** 状态条：≤24 字。 */
export function stripData(snap, locale) {
  const on = snap.enabled
  const head = locale === 'en' ? (on ? 'on' : 'off') : on ? '破甲 开' : '破甲 关'
  // 状态条硬上限 24 字：clip 会多出一个省略号，所以截 23 再补，确保不超。
  const raw = `${head} · ${KB(snap.bytes)}${snap.variant !== DEFAULT_VARIANT ? ` · ${snap.variant}` : ''}`
  const text = raw.length <= 24 ? raw : raw.slice(0, 23) + '…'
  return { text, tone: on ? 'good' : 'muted' }
}

/** 工具卡（只读、≤8 KiB、只能用最稳的几个组件）。 */
export function statusCard(snap, locale) {
  const z = (zh, en) => (locale === 'en' ? en : zh)
  return {
    type: 'stack',
    v: 1,
    title: z('破甲状态', 'Purge status'),
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: z('状态', 'State'), value: snap.enabled ? z('开', 'on') : z('关', 'off'), tone: snap.enabled ? 'good' : 'warn' },
          { type: 'metric', label: z('正文', 'Prompt'), value: KB(snap.bytes) },
        ],
      },
      { type: 'callout', tone: snap.enabled ? 'good' : 'warn', text: `${snap.sourceLabel}${snap.variant !== DEFAULT_VARIANT ? ` · ${snap.variant}` : ''}` },
      {
        type: 'compare',
        items: [
          { title: z('当前', 'Now'), rows: [[z('模型', 'Model'), snap.last?.model || '—'], [z('压掉的段', 'Dropped'), String((snap.last?.dropped || []).length)]] },
          { title: z('文件', 'File'), rows: [[z('主文件', 'Main'), snap.injectExists ? KB(snap.injectBytes) : z('缺失', 'missing')], [z('变体数', 'Variants'), String(snap.variants.length)]] },
        ],
      },
    ],
  }
}

export function promptCard(snap, locale) {
  const z = (zh, en) => (locale === 'en' ? en : zh)
  return {
    type: 'stack',
    v: 1,
    title: z('提示词', 'Prompt'),
    children: [
      { type: 'metric', label: z('字节', 'Bytes'), value: snap.bytes, caption: `${snap.chars} ${z('字', 'chars')}` },
      { type: 'callout', tone: snap.enabled ? 'good' : 'muted', text: `${snap.sourceLabel} · ${snap.variant}` },
      { type: 'text', text: clip(snap.text, 500) || z('（空）', '(empty)') },
    ],
  }
}
