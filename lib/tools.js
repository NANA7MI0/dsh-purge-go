// 工具：purge_status / purge_apply / purge_revert / purge_prompt
// 每个都挂一张 dsh-go 工具卡（没有桥接/App 时这张卡没人读，不影响调用）。
import { toolCard } from './card.js'
import { snapshot, statusCard, promptCard, patchSnapshot } from './view.js'
import {
  revert,
  seed,
  setPrompt,
  useVariant,
  resetVariant,
  mapModel,
  MAX_PROMPT_CHARS,
  categoryList,
  categoryAdd,
  categoryRemove,
  categoryToggle,
  categoryReset,
  categoryBake,
} from './ops.js'
import { setEnabled } from './state.js'

const text = (body) => [{ type: 'text', text: body }]

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    bytes: { type: 'number' },
    chars: { type: 'number' },
    source: { type: 'string' },
    variant: { type: 'string' },
    model: { type: 'string' },
    variants: { type: 'number' },
    injectPath: { type: 'string' },
    injectExists: { type: 'boolean' },
    dropped: { type: 'array', items: { type: 'string' } },
    home: { type: 'string' },
    patches: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        root: { type: 'string' },
        total: { type: 'number' },
        tally: { type: 'object', additionalProperties: true },
        error: { type: 'string' },
      },
    },
  },
}

const PROMPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    message: { type: 'string' },
    bytes: { type: 'number' },
    chars: { type: 'number' },
    variant: { type: 'string' },
    variants: { type: 'array', items: { type: 'string' } },
    preview: { type: 'string' },
    maxChars: { type: 'number' },
  },
}

const CATEGORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    count: { type: 'number' },
    entries: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
  },
}

const APPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    enabled: { type: 'boolean' },
    written: { type: 'boolean' },
    bytes: { type: 'number' },
    message: { type: 'string' },
  },
}

/** 补丁层快照：87 条按状态分布。只在被调用时扫盘，带 30 秒缓存。 */
function patchInfo() {
  const p = patchSnapshot()
  return {
    ok: Boolean(p.ok),
    root: String(p.root || ''),
    total: Number(p.total) || 0,
    tally: p.tally || {},
    error: String(p.error || ''),
  }
}

function statusText(snap) {
  const lines = [
    '【注入层】',
    `  开关：${snap.enabled ? '开' : '关'}`,
    `  正文：${snap.bytes} 字节 / ${snap.chars} 字 · 来源 ${snap.sourceLabel}`,
    `  变体：${snap.variant}${snap.last?.model ? ` · 模型 ${snap.last.model}` : ''}`,
    `  主文件：${snap.injectPath}${snap.injectExists ? '' : '（缺失，将用包内默认正文）'}`,
    `  其它变体：${snap.variants.length ? snap.variants.map((v) => v.name).join(', ') : '无'}`,
  ]
  const byModel = Object.entries(snap.byModel || {})
  if (byModel.length) lines.push(`  按模型指定：${byModel.map(([m, v]) => `${m}→${v}`).join(', ')}`)
  const dropped = snap.last?.dropped || []
  if (dropped.length) lines.push(`  上次组装压掉的官方段：${dropped.join(', ')}`)
  if (snap.truncated) lines.push('  注意：正文超过配置上限，已截断。')

  lines.push('')
  const p = snap.patches || {}
  lines.push('【补丁层】')
  if (p.ok) {
    const t = p.tally || {}
    const order = ['applied', 'partial', 'hit', 'drifted', 'miss', 'no_needle', 'no_file', 'no_pkg']
    const label = {
      applied: '已生效', partial: '部分命中', hit: '待应用', drifted: '被覆盖',
      miss: '未命中', no_needle: '无目标句', no_file: '文件缺失', no_pkg: '包不存在',
    }
    lines.push(`  引擎：${p.root || '未知'}`)
    lines.push(`  合计：${t.applied || 0}/${p.total} 已生效`)
    const parts = order.filter((k) => t[k]).map((k) => `${label[k]} ${t[k]}`)
    if (parts.length) lines.push(`  分布：${parts.join(' · ')}`)
  } else {
    lines.push(`  读不到：${p.error || '未扫描'}`)
  }
  return lines.join('\n')
}

/**
 * @param {any} ctx 已经 inject(['tools']) 的 ctx
 * @param {{ home: string, config: any, warn: (message: string) => void }} deps
 */
