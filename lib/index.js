// dsh-purge-go：把桌面版 dsh-purge 的「提示词注入」内核抽成独立 DSH 插件，
// 只依赖官方扩展点（systemPrompt.section / system-prompt:assemble / agent:pre-step /
// tools / commands / dshGo），因此同一份代码既跑在 PC 引擎上，也跑在 dsh-go 的 Android 引擎里。
//
// 与桌面版的区别（有意为之）：
//   · 不改引擎文件、不解包 asar、不重启宿主、不碰 PowerShell —— 所以没有「换包」这套东西；
//   · 「应用/回滚」重定义为「开关注入 + 落盘/备份正文」；
//   · 身份段与 persona 段的压制改由 assemble waterfall 完成，任何 0.2.x 引擎都成立。
import { dshHome, purgeDir, statePath, ensureDir, isFile } from './home.js'
import { readState, writeState } from './state.js'
import { seedInject, resolveInject } from './prompt.js'
import { capabilityProtocolText, CAPABILITY_SECTION, CAPABILITY_ORDER } from './capability.js'
import { installAssembleHook, INJECT_SECTION, INJECT_ORDER, POST_SECTION } from './assemble.js'
import { registerTools } from './tools.js'
import { registerCommands } from './commands.js'
import { installNative } from './native.js'
import { installRegionGate } from './region.js'
import { readObjectiveCard } from './objective.js'
import { installRecover, RECOVER_DEFAULTS } from './recover.js'
import { syncSkills, syncPreset, redteamSummary } from './redteam.js'

export const name = 'dsh-purge-go'

// 只声明本插件「必须有」的服务。dshGo / tools / commands 一律用 ctx.inject([...]) 局部等待，
// 写进顶层 inject 会让没有这些服务的宿主一直等待（Cordis 空等，宿主可能直接退出）。
export const inject = ['systemPrompt']

export const DEFAULTS = {
  enabled: true,
  dropConflicts: true,
  capabilityProtocol: true,
  postPrompt: '',
  postPromptOrder: 5100,
  stripMnemon: true,
  seedPrompt: true,
  injectSection: true,
  maxPromptBytes: 262_144,
  tools: true,
  commands: true,
  native: true,
  // 地区门：把「禁止范围」判在 agent/pre-step，命中就写禁止句并收掉这一轮的工具调用。
  regionGate: true,
  // 拒答续跑：模型以「抱歉 / 我不能」收工时追一句，按 seq 去重、每会话有上限。
  recoverRefusal: true,
  recoverMax: RECOVER_DEFAULTS.recoverMax,
  recoverCooldownMs: RECOVER_DEFAULTS.recoverCooldownMs,
  recoverText: '',
  // 目标卡：把 redteam/current 指到的靶标写成一段系统提示，避免越打越大。
  objectiveCard: true,
  // 随包红队技能与预设：启动时同步到 <home>/redteam/skills 与 <home>/.agent-presets/redteam。
  redteamAssets: true,
  // 题材分类扩展层：把 Scoped Rules 26+ 与意图映射扩展行在组装时拼进正文（数据在 categories.json）。
  categories: true,
  verbose: false,
  home: '',
}

const ALLOWED_ORDER = (order) => Number.isFinite(order)

/** 注册一个提示词段；宿主没有 systemPrompt 或段已存在都不算致命。 */
function addSection(ctx, section, warn) {
  if (!ALLOWED_ORDER(section.order)) {
    warn(`段 ${section.name} 的 order 非法：${section.order}`)
    return false
  }
  const hosts = []
  try {
    if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') hosts.push(ctx.systemPrompt)
  } catch {
    /* 服务未就绪 */
  }
  try {
    const nested = ctx.systemPrompt?.ctx?.systemPrompt
    if (nested && hosts[0] !== nested && typeof nested.section === 'function') hosts.push(nested)
  } catch {
    /* 老宿主没有 .ctx */
  }
  if (!hosts.length) {
    warn('宿主没有 systemPrompt 服务，提示词段未注册')
    return false
  }
  let lastError
  for (const host of hosts) {
    try {
      host.section(section)
      return true
    } catch (error) {
      if (/already|duplicate/i.test(String(error?.message || ''))) return true
      lastError = error
    }
  }
  warn(`段 ${section.name} 注册失败：${lastError?.message || lastError}`)
  return false
}

/** 压掉 mnemon 这类插件在每步塞进来的记忆消息（桌面版同款行为，可按开关关掉）。 */
function installMnemonStrip(ctx, warn) {
  const isMnemon = (message) => {
    const source = message && message.source
    return Boolean(source && source.kind === 'plugin' && String(source.plugin || '').toLowerCase().includes('mnemon'))
  }
  const wrap = async (...args) => {
    const next = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
    if (!next) return args[0]
    const decision = await next()
    if (!decision || typeof decision !== 'object') return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : null
    if (!messages) return decision
    const kept = messages.filter((message) => !isMnemon(message))
    return kept.length === messages.length ? decision : { ...decision, messages: kept }
  }
  try {
    ctx.on('agent/pre-step', wrap, { global: true, prepend: true })
  } catch {
    try {
      ctx.on('agent/pre-step', wrap)
    } catch (error) {
      warn(`agent/pre-step 未接管：${error?.message || error}`)
    }
  }
}

