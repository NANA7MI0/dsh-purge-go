// /purge 命令。手机上打字不方便，所以正文写入支持「从文件读」：/purge prompt set /sdcard/x.md
import { readFileSync } from 'node:fs'
import { dshHome, purgeDir, injectPath, isFile } from './home.js'
import { readState, setEnabled } from './state.js'
import { snapshot } from './view.js'
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
import { listVariants, sanitizeName } from './prompt.js'

const HELP = [
  '/purge status · 现状（开关、来源、体积、变体）',
  '/purge on | off · 开关注入',
  '/purge apply [force] · 开启并确保正文存在',
  '/purge revert · 关闭并把正文备份到 dsh-purge/backups/',
  '/purge seed [force] · 重写包内默认正文到 prompt-inject.md',
  '/purge prompt show · 看正文前 1200 字',
  '/purge prompt set <文件> · 用文件的全文替换正文',
  '/purge prompt reset · 恢复包内默认正文',
  '/purge variant list · 列出变体',
  '/purge variant use <名字> · 切到某个变体',
  '/purge variant default · 回到默认变体',
  '/purge variant map <模型> <名字|-> · 按模型指定变体（- 取消）',
  '/purge cat list · 题材分类（含编号、别名、路由）',
  '/purge cat show <id> · 看一条分类的规则正文',
  '/purge cat on|off <id> · 单独开关一条分类',
  '/purge cat add <id> <别名,别名> <规则正文> [| 路由] · 加一条',
  '/purge cat rm <id> · 删一条（出厂项写墓碑，可 reset 复原）',
  '/purge cat reset · 丢掉覆盖层，回到包内出厂分类',
  '/purge cat bake · 把当前分类真正写进 prompt-inject.md',
  '/purge home · 相关路径',
].join('\n')

/** /purge cat 的输出：编号 · id · 别名 → 路由，关掉的打 x。 */
function categoryText(home) {
  const { all, entries, warnings } = categoryList(home)
  if (!all.length) return '没有任何题材分类。'
  const lines = [`题材分类：${entries.length}/${all.length} 生效`]
  for (const entry of all) {
    const mark = entry.enabled ? '·' : 'x'
    lines.push(`${mark} ${entry.n}. ${entry.id} · ${entry.labels.join('/')}${entry.route ? ` → ${entry.route}` : ''}`)
  }
  if (warnings.length) lines.push(`注意：${warnings.join('；')}`)
  return lines.join('\n')
}

function statusText(home, config) {
  const snap = snapshot(home, config)
  const lines = [
    `破甲：${snap.enabled ? '开' : '关'} · ${snap.bytes} 字节 / ${snap.chars} 字`,
    `来源：${snap.sourceLabel} · 变体：${snap.variant}${snap.last?.model ? ` · 模型：${snap.last.model}` : ''}`,
    `主文件：${snap.injectPath}${snap.injectExists ? '' : '（缺失）'}`,
  ]
  const byModel = Object.entries(snap.byModel || {})
  if (byModel.length) lines.push(`按模型：${byModel.map(([m, v]) => `${m}→${v}`).join(', ')}`)
  const dropped = snap.last?.dropped || []
  if (dropped.length) lines.push(`压掉的官方段：${dropped.join(', ')}`)
  return lines.join('\n')
}

function readPromptFile(file) {
  const path = String(file || '').trim()
  if (!path) throw new Error('用法：/purge prompt set <文件路径>')
  if (!isFile(path)) throw new Error(`读不到文件：${path}`)
  const body = readFileSync(path, 'utf8')
  if (!body.trim()) throw new Error('文件是空的')
  if (body.length > MAX_PROMPT_CHARS) throw new Error(`正文超过 ${MAX_PROMPT_CHARS} 字符`)
  return body
}

/** `/purge cat ...` 的解析：规则正文里可能有空格，路由用 `|` 隔开。 */
function runCategory(raw, home) {
  const input = String(raw || '').trim()
  const [head, ...tail] = input.split('|')
  const action = (head.trim().split(/\s+/)[0] || 'list').toLowerCase()
  const route = tail.join('|').trim()
  const rest = head.trim().split(/\s+/).slice(1).filter(Boolean)

  if (action === 'list' || action === 'ls') return categoryText(home)
  if (action === 'show') {
    const id = (rest[0] || '').toLowerCase()
    const { all } = categoryList(home)
    const hit = all.find((entry) => entry.id === id)
    if (!hit) throw new Error(`没有这个分类：${rest[0] || '(空)'}`)
    return [
      `# ${hit.n} ${hit.id} · ${hit.enabled ? '生效' : '已关'}`,
      `别名：${hit.labels.join(' / ')}`,
      `路由：${hit.route || '(无)'}`,
      `来源：${hit.source}`,
      '',
      hit.rule,
    ].join('\n')
  }
  if (action === 'add' || action === 'set') {
    const id = rest[0]
    const labels = rest[1]
    const rule = rest.slice(2).join(' ')
    if (!id || !labels || !rule) throw new Error('用法：/purge cat add <id> <别名,别名> <规则正文> [| 路由]')
    const added = categoryAdd(home, { id, labels, rule, route })
    return `已加分类 ${added.entry.n}. ${added.entry.id}（${added.entry.labels.join('/')}）；共 ${added.entries.length} 条生效`
  }
  if (action === 'rm' || action === 'del' || action === 'remove') {
    const id = rest[0]
    if (!id) throw new Error('用法：/purge cat rm <id>')
    const result = categoryRemove(home, id)
    return result.removed ? `已删分类 ${id}；剩 ${result.entries.length} 条生效` : `本来就没有 ${id}`
  }
  if (action === 'on' || action === 'off') {
    const id = rest[0]
    if (!id) throw new Error(`用法：/purge cat ${action} <id>`)
    const result = categoryToggle(home, id, action === 'on')
    return `分类 ${id} 已${action === 'on' ? '开' : '关'}；共 ${result.entries.length} 条生效`
  }
  if (action === 'reset') {
    const list = categoryReset(home)
    return `覆盖层已清空，回到出厂分类（${list.entries.length} 条生效）`
  }
  if (action === 'bake') {
    const baked = categoryBake(home)
    return `已写入 ${baked.bytes} 字节 → ${baked.path}（${baked.categories} 条分类）`
  }
  throw new Error(`不认识的 cat 子命令：${action}（list|show|add|rm|on|off|reset|bake）`)
}

