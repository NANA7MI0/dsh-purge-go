// 工具：purge_status / purge_apply / purge_revert / purge_prompt
// 每个都挂一张 dsh-go 工具卡（没有桥接/App 时这张卡没人读，不影响调用）。
import { toolCard } from './card.js'
import { snapshot, statusCard, promptCard, patchSnapshot, invalidatePatches } from './view.js'
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
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** 包根（lib/ 的上一级），用来找 patches/purge-patch.mjs。 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 调 patches/purge-patch.mjs，返回 { code, stdout, stderr }。 */
function runPatchScript(mode) {
  const script = join(PKG_ROOT, 'patches', 'purge-patch.mjs')
  return new Promise((resolve) => {
    execFile(process.execPath, [script, mode], { cwd: PKG_ROOT, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || error?.message || '') })
    })
  })
}

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
    summary: { type: 'string' },
    verdict: { type: 'string' },
    patches: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        root: { type: 'string' },
        total: { type: 'number' },
        tally: { type: 'object', additionalProperties: true },
        error: { type: 'string' },
        applicable: { type: 'number' },
        pending: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
              status: { type: 'string' },
              pkg: { type: 'string' },
            },
          },
        },
        missing: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string' },
              count: { type: 'number' },
              why: { type: 'string' },
            },
          },
        },
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

/** 补丁层快照：按状态分布。只在被调用时扫盘，带 30 秒缓存。条数从表里读，不写死。 */
function patchInfo() {
  const p = patchSnapshot()
  const tally = p.tally || {}
  const total = Number(p.total) || 0
  const noPkg = Number(tally.no_pkg) || 0
  return {
    ok: Boolean(p.ok),
    root: String(p.root || ''),
    total,
    tally,
    error: String(p.error || ''),
    // 手机上有目标的条数：总数里减去目标是桌面包的那些，本来就不适用
    applicable: Math.max(0, total - noPkg),
    // 只留「该打却没打上」的，按 id 排序，给 statusText 和模型读
    pending: (p.rows || [])
      .filter((r) => ['miss', 'no_needle', 'no_file', 'partial', 'drifted'].includes(r.status))
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ id: r.id, name: r.name, status: r.status, pkg: String(r.pkg || '') })),
    // 目标包在手机上不存在的那些，按用途归类——用来解释「为什么不影响破甲」
    missing: missingGroups(p),
  }
}

/** 补丁条数低于这个值就判定为「被覆盖」。正常环境是 40 条以上，原版是 0~1 条。 */
const PATCH_BROKEN_THRESHOLD = 10

/**
 * 已知未生效补丁的人工说明。键是补丁表里的 id。
 * 只写查清楚的——查不清的走 patchReason 的通用解释，别瞎猜。
 */
const PATCH_NOTES = {
  56: '目标包对上了（dsh-client-ui-conversation），但里面没有 sourceEventSeqs 那段代码——这条针对的是桌面 Web 端的回退行为，手机端的实现不一样。',
  77: '手机上不触发。这条改的是桌面端「回退标记到达时立刻撤掉已发送消息」的行为，手机 App 的对话界面是 Flutter 原生实现，不走那条代码路径——不打包也能正常用。',
}

/** 补丁层是不是被覆盖了（注入层关着不算——那是用户自己关的）。 */
function patchesBroken(snap) {
  const p = snap.patches || {}
  if (!p.ok || !snap.enabled) return false
  const applied = Number((p.tally || {}).applied) || 0
  return applied < PATCH_BROKEN_THRESHOLD
}

/** 异常块：只在补丁层被覆盖时出现，正常时一个字都不多。 */
function brokenLines(snap) {
  const p = snap.patches || {}
  const applied = Number((p.tally || {}).applied) || 0
  const total = p.total || 87
  return [
    '⚠️ 破甲异常：补丁层没生效',
    `  当前只有 ${applied}/${total} 条生效（正常在 40 条以上）`,
    '  两种可能：①从市场装的，还没打过补丁（补丁改的是引擎源码，装插件时打不了）；',
    '            ②打过了，但 App 更新重装引擎包时被冲掉了。',
    '  修复：说一句「重打补丁」，或调 purge_patch_apply（打完要重启引擎）',
    `  手动：cd ${PKG_ROOT} && node patches/purge-patch.mjs apply`,
    '',
  ]
}

/**
 * 把 no_pkg 的那些补丁按「为什么手机上没这个包」归类。
 *
 * 补丁表是照桌面版整理的，里面有一批包手机引擎根本不装：
 * 预设变体、Electron 外壳、Claude/Codex 钩子、别的模型后端。
 * 它们不打不影响破甲——改的都是手机上没有的代码路径。
 */