/** @param {any} ctx @param {Record<string, any>} [config] */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const [key, value] of Object.entries(config)) if (value !== undefined) cfg[key] = value
  }
  const home = cfg.home ? String(cfg.home) : dshHome()
  const warn = (message) => {
    try {
      if (cfg.verbose) console.warn(`[dsh-purge-go] ${message}`)
    } catch {
      /* 没有 console 的宿主 */
    }
  }

  try {
    ensureDir(purgeDir(home))
    if (cfg.seedPrompt !== false) seedInject(home)
    if (!isFile(statePath(home))) writeState(home, { enabled: cfg.enabled !== false })
  } catch (error) {
    warn(`初始化失败：${error?.message || error}`)
  }

  const injectOptions = () => {
    let enabled = cfg.enabled !== false
    try {
      enabled = readState(home).enabled !== false
    } catch {
      /* 读不到状态就按默认 */
    }
    return {
      enabled,
      home,
      dropConflicts: cfg.dropConflicts !== false,
      maxBytes: cfg.maxPromptBytes,
      categories: cfg.categories !== false,
    }
  }

  installAssembleHook(ctx, injectOptions)

  if (cfg.injectSection !== false) {
    addSection(
      ctx,
      {
        name: INJECT_SECTION,
        order: INJECT_ORDER,
        interpolate: false,
        text: () => {
          const options = injectOptions()
          if (!options.enabled) return ''
          return resolveInject(home, {
            state: readState(home),
            maxBytes: cfg.maxPromptBytes,
            categories: cfg.categories !== false,
          }).text
        },
      },
      warn,
    )
  }

  if (cfg.capabilityProtocol !== false) {
    addSection(
      ctx,
      {
        name: CAPABILITY_SECTION,
        order: CAPABILITY_ORDER,
        interpolate: false,
        text: () => (injectOptions().enabled ? capabilityProtocolText({ home }) : ''),
      },
      warn,
    )
  }

  if (cfg.objectiveCard !== false) {
    addSection(
      ctx,
      {
        name: 'dshpg-objective',
        order: CAPABILITY_ORDER + 1,
        interpolate: false,
        text: () => {
          if (!injectOptions().enabled) return ''
          try {
            return readObjectiveCard(home)
          } catch {
            return ''
          }
        },
      },
      warn,
    )
  }

  const postPrompt = typeof cfg.postPrompt === 'string' ? cfg.postPrompt.trim() : ''
  if (postPrompt) {
    addSection(
      ctx,
      {
        name: POST_SECTION,
        order: Number.isFinite(cfg.postPromptOrder) && cfg.postPromptOrder > INJECT_ORDER ? cfg.postPromptOrder : 5100,
        interpolate: false,
        text: () => (injectOptions().enabled ? postPrompt : ''),
      },
      warn,
    )
  }

  if (cfg.stripMnemon !== false) installMnemonStrip(ctx, warn)

  if (cfg.regionGate !== false) {
    try {
      installRegionGate(ctx)
    } catch (error) {
      warn(`地区门未接管：${error?.message || error}`)
    }
  }

  let recover = null
  if (cfg.recoverRefusal !== false) {
    try {
      recover = installRecover(ctx, {
        getConfig: () => ({
          recoverRefusal: cfg.recoverRefusal !== false,
          recoverMax: cfg.recoverMax,
          recoverCooldownMs: cfg.recoverCooldownMs,
          recoverText: cfg.recoverText,
        }),
        warn,
      })
    } catch (error) {
      warn(`拒答续跑未接管：${error?.message || error}`)
    }
  }

  let assets = { skills: 0, preset: false }
  if (cfg.redteamAssets !== false) {
    try {
      const synced = syncSkills(home)
      const preset = syncPreset(home)
      assets = { skills: synced.total, preset: preset.action !== 'kept' || preset.files > 0 }
      warn(`红队资产：技能 ${synced.total} 个（写入 ${synced.written}）· 预设 ${preset.action}`)
    } catch (error) {
      warn(`红队资产同步失败：${error?.message || error}`)
      try {
        assets = redteamSummary(home)
      } catch {
        assets = { skills: 0, preset: false }
      }
    }
  }

  const deps = { home, config: cfg, warn }

  if (cfg.tools !== false) {
    try {
      ctx.inject(['tools'], (scoped) => registerTools(scoped, deps))
    } catch (error) {
      warn(`tools 注入失败：${error?.message || error}`)
    }
  }
  if (cfg.commands !== false) {
    try {
      ctx.inject(['commands'], (scoped) => registerCommands(scoped, deps))
    } catch (error) {
      warn(`commands 注入失败：${error?.message || error}`)
    }
  }
  if (cfg.native !== false) {
    try {
      ctx.inject(['dshGo'], (scoped) => installNative(scoped, deps))
    } catch (error) {
      warn(`dshGo 注入失败：${error?.message || error}`)
    }
  }

  // 让宿主知道这次加载生效了哪些部分（面板/diagnostics 会读）
  return {
    name,
    home,
    regionGate: cfg.regionGate !== false,
    recoverRefusal: cfg.recoverRefusal !== false,
    objectiveCard: cfg.objectiveCard !== false,
    redteam: assets,
    recover,
    sections: [INJECT_SECTION, cfg.capabilityProtocol !== false ? CAPABILITY_SECTION : null, postPrompt ? POST_SECTION : null].filter(Boolean),
  }
}

export default { name, inject, apply, DEFAULTS }
