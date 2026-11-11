// 视图与状态数据。面板的 view() 每次渲染都重新读盘，所以「点了按钮 → refresh → 看到新值」
// 不依赖 data 绑定；状态条只有 data 通道，就用 emit 推 { text, tone }。

import { dshHome, injectPath, fileBytes, isFile } from './home.js'
import { rangeTableSummary } from './region-ip.js'
import { readState } from './state.js'
import { DEFAULT_VARIANT, listVariants, resolveInject } from './prompt.js'
import { lastAssembly } from './assemble.js'

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
  }
}

/** 状态条：≤24 字。 */
export function stripData(snap, locale) {
  const on = snap.enabled
  const head = locale === 'en' ? (on ? 'on' : 'off') : on ? '破甲 开' : '破甲 关'
  const text = clip(`${head} · ${KB(snap.bytes)}${snap.variant !== DEFAULT_VARIANT ? ` · ${snap.variant}` : ''}`, 24)
  return { text, tone: on ? 'good' : 'muted' }
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

  if (snap.byModel && Object.keys(snap.byModel).length > 0) {
    children.push({
      type: 'list',
      items: Object.entries(snap.byModel).map(([model, variant]) => ({ title: model, subtitle: z('按模型指定', 'per model'), trailing: variant, action: { id: 'unmap', args: { model } } })),
    })
  }

  children.push({
    type: 'list',
    items: snap.variants.length
      ? snap.variants.map((variant) => ({ title: variant.name, trailing: KB(variant.bytes), icon: 'document', action: { id: 'use', args: { name: variant.name } } }))
      : [{ title: z('还没有其它变体', 'No variants yet'), subtitle: z('把 .md 放进 dsh-purge/prompts/', 'Put .md files in dsh-purge/prompts/') }],
  })

  children.push({
    type: 'actions',
    items: [
      { label: snap.enabled ? z('关闭', 'Turn off') : z('开启', 'Turn on'), action: 'toggle', style: 'primary' },
      { label: z('重读', 'Reload'), action: 'reload' },
      { label: z('落盘默认', 'Seed'), action: 'seed' },
      { label: z('回滚', 'Revert'), action: 'revert' },
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