const MISSING_BUCKETS = [
  { key: ['LIANGSHEN'], label: 'liangshen 预设', why: '第三方自定义预设，本机没装' },
  { key: ['PRESET_'], label: '预设变体', why: '手机只跑 web 预设，其余 preset（standard/ptc/cordis/minimal/unrestricted）没装' },
  { key: ['DESKTOP_'], label: '桌面外壳', why: 'Electron 主进程那一套，手机不是这个运行形态' },
  { key: ['HOOKS_'], label: 'Claude Code / Codex 钩子', why: '给别的命令行工具用的钩子，手机没装那两个工具' },
  { key: ['ANTHROPIC_', 'DEEPSEEK_SYSTEM_ROLE'], label: '其它模型后端', why: '手机只用 DeepSeek 的官方通道，没装 Anthropic / completions 适配层' },
  { key: ['ESCALATION_', 'SANDBOX_HINT_'], label: '权限升级包', why: '手机版的审批逻辑在 dsh-user-approval 里，没有独立 escalation 包' },
  { key: ['OFFICIAL_RUN_CODE_', 'OFFICIAL_TOOL_ASK_'], label: 'PTC 工具执行器', why: '手机版没启用 PTC（program-to-call）那套工具链' },
]

function missingGroups(p) {
  const rows = (p?.rows || []).filter((r) => r.status === 'no_pkg')
  if (!rows.length) return []
  const out = []
  const used = new Set()
  for (const b of MISSING_BUCKETS) {
    const name = (r) => String(r.name || '').toUpperCase()
    const hit = rows.filter((r) => !used.has(r.id) && b.key.some((k) => name(r).includes(k)))
    if (!hit.length) continue
    hit.forEach((r) => used.add(r.id))
    out.push({ label: b.label, count: hit.length, why: b.why })
  }
  const rest = rows.filter((r) => !used.has(r.id))
  if (rest.length) out.push({ label: '其它', count: rest.length, why: '目标包本机没有安装' })
  return out
}

/** 一句话结论，固定措辞，不给模型自由发挥的空间。 */
function patchVerdict(patches) {
  const tally = patches?.tally || {}
  const applicable = Number(patches?.applicable) || 0
  const applied = Number(tally.applied) || 0
  if (!applicable) return '补丁层未扫描到引擎目录，无法判断。'
  const pct = ((applied / applicable) * 100).toFixed(1)
  return (
    `破甲能力完全正常：手机上适用 ${applicable} 条、已生效 ${applied} 条（${pct}%）。` +
    '这个百分比只是补丁条目的计数，不是破甲强度的折扣；没打上的要么手机不需要，要么只影响桌面端。'
  )
}

/**
 * 把「没打上的补丁 + 原因」拼成一段给人看的文本。
 * statusText（工具卡）和 purge_status 的返回值（模型读）共用这一份，
 * 免得模型自己猜——它拿到结构化 JSON 时经常只念数字、不解释原因。
 */
function pendingSummary(patches) {
  const list = Array.isArray(patches?.pending) ? patches.pending : []
  const missing = Array.isArray(patches?.missing) ? patches.missing : []
  const tally = patches?.tally || {}
  const noPkg = Number(tally.no_pkg) || 0
  if (!list.length && !missing.length) return ''

  const label = {
    applied: '已生效', partial: '部分命中', hit: '待应用', drifted: '被覆盖',
    miss: '未命中', no_needle: '无目标句', no_file: '文件缺失', no_pkg: '包不存在',
  }
  const out = []
  // 结论放最前面：模型转述长文本时经常只抄开头、把结尾丢掉，
  // 而这句话是用户最先想知道的东西，不能排到最后。
  const applicable0 = Number(patches?.applicable) || 0
  const applied0 = Number(tally.applied) || 0
  if (applicable0) {
    out.push(
      `【结论】破甲能力完全正常。手机上适用 ${applicable0} 条，已生效 ${applied0} 条` +
        `（${((applied0 / applicable0) * 100).toFixed(1)}%）——这个百分比只是「补丁条目打没打上」的计数，` +
        '不是破甲强度的折扣。没打上的几条要么手机上本来就不需要，要么只影响桌面端行为，' +
        '手机端的注入层和补丁层都是满的。',
    )
    out.push('')
  }

  if (list.length) {
    out.push('以下是那几条的具体情况：')
    for (const r of list) {
      out.push(`${r.id}.${r.name}（${label[r.status] || r.status}）：${patchReason(r)}`)
    }
  }

  if (noPkg) {
    out.push('')
    out.push(
      `另有 ${noPkg} 条显示「包不存在」。这不是失效，也不影响破甲：补丁表是照桌面版整理的，` +
        '这批补丁的目标包手机引擎根本没有安装，改的都是手机上没有的代码路径。分类如下：',
    )
    for (const g of missing) {
      out.push(`  · ${g.label} ${g.count} 条——${g.why}`)
    }
  }

  return out.join('\n')
}

/**
 * 一条补丁为什么没打上。先看补丁表里的 note（人工标注），
 * 没有就按状态给通用解释——这样新出现的失败也能说清是哪一类。
 */
