// 视图与状态数据。面板的 view() 每次渲染都重新读盘，所以「点了按钮 → refresh → 看到新值」
// 不依赖 data 绑定；状态条只有 data 通道，就用 emit 推 { text, tone }。

import { dshHome, injectPath, fileBytes, isFile } from './home.js'
import { rangeTableSummary } from './region-ip.js'
import { readState } from './state.js'
import { DEFAULT_VARIANT, listVariants, resolveInject } from './prompt.js'
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
 * 扫一次要读 87 条 × 若干目标文件，面板每帧都扫会卡，所以缓存；
 * 但缓存只影响「多久刷新一次」，不影响真假——数据始终来自真实读文件。
 */
let patchCache = { at: 0, value: null }

export function patchSnapshot(root) {
  const now = Date.now()
  if (patchCache.value && now - patchCache.at < 30_000) return patchCache.value
  let value
  try {
    const r = root || detectRoot()
    const rows = probe(r)
    value = { ok: true, root: r, rows, tally: tally(rows), total: rows.length, error: '' }
  } catch (error) {
    value = { ok: false, root: '', rows: [], tally: {}, total: 0, error: error?.message || String(error) }
  }
  patchCache = { at: now, value }
  return value
}

/**
 * 预热补丁缓存：在**不影响加载路径**的时机（例如后台定时器）调一次，
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
  patchCache = { at: 0, value: null }
}

/** 一次完整的现场快照（面板、状态条、工具都用它）。 */
// 地区表 / 红队资产 / 目标卡：面板与状态卡都要看，但网段表是 250 KB，
// 所以按 60 s 缓存一次，别每帧都去解析。
let extraCache = { at: 0, home: '', value: null }

function statusExtra(home, options) {
  const now = Date.now()
  if (extraCache.value && extraCache.home === home && now - extraCache.at < 60_000) return extraCache.value
  let ranges = { v4: 0, v6: 0 }
  try {
    const summary = rangeTableSummary()
    ranges = { v4: summary.v4 || 0, v6: summary.v6 || 0 }
  } catch {
    /* 网段表缺失时按 0 显示 */
  }
  let card = ""
  const target = card ? String(card.split("\n")[1] || "").replace(/^只打：/, "") : ""
  const value = { ranges, target, cardBytes: card.length }
  extraCache = { at: now, home, value }
  return value
}

export function snapshot(home = dshHome(), options = {}) {
  const state = readState(home)
  const inject = injectPath(home)
  const resolved = resolveInject(home, { state, maxBytes: options.maxPromptBytes })
  const last = lastAssembly()
  return {
    home,
    enabled: state.enabled !== false,
    variant: state.variant || DEFAULT_VARIANT,
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
    truncated: resolved.truncated === true,
    last,
    extra: statusExtra(home, options),
    // 注意：这里**不**调 patchSnapshot()。
    // patchSnapshot 会跑 probe()（扫 331 个包 + 读 87 条补丁的目标文件），
    // 放进 snapshot() 等于把补丁扫描塞进插件加载和状态条刷新路径，会卡住引擎。
    // 补丁层由 panelView 单独按需取（见那边调用），状态条只用上面的轻量字段。
  }
}