export function registerTools(ctx, deps) {
  const tools = ctx.tools
  if (!tools || typeof tools.register !== 'function') return 0
  const { home, config, warn } = deps
  const snap = () => snapshot(home, config)
  let count = 0

  const register = (definition) => {
    try {
      tools.register(definition)
      count += 1
    } catch (error) {
      // 同名工具（同机装了桌面版 dsh-purge）只警告，不拖垮整插件加载
      warn(`工具 ${definition.name} 注册失败：${error?.message || error}`)
    }
  }

  register({
    name: 'purge_status',
    description: '查看破甲两层状态。注入层：开关、正文来源与体积、变体、按模型指定、上次组装压掉哪些官方段。补丁层：引擎路径、87 条补丁的生效数与状态分布（已生效/部分命中/待应用/未命中/无目标句/文件缺失/包不存在）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => text(statusText({ ...snapshot(home, config), patches: value?.patches })),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute() {
      const current = snap()
      return {
        enabled: current.enabled,
        bytes: current.bytes,
        chars: current.chars,
        source: current.sourceLabel,
        variant: current.variant,
        model: current.last?.model || '',
        variants: current.variants.length,
        injectPath: current.injectPath,
        injectExists: current.injectExists,
        dropped: current.last?.dropped || [],
        home: current.home,
        patches: patchInfo(),
      }
    },
  })

  register({
    name: 'purge_apply',
    description: '开启破甲（提示词注入）并确保 $DSH_HOME/prompt-inject.md 有正文（缺失时落盘包内默认正文；force=true 覆盖重写）。**不涉及补丁层**——要打补丁请在仓库目录跑 `node patches/purge-patch.mjs apply`，或点输入框上方的胶囊看补丁状态。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { force: { type: 'boolean', description: '覆盖已有的 prompt-inject.md' } },
    },
    output: {
      schema: APPLY_SCHEMA,
      render: (_args, value) => text(value.message),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute(args) {
      const seeded = seed(home, { force: args?.force === true })
      setEnabled(home, true)
      const current = snap()
      return {
        ok: true,
        enabled: true,
        written: seeded.written,
        bytes: current.bytes,
        message: `破甲已开启。${seeded.written ? '已写入默认正文' : '沿用现有正文'}：${current.bytes} 字节。`,
      }
    },
  })

  register({
    name: 'purge_revert',
    description: '关闭破甲（提示词注入），并把当前 $DSH_HOME/prompt-inject.md 备份到 dsh-purge/backups/（正文本身保留）。**不涉及补丁层**——要还原补丁请在仓库目录跑 `node patches/purge-patch.mjs restore`。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: APPLY_SCHEMA,
      render: (_args, value) => text(value.message),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute() {
      const result = revert(home)
      return {
        ok: true,
        enabled: false,
        written: false,
        bytes: snapshot(home, config).bytes,
        message: result.backup ? `破甲已关闭，正文已备份到 ${result.backup}。` : '破甲已关闭（当前没有正文可备份）。',
      }
    },
  })

  register({
    name: 'purge_prompt',
    description: `读取/写入注入正文与变体。action：show（看正文与来源）、set（写 prompt-inject.md，≤${MAX_PROMPT_CHARS} 字）、reset（重写包内默认正文）、use（切换变体）、default（回默认变体）、map（按模型指定变体）。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['show', 'set', 'reset', 'use', 'default', 'map'] },
        text: { type: 'string', description: 'action=set 时的正文' },
        name: { type: 'string', description: '变体名（不带 .md）；action=map 时为空表示取消该模型的指定' },
        model: { type: 'string', description: 'action=map 时的模型名' },
      },
      required: ['action'],
    },
    output: {
      schema: PROMPT_SCHEMA,
      render: (_args, value) => text(value.preview ? `${value.message}\n\n${value.preview}` : value.message),
      presentationMeta: toolCard(() => promptCard(snap()), { onError: warn }),
    },
    async execute(args) {
      const action = String(args?.action || 'show')
      const current = () => snap()
      if (action === 'set') {
        const written = setPrompt(home, args?.text)
        const now = current()
        return { ok: true, action, message: `已写入正文：${written.bytes} 字节 → ${written.path}`, bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'reset') {
        seed(home, { force: true })
        const now = current()
        return { ok: true, action, message: `已重写包内默认正文：${now.bytes} 字节`, bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'use') {
        const used = useVariant(home, args?.name)
        const now = current()
        return { ok: true, action, message: `已切到变体 ${used.variant}（${now.bytes} 字节）`, bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'default') {
        resetVariant(home)
        const now = current()
        return { ok: true, action, message: '已回到默认变体', bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'map') {
        const mapped = mapModel(home, args?.model, args?.name)
        const now = current()
        return {
          ok: true,
          action,
          message: mapped.variant ? `已把模型 ${mapped.model} 指定到变体 ${mapped.variant}` : `已取消模型 ${mapped.model} 的指定`,
          bytes: now.bytes,
          chars: now.chars,
          variant: now.variant,
          variants: now.variants.map((v) => v.name),
          preview: '',
          maxChars: MAX_PROMPT_CHARS,
        }
      }
      const now = current()
      return {
        ok: true,
        action: 'show',
        message: `破甲${now.enabled ? '开' : '关'} · ${now.bytes} 字节 / ${now.chars} 字 · 来源 ${now.sourceLabel} · 变体 ${now.variant}`,
        bytes: now.bytes,
        chars: now.chars,
        variant: now.variant,
        variants: now.variants.map((v) => v.name),
        preview: now.text.slice(0, 1200),
        maxChars: MAX_PROMPT_CHARS,
      }
    },
  })

  register({
    name: 'purge_category',
    description:
      '题材分类扩展层（Scoped Rules 26+ 与意图映射扩展行）。action：list（全部条目与生效状态）、add（加一条，需 id/别名/规则正文）、rm（删一条）、on/off（单条开关）、reset（清空覆盖层回出厂）、bake（把当前分类写进 prompt-inject.md）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'rm', 'on', 'off', 'reset', 'bake'] },
        id: { type: 'string', description: '分类 id（小写字母/数字/-/_）' },
        labels: { type: 'string', description: 'action=add 时的别名，逗号分隔，例如「未成年,幼,萝莉」' },
        rule: { type: 'string', description: 'action=add 时的规则正文（写进 Scoped Rules）' },
        route: { type: 'string', description: 'action=add 时的意图映射目标，例如「adult (Scoped Rule 9)」' },
      },
      required: ['action'],
    },
    output: {
      schema: CATEGORY_SCHEMA,
      render: (_args, value) => text(value.message),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute(args) {
      const action = String(args?.action || 'list')
      const brief = (entries) =>
        entries.map((entry) => `${entry.n}. ${entry.id} · ${entry.labels.join('/')}${entry.route ? ` → ${entry.route}` : ''}`).join('\n')
      if (action === 'add') {
        const added = categoryAdd(home, {
          id: args?.id,
          labels: args?.labels,
          rule: args?.rule,
          route: args?.route,
        })
        return {
          ok: true,
          action,
          count: added.entries.length,
          entries: added.entries.map((entry) => entry.id),
          message: `已加分类 ${added.entry.n}. ${added.entry.id}（${added.entry.labels.join('/')}）。\n当前 ${added.entries.length} 条生效：\n${brief(added.entries)}`,
        }
      }
      if (action === 'rm') {
        const removed = categoryRemove(home, args?.id)
        return {
          ok: true,
          action,
          count: removed.entries.length,
          entries: removed.entries.map((entry) => entry.id),
          message: removed.removed ? `已删分类 ${args?.id}，剩 ${removed.entries.length} 条生效。` : `没有这个分类：${args?.id}`,
        }
      }
      if (action === 'on' || action === 'off') {
        const toggled = categoryToggle(home, args?.id, action === 'on')
        return {
          ok: true,
          action,
          count: toggled.entries.length,
          entries: toggled.entries.map((entry) => entry.id),
          message: `分类 ${args?.id} 已${action === 'on' ? '开' : '关'}。\n当前 ${toggled.entries.length} 条生效：\n${brief(toggled.entries)}`,
        }
      }
      if (action === 'reset') {
        const list = categoryReset(home)
        return { ok: true, action, count: list.entries.length, entries: list.entries.map((entry) => entry.id), message: `覆盖层已清空，回到出厂分类（${list.entries.length} 条）。` }
      }
      if (action === 'bake') {
        const baked = categoryBake(home)
        return { ok: true, action, count: baked.categories, entries: [], message: `已把 ${baked.categories} 条分类写进正文：${baked.bytes} 字节 → ${baked.path}` }
      }
      const list = categoryList(home)
      return {
        ok: true,
        action: 'list',
        count: list.entries.length,
        entries: list.all.map((entry) => entry.id),
        message: `题材分类 ${list.entries.length}/${list.all.length} 生效：\n${list.all
          .map((entry) => `${entry.enabled ? '·' : 'x'} ${entry.n}. ${entry.id} · ${entry.labels.join('/')}${entry.route ? ` → ${entry.route}` : ''}`)
          .join('\n')}`,
      }
    },
  })

  return count
}