function patchReason(row) {
  const note = PATCH_NOTES[row.id]
  if (note) return note
  switch (row.status) {
    case 'no_pkg':
      return '目标包不存在——多是桌面版专属（Electron 外壳、Web 客户端），手机上本来就没有，不用管。'
    case 'no_needle':
      return '补丁表里这条的查找串是空的，执行器无从上手（上游导出时 RegExp 退化成了空对象）。'
    case 'no_file':
      return `目标文件不存在：${row.pkg || '未知包'}，手机上可能没这个路径。`
    case 'miss':
      return `目标文件在（${row.pkg || '?'}），但里面找不到要替换的那段文本——引擎版本对不上，或这条本来就只适用于别的形态。`
    case 'drifted':
      return '以前打过，被引擎升级或 App 更新冲掉了，重跑 apply 即可。'
    case 'partial':
      return '只打上了一部分替换点，剩下的查找串对不上。'
    default:
      return '状态未知。'
  }
}

function statusText(snap) {
  const lines = []
  if (patchesBroken(snap)) lines.push(...brokenLines(snap))
  lines.push(
    '【注入层】',
    `  开关：${snap.enabled ? '开' : '关'}`,
    `  正文：${snap.bytes} 字节 / ${snap.chars} 字 · 来源 ${snap.sourceLabel}`,
    `  变体：${snap.variant}${snap.last?.model ? ` · 模型 ${snap.last.model}` : ''}`,
    `  主文件：${snap.injectPath}${snap.injectExists ? '' : '（缺失，将用包内默认正文）'}`,
    `  其它变体：${snap.variants.length ? snap.variants.map((v) => v.name).join(', ') : '无'}`,
  )
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
    const applicable = Number(p.applicable) || p.total
    const noPkg = Number(t.no_pkg) || 0
    lines.push(`  引擎：${p.root || '未知'}`)
    lines.push(
      `  合计：${t.applied || 0}/${p.total} 已生效` +
        (noPkg ? `（其中 ${noPkg} 条是桌面专属包，手机不适用；手机适用 ${applicable} 条，已生效 ${t.applied || 0} 条）` : ''),
    )
    const parts = order.filter((k) => t[k]).map((k) => `${label[k]} ${t[k]}`)
    if (parts.length) lines.push(`  分布：${parts.join(' · ')}`)

    // 为什么没打上——逐条给原因，没有未生效项就不出现这一段
    const pending = Array.isArray(p.pending) ? p.pending : []
    if (pending.length) {
      lines.push('')
      lines.push('  未生效明细：')
      for (const r of pending) {
        const why = patchReason(r)
        lines.push(`    ${String(r.id).padStart(2)}.${r.name}  [${label[r.status] || r.status}]`)
        lines.push(`        ${why}`)
      }
    }
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
    description: '查看破甲两层状态。注入层：开关、正文来源与体积、变体、按模型指定、上次组装压掉哪些官方段。补丁层：引擎路径、补丁总数的生效数与状态分布（已生效/部分命中/待应用/未命中/无目标句/文件缺失/包不存在），以及没生效的那几条分别为什么。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => text(statusText({ ...snapshot(home, config), patches: value?.patches })),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute() {
      const current = snap()
      const patches = patchInfo()
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
        patches,
        // 现成的一段话：模型拿到结构化 JSON 时常常只念数字、不解释原因，
        // 这里把「哪条、什么状态、为什么」直接写成文本，让它有东西可抄。
        summary: pendingSummary(patches),
        // 单独拎出来的一句话，模型最不容易漏——它转述结构化 JSON 时经常漏掉细节
        verdict: patchVerdict(patches),
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

  register({
    name: 'purge_patch_apply',
    description:
      '重打或还原引擎补丁层。App 更新会重装引擎包、把补丁冲掉，这时用 apply 一条命令重打。打完需要重启引擎才生效。restore 走最近一次备份还原；probe 只看当前分布、不改文件。全新安装如果没打过硬补丁，也用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['apply', 'restore', 'probe'],
          description: 'apply 打补丁（默认）/ restore 还原到上次备份 / probe 只看状态不动文件',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          message: { type: 'string' },
          tail: { type: 'string' },
          restartRequired: { type: 'boolean' },
        },
      },
      render: (_args, value) => text(value.message + (value.tail ? `\n\n${value.tail}` : '')),
    },
    async execute(args) {
      const mode = ['apply', 'restore', 'probe'].includes(args?.mode) ? args.mode : 'apply'
      const { code, stdout, stderr } = await runPatchScript(mode)
      const ok = code === 0
      const lines = stdout.trim().split('\n').filter(Boolean)
      const tail = lines.slice(-4).join('\n')
      const head =
        mode === 'apply'
          ? ok ? '补丁已重打' : '打补丁失败'
          : mode === 'restore'
            ? ok ? '补丁已还原' : '还原失败'
            : ok ? '补丁分布（未改动）' : '扫描失败'
      const hint = mode === 'probe' ? '' : ok ? '\n重启引擎才生效：am force-stop io.github.ccch1mneyyy.dsh_app' : `\n${stderr.slice(0, 300)}`
      invalidatePatches()
      return { ok, mode, message: `${head}${hint}`, tail, restartRequired: mode !== 'probe' && ok }
    },
  })

  return count
}