/** 紧凑体积：状态条只有 24 字，10 KB 以下留一位小数，以上取整。 */
function kbShort(bytes) {
  const kb = (Number(bytes) || 0) / 1024
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`
}

/**
 * 补丁摘要：只读 30 秒缓存，**不触发扫盘**。
 * 状态条每 20 秒发一次数据，不能让它每次都去 probe() 87 条补丁的目标文件。
 * 缓存还没热时返回 null，状态条就只报注入层。
 */
export function cachedPatchSummary() {
  const value = patchCache.value
  if (!value || !value.ok) return null
  const t = value.tally || {}
  return {
    applied: t.applied || 0,
    total: value.total || 0,
    pending: (t.hit || 0) + (t.partial || 0),
  }
}

/**
 * 状态条：≤24 字。
 * @param {object} snap 现场快照
 * @param {{applied:number,total:number}|null|string} [patch] 补丁摘要；传字符串时按旧签名当 locale
 * @param {string} [locale]
 */
export function stripData(snap, patch, locale) {
  if (typeof patch === 'string') {
    locale = patch
    patch = null
  }
  const on = snap.enabled
  const head = locale === 'en' ? (on ? 'on' : 'off') : on ? '破甲 开' : '破甲 关'
  let raw = `${head} · ${kbShort(snap.bytes)}`
  if (patch && patch.total) raw += ` · 补 ${patch.applied}/${patch.total}`
  // 状态条硬上限 24 字：clip 会多出一个省略号，所以截 23 再补，确保不超。
  const text = raw.length <= 24 ? raw : raw.slice(0, 23) + '…'
  return { text, tone: on ? 'good' : 'muted', icon: 'wrench' }
}

/** 破甲面板。 */
export function panelView(snap, caps, options = {}) {
  const locale = caps?.locale === 'en' ? 'en' : 'zh'
  const z = (zh, en) => (locale === 'en' ? en : zh)
  const dropped = Array.isArray(snap.last?.dropped) ? snap.last.dropped : []

  const children = [
    {
      type: 'row',
      children: [
        { type: 'metric', label: z('状态', 'State'), value: snap.enabled ? z('开', 'on') : z('关', 'off'), tone: snap.enabled ? 'good' : 'warn' },
        { type: 'metric', label: z('正文', 'Prompt'), value: KB(snap.bytes), caption: `${snap.chars} ${z('字', 'chars')}` },
      ],
    },
    {
      type: 'keyValue',
      items: [
        [z('来源', 'Source'), snap.sourceLabel],
        [z('变体', 'Variant'), snap.variant],
        [z('模型', 'Model'), snap.last?.model || z('未记录', 'n/a')],
        [z('压掉的段', 'Dropped'), dropped.length ? clip(dropped.join(' · '), 60) : z('无', 'none')],
        [z('主文件', 'File'), snap.injectPath],
        [z('地区表', 'Ranges'), `v4 ${snap.extra?.ranges?.v4 ?? 0} / v6 ${snap.extra?.ranges?.v6 ?? 0}`],
      ],
    },
  ]

  if (snap.truncated) {
    children.push({ type: 'callout', tone: 'warn', text: z('正文超过配置上限，已截断注入。', 'Prompt exceeded the configured cap and was truncated.') })
  }

  // ── 补丁层 ────────────────────────────────────────────────────────────
  // 只有面板打开时才扫补丁（probe 要读 331 个包目录 + 87 条目标文件），
  // 30 秒缓存；扫描失败也不能让整个面板挂掉。
  const patch = patchSnapshot(options.aiRoot)
  if (patch && patch.ok) {
    const applied = patch.tally.applied || 0
    const total = patch.total || 0
    const pending = (patch.tally.hit || 0) + (patch.tally.partial || 0)
    children.push({
      type: 'metric',
      label: z('补丁', 'Patches'),
      value: `${applied}/${total}`,
      tone: applied > 0 ? 'good' : 'bad',
      caption: pending ? z(`${pending} 条待应用`, `${pending} pending`) : z('无待应用项', 'none pending'),
    })
    // 按状态分组，各出一张表；单表 50 行上限，超出明示。
    // 顺序按「该不该关注」排：先能打的（hit/partial/drifted），再已生效，最后是本机没有目标的。
    // 七个状态一个都不能漏——漏掉的组会在面板里彻底消失，no_file 这种最该报的反而看不见。
    const order = [
      ['hit', '待应用', 'pending'],
      ['partial', '部分命中', 'partial'],
      ['drifted', '被覆盖', 'drifted'],
      ['miss', '未命中', 'miss'],
      ['applied', '已生效', 'on'],
      ['no_file', '目标文件缺失', 'file missing'],
      ['no_needle', '无目标句', 'no needle'],
      ['no_pkg', '桌面专属', 'desktop-only'],
    ]
    const groups = {}
    for (const r of patch.rows) (groups[r.status] = groups[r.status] || []).push(r)
    for (const [st, zh, en] of order) {
      const list = groups[st] || []
      if (!list.length) continue
      const shown = Math.min(list.length, 50)
      children.push({ type: 'text', text: `— ${z(zh, en)} ${list.length} —`, tone: 'muted' })
      children.push({
        type: 'table',
        columns: [z('ID', 'ID'), z('补丁', 'Patch'), z('状态', 'State')],
        rows: list.slice(0, shown).map((r) => [String(r.id), r.name || '-', r.status]),
      })
      if (list.length > shown) {
        children.push({ type: 'text', text: z(`仅显示前 ${shown} 条，另有 ${list.length - shown} 条`, `showing ${shown} of ${list.length}`), tone: 'muted' })
      }
    }
  } else if (patch && !patch.ok) {
    children.push({
      type: 'callout',
      tone: 'warn',
      text: z(`补丁层读取失败：${clip(patch.error, 80)}`, `Patch read failed: ${clip(patch.error, 80)}`),
    })
  }

  if (snap.byModel && Object.keys(snap.byModel).length > 0) {
    children.push({
      type: 'list',
      items: Object.entries(snap.byModel).map(([model, variant]) => ({ title: model, subtitle: z('按模型指定', 'per model'), trailing: variant, action: { id: 'unmap', args: { model } } })),
    })
  }

  children.push({
    type: 'list',
    // list 上限 50 条：变体再多也只列前 50，多出来的在下面用一行文字说明
    items: snap.variants.length
      ? snap.variants.slice(0, 50).map((variant) => ({ title: variant.name, trailing: KB(variant.bytes), icon: 'document', action: { id: 'use', args: { name: variant.name } } }))
      : [{ title: z('还没有其它变体', 'No variants yet'), subtitle: z('把 .md 放进 dsh-purge/prompts/', 'Put .md files in dsh-purge/prompts/') }],
  })
  if (snap.variants.length > 50) {
    children.push({
      type: 'text',
      text: z(`仅列出前 50 个变体，另有 ${snap.variants.length - 50} 个`, `showing 50 of ${snap.variants.length} variants`),
      tone: 'muted',
    })
  }

  // actions 上限 4 个：注入层两个（开关/重读）+ 补丁层两个（应用/还原）
  children.push({
    type: 'actions',
    items: [
      { label: snap.enabled ? z('关闭注入', 'Injection off') : z('开启注入', 'Injection on'), action: 'toggle', style: 'primary' },
      { label: z('重读正文', 'Reload prompt'), action: 'reload' },
      { label: z('应用补丁', 'Apply patches'), action: 'patchApply' },
      { label: z('还原补丁', 'Revert patches'), action: 'patchRevert' },
    ],
  })

  return { type: 'stack', v: 1, title: z('破甲', 'Purge'), children }
}

/** 提示词面板：看当前真正会注入的正文（截断到 1800 字，全文用「复制」）。 */
export function promptView(snap, caps) {
  const locale = caps?.locale === 'en' ? 'en' : 'zh'
  const z = (zh, en) => (locale === 'en' ? en : zh)
  const preview = clip(snap.text, 1800) || z('（当前没有正文）', '(no prompt)')
  return {
    type: 'stack',
    v: 1,
    title: z('提示词', 'Prompt'),
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: z('字节', 'Bytes'), value: snap.bytes },
          { type: 'metric', label: z('行数', 'Lines'), value: snap.lines },
          { type: 'metric', label: z('变体', 'Variant'), value: snap.variant },
        ],
      },
      { type: 'callout', tone: 'info', text: `${snap.sourceLabel} · ${snap.enabled ? z('正在注入', 'injected') : z('已关闭，不注入', 'off, not injected')}` },
      { type: 'text', text: preview },
      {
        type: 'actions',
        items: [
          { label: z('复制正文', 'Copy'), action: 'copy', style: 'primary' },
          { label: snap.enabled ? z('关闭', 'Turn off') : z('开启', 'Turn on'), action: 'toggle' },
          // seed / revert 从破甲面板挪到这里：破甲面板 4 个位置已被注入层 2 个 + 补丁层 2 个占满，
          // 而这两个动作本来就是针对「正文」的，放在正文面板更贴切，也避免死代码。
          { label: z('落盘默认', 'Seed'), action: 'seed' },
          { label: z('关闭并备份', 'Off + backup'), action: 'revert' },
        ],
      },
    ],
  }
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

/* ───────────────── dsh-go 原生界面：四个面板 + 会话报告 ───────────────── */
// 面板的 view() 每次被请求都重新读现场（snapshot 读盘、patchSnapshot 走 30 秒缓存），
// 所以「点了按钮 → refresh → 看到新值」不依赖 data 通道；只有状态条走 emit。

const localeOf = (caps) => (caps?.locale === 'en' ? 'en' : 'zh')
const zhEn = (locale) => (zh, en) => (locale === 'en' ? en : zh)

/** 补丁分组表：按「该不该动手」排序，每组一张表；单表 ≤50 行，超出明示。 */
function patchTables(patch, z) {
  if (!patch || !patch.ok) {
    return [
      {
        type: 'callout',
        tone: 'warn',
        text: z(`补丁层读取失败：${clip(String(patch?.error || '未扫描'), 80)}`, `Patch read failed: ${clip(String(patch?.error || 'not scanned'), 80)}`),
      },
    ]
  }
  const out = []
  const order = [
    ['hit', '待应用', 'pending'],
    ['partial', '部分命中', 'partial'],
    ['drifted', '被覆盖', 'drifted'],
    ['miss', '未命中', 'miss'],
    ['applied', '已生效', 'on'],
    ['no_file', '目标文件缺失', 'file missing'],
    ['no_needle', '无目标句', 'no needle'],
    ['no_pkg', '桌面专属', 'desktop-only'],
  ]
  const groups = {}
  for (const row of patch.rows || []) (groups[row.status] = groups[row.status] || []).push(row)
  for (const [status, zh, en] of order) {
    const list = groups[status] || []
    if (!list.length) continue
    out.push({ type: 'text', tone: 'muted', text: `— ${z(zh, en)} ${list.length} —` })
    out.push({
      type: 'table',
      columns: [z('ID', 'ID'), z('补丁', 'Patch'), z('状态', 'State')],
      rows: list.slice(0, 50).map((row) => [String(row.id), String(row.name || '-'), status]),
    })
    if (list.length > 50) {
      out.push({ type: 'text', tone: 'muted', text: z(`仅显示前 50 条，另有 ${list.length - 50} 条`, `showing 50 of ${list.length}`) })
    }
  }
  if (out.length === 0) out.push({ type: 'text', tone: 'muted', text: z('没有可显示的补丁条目', 'no patch rows') })
  return out
}

/** 面板一：破甲总览（两层各一半）。 */
export function statusPanelView(snap, patch, caps) {
  const locale = localeOf(caps)
  const z = zhEn(locale)
  const dropped = Array.isArray(snap.last?.dropped) ? snap.last.dropped : []
  const children = [
    {
      type: 'row',
      children: [
        { type: 'metric', label: z('注入', 'Inject'), value: snap.enabled ? z('开', 'on') : z('关', 'off'), tone: snap.enabled ? 'good' : 'warn' },
        { type: 'metric', label: z('正文', 'Prompt'), value: KB(snap.bytes), caption: `${snap.chars} ${z('字', 'chars')}` },
      ],
    },
    {
      type: 'keyValue',
      items: [
        [z('来源', 'Source'), snap.sourceLabel],
        [z('变体', 'Variant'), snap.variant],
        [z('模型', 'Model'), snap.last?.model || z('未记录', 'n/a')],
        [z('压掉的段', 'Dropped'), dropped.length ? clip(dropped.join(' · '), 60) : z('无', 'none')],
        [z('主文件', 'File'), snap.injectPath],
      ],
    },
  ]

  if (snap.truncated) {
    children.push({ type: 'callout', tone: 'warn', text: z('正文超过配置上限，已截断注入。', 'Prompt exceeded the cap and was truncated.') })
  }

  if (patch && patch.ok) {
    const applied = patch.tally?.applied || 0
    const total = patch.total || 0
    const pending = (patch.tally?.hit || 0) + (patch.tally?.partial || 0)
    children.push({
      type: 'metric',
      label: z('补丁', 'Patches'),
      value: `${applied}/${total}`,
      tone: pending ? 'warn' : 'good',
      caption: pending ? z(`${pending} 条待应用`, `${pending} pending`) : z('没有待应用项', 'none pending'),
    })
  } else {
    children.push({ type: 'callout', tone: 'warn', text: z(`补丁层：${clip(String(patch?.error || '未扫描'), 60)}`, `Patches: ${clip(String(patch?.error || 'not scanned'), 60)}`) })
  }

  children.push({
    type: 'actions',
    items: [
      { label: snap.enabled ? z('关闭注入', 'Inject off') : z('开启注入', 'Inject on'), action: 'toggle', style: 'primary' },
      { label: z('看补丁', 'Patches'), action: 'openPatches' },
      { label: z('看正文', 'Prompt'), action: 'openPrompt' },
      { label: z('题材分类', 'Categories'), action: 'openCats' },
    ],
  })

  return { type: 'stack', v: 1, title: z('破甲', 'Purge'), children }
}

/** 面板二：补丁层（87 条分组表 + 应用/还原，两个破坏性动作都要先确认）。 */
export function patchesPanelView(patch, caps) {
  const locale = localeOf(caps)
  const z = zhEn(locale)
  const tally = patch?.tally || {}
  const applied = tally.applied || 0
  const total = patch?.total || 0
  const pending = (tally.hit || 0) + (tally.partial || 0)
  const missing = (tally.no_file || 0) + (tally.no_needle || 0) + (tally.no_pkg || 0)

  const children = [
    {
      type: 'row',
      children: [
        { type: 'metric', label: z('已生效', 'On'), value: `${applied}/${total}`, tone: applied ? 'good' : 'bad' },
        { type: 'metric', label: z('待应用', 'Pending'), value: pending, tone: pending ? 'warn' : 'good' },
        { type: 'metric', label: z('本机无目标', 'No target'), value: missing },
      ],
    },
    { type: 'keyValue', items: [[z('引擎', 'Engine'), String(patch?.root || z('未知', 'unknown'))]] },
    ...patchTables(patch, z),
    { type: 'text', tone: 'muted', text: z('打补丁会先备份目标文件，再改引擎源码；还原用的是最近一次备份。', 'Applying backs up the target files first, then edits engine source. Revert uses the newest backup.') },
    { type: 'confirm', id: 'patchApply', confirmLabel: z('确认打补丁', 'Apply'), cancelLabel: z('取消', 'Cancel') },
    { type: 'confirm', id: 'patchRevert', confirmLabel: z('确认还原', 'Revert'), cancelLabel: z('取消', 'Cancel') },
  ]

  return { type: 'stack', v: 1, title: z('补丁层', 'Patches'), children }
}

/** 面板三：注入正文（真正会被拼进系统提示的那一份，预览截断到 1800 字）。 */
export function promptPanelView(snap, caps) {
  const locale = localeOf(caps)
  const z = zhEn(locale)
  const preview = clip(snap.text, 1800) || z('（当前没有正文）', '(no prompt)')
  return {
    type: 'stack',
    v: 1,
    title: z('注入正文', 'Prompt'),
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: z('字节', 'Bytes'), value: snap.bytes },
          { type: 'metric', label: z('行数', 'Lines'), value: snap.lines },
          { type: 'metric', label: z('变体', 'Variant'), value: snap.variant },
        ],
      },
      {
        type: 'callout',
        tone: snap.enabled ? 'good' : 'muted',
        text: `${snap.sourceLabel} · ${snap.enabled ? z('正在注入', 'injected') : z('已关闭，不注入', 'off')}`,
      },
      { type: 'text', text: preview },
      {
        type: 'actions',
        items: [
          { label: z('复制正文', 'Copy'), action: 'copy', style: 'primary' },
          { label: snap.enabled ? z('关闭', 'Off') : z('开启', 'On'), action: 'toggle' },
          { label: z('落盘默认', 'Seed'), action: 'seed' },
          { label: z('关闭并备份', 'Off + backup'), action: 'revert' },
        ],
      },
    ],
  }
}

/** 面板四：题材分类扩展层（逐条开关 + 写进正文）。 */
export function categoriesPanelView(list, caps) {
  const locale = localeOf(caps)
  const z = zhEn(locale)
  const all = Array.isArray(list?.all) ? list.all : []
  const entries = Array.isArray(list?.entries) ? list.entries : []
  const items = all.slice(0, 50).map((entry) => ({
    title: `${entry.n}. ${entry.id}`,
    subtitle: clip(entry.labels.join('/') + (entry.route ? ` → ${entry.route}` : ''), 60),
    trailing: entry.enabled ? z('开', 'on') : z('关', 'off'),
    icon: 'list',
    tone: entry.enabled ? 'good' : 'muted',
    action: { id: 'catToggle', args: { id: entry.id, enabled: !entry.enabled } },
  }))

  return {
    type: 'stack',
    v: 1,
    title: z('题材分类', 'Categories'),
    children: [
      { type: 'metric', label: z('生效', 'Enabled'), value: `${entries.length}/${all.length}`, tone: entries.length ? 'good' : 'warn' },
      items.length
        ? { type: 'list', items }
        : { type: 'callout', tone: 'warn', text: z('没有读到分类数据（assets/categories.json）', 'no categories loaded') },
      all.length > 50 ? { type: 'text', tone: 'muted', text: z(`仅列出前 50 条，另有 ${all.length - 50} 条`, `showing 50 of ${all.length}`) } : null,
      {
        type: 'actions',
        items: [
          { label: z('写进正文', 'Bake'), action: 'catBake', style: 'primary' },
          { label: z('清空覆盖层', 'Reset'), action: 'catReset' },
        ],
      },
    ].filter(Boolean),
  }
}

/** 会话动作「破甲报告」的正文：一段可粘贴的 markdown，≤8000 字。 */
export function reportText(snap, patch, caps) {
  const locale = localeOf(caps)
  const z = zhEn(locale)
  const lines = [
    `## ${z('破甲报告', 'Purge report')}`,
    '',
    `- ${z('注入', 'Injection')}：${snap.enabled ? z('开', 'on') : z('关', 'off')}`,
    `- ${z('正文', 'Prompt')}：${snap.bytes} B / ${snap.chars} ${z('字', 'chars')} · ${snap.sourceLabel}`,
    `- ${z('变体', 'Variant')}：${snap.variant}${snap.last?.model ? ` · ${snap.last.model}` : ''}`,
    `- ${z('主文件', 'File')}：${snap.injectPath}${snap.injectExists ? '' : z('（缺失）', ' (missing)')}`,
    `- ${z('变体数', 'Variants')}：${snap.variants.length}`,
  ]
  const dropped = snap.last?.dropped || []
  if (dropped.length) lines.push(`- ${z('上次压掉的官方段', 'Dropped sections')}：${dropped.join(', ')}`)
  if (patch && patch.ok) {
    const t = patch.tally || {}
    lines.push('', `### ${z('补丁层', 'Patches')}`, '')
    lines.push(`- ${z('引擎', 'Engine')}：${patch.root || '?'}`)
    lines.push(`- ${z('合计', 'Total')}：${t.applied || 0}/${patch.total} ${z('已生效', 'applied')}`)
    const label = {
      applied: '已生效', partial: '部分命中', hit: '待应用', drifted: '被覆盖',
      miss: '未命中', no_needle: '无目标句', no_file: '文件缺失', no_pkg: '包不存在',
    }
    const parts = Object.keys(label).filter((k) => t[k]).map((k) => `${label[k]} ${t[k]}`)
    if (parts.length) lines.push(`- ${z('分布', 'Tally')}：${parts.join(' · ')}`)
  } else {
    lines.push('', `### ${z('补丁层', 'Patches')}`, '', `- ${z('读不到', 'Unavailable')}：${patch?.error || z('未扫描', 'not scanned')}`)
  }
  return clip(lines.join('\n'), 7900)
}