/**
 * @param {string} raw invocation.rawInput
 * @param {{ home: string, config: any }} deps
 * @returns {string}
 */
export function runPurge(raw, deps) {
  const { home, config } = deps
  const input = String(raw || '').trim()
  const [head, ...rest] = input.split(/\s+/).filter(Boolean)
  const sub = (head || 'status').toLowerCase()

  if (!head || sub === 'status') return statusText(home, config)
  if (sub === 'help' || sub === '?') return HELP

  if (sub === 'on' || sub === 'enable') {
    setEnabled(home, true)
    return `破甲已开启（${snapshot(home, config).bytes} 字节）`
  }
  if (sub === 'off' || sub === 'disable') {
    setEnabled(home, false)
    return '破甲已关闭'
  }
  if (sub === 'apply') {
    const seeded = seed(home, { force: rest[0] === 'force' })
    setEnabled(home, true)
    return `破甲已开启；${seeded.written ? '已写入包内默认正文' : '沿用现有正文'}（${seeded.bytes} 字节）`
  }
  if (sub === 'revert' || sub === 'rollback') {
    const result = revert(home)
    return result.backup ? `破甲已关闭，正文备份到 ${result.backup}` : '破甲已关闭（没有可备份的正文）'
  }
  if (sub === 'seed') {
    const result = seed(home, { force: rest[0] === 'force' })
    return result.written ? `已写入包内默认正文（${result.bytes} 字节）` : '已有正文，未覆盖（加 force 强制重写）'
  }

  if (sub === 'prompt') {
    const action = (rest[0] || 'show').toLowerCase()
    if (action === 'show') {
      const snap = snapshot(home, config)
      return `${snap.sourceLabel} · ${snap.bytes} 字节 / ${snap.chars} 字\n\n${snap.text.slice(0, 1200)}`
    }
    if (action === 'set') {
      const body = readPromptFile(rest[1])
      const written = setPrompt(home, body)
      return `已写入 ${written.bytes} 字节 → ${written.path}`
    }
    if (action === 'reset') {
      seed(home, { force: true })
      return `已恢复包内默认正文（${snapshot(home, config).bytes} 字节）`
    }
    throw new Error(`不认识的 prompt 子命令：${action}（show|set|reset）`)
  }

  if (sub === 'variant') {
    const action = (rest[0] || 'list').toLowerCase()
    if (action === 'list') {
      const variants = listVariants(home)
      const active = readState(home).variant
      if (!variants.length) return `还没有变体。把 .md 放进 ${purgeDir(home)}/prompts/ 即可。`
      return variants.map((v) => `${v.name === active ? '*' : ' '} ${v.name} · ${v.bytes} 字节`).join('\n')
    }
    if (action === 'use') {
      const used = useVariant(home, rest[1])
      return `已切到变体 ${used.variant}`
    }
    if (action === 'default') {
      resetVariant(home)
      return '已回到默认变体'
    }
    if (action === 'map') {
      const model = sanitizeName(rest[1])
      const name = rest[2] === '-' ? '' : rest[2]
      const mapped = mapModel(home, rest[1], name)
      return mapped.variant ? `模型 ${model} → 变体 ${mapped.variant}` : `已取消模型 ${model} 的指定`
    }
    throw new Error(`不认识的 variant 子命令：${action}（list|use|default|map）`)
  }

  if (sub === 'cat' || sub === 'category' || sub === 'categories') {
    return runCategory(input.replace(/^\S+\s*/, ''), home)
  }

  if (sub === 'home') {
    return [
      `DSH_HOME：${dshHome()}`,
      `状态：${purgeDir(home)}/state.json`,
      `变体：${purgeDir(home)}/prompts/`,
      `备份：${purgeDir(home)}/backups/`,
      `正文：${injectPath(home)}`,
    ].join('\n')
  }

  throw new Error(`不认识的子命令：${sub}（/purge help 看用法）`)
}

/**
 * @param {any} ctx 已经 inject(['commands']) 的 ctx
 * @param {{ home: string, config: any, warn: (message: string) => void }} deps
 */
export function registerCommands(ctx, deps) {
  const commands = ctx.commands
  if (!commands || typeof commands.register !== 'function') return false
  try {
    commands.register({
      name: 'purge',
      description: '破甲（提示词注入）开关与正文管理：status / on / off / apply / revert / prompt / variant',
      input: { hint: 'status | on | off | apply | revert | seed | prompt show|set|reset | variant list|use|default|map | cat list|show|add|rm|on|off|reset|bake | home' },
      handler: async (invocation) => {
        try {
          return { kind: 'success', text: runPurge(invocation?.rawInput, deps) }
        } catch (error) {
          return { kind: 'error', text: `[dsh-purge] ${error?.message || error}` }
        }
      },
    })
    return true
  } catch (error) {
    deps.warn(`命令 /purge 注册失败：${error?.message || error}`)
    return false
  }
}
