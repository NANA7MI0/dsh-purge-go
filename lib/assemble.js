// 提示词组装：把注入段顶到最前面，并按需压掉会与本插件抢身份的官方段。
// 桌面版靠改引擎 assemble() 实现这段；这里只用官方 `system-prompt/assemble` waterfall，
// 所以换任何 0.2.x 引擎（含 dsh-go 的 Android 引擎）都不用重打补丁。
import { resolveInject, modelOf, escapeInterpolation } from './prompt.js'
import { readState, noteInject } from './state.js'

/** 本插件自己的段：注入正文 + 后置补充段。 */
export const INJECT_SECTION = 'dsh-purge'
export const POST_SECTION = 'dsh-purge:post'
export const INJECT_ORDER = -100000

const MINE = /^dsh-purge/i
/** 本插件自有段（含能力协议段）：一起顶到最前面，并保持它们在原列表里的相对顺序。 */
const OWNED = /^(dsh-purge|dshpg-)/i
/** 官方身份段：与本插件的 `<project_instructions>` 正文冲突，默认压掉。 */
const CONFLICT = /^(harness:identity|deployment:persona-prefix|deployment:persona-suffix)$/i

/** 上一次组装的实际结果，给面板与工具显示「这次真注入了什么」。 */
let last = { at: '', bytes: 0, source: '', variant: 'default', model: '', sections: 0, dropped: [], enabled: false }

// 每步组装都会走这里，状态文件不能跟着每一步写一次盘（Android 的 PRoot 上尤其贵）。
const NOTE_TTL_MS = 60_000
let noted = { key: '', at: 0 }

function noteQuietly(home, info) {
  const key = `${info.bytes}|${info.source}|${info.model}`
  const now = Date.now()
  if (key === noted.key && now - noted.at < NOTE_TTL_MS) return
  noted = { key, at: now }
  try {
    noteInject(home, info)
  } catch {
    /* 状态文件写不动不影响注入 */
  }
}

export function rememberAssembly(info) {
  last = { ...last, ...info, at: new Date().toISOString() }
  return last
}

export function lastAssembly() {
  return last
}

export function isMine(name) {
  return MINE.test(String(name || ''))
}

export function isConflict(name, dropConflicts = true) {
  return dropConflicts && CONFLICT.test(String(name || ''))
}

/**
 * 重排一份组装结果：本插件段在前（保持内部相对顺序），其余保序；冲突段按开关丢弃。
 * @param {{sections?: any[]}} assembly
 * @param {{ injectText?: string, dropConflicts?: boolean }} [opts]
 */
export function rewriteAssembly(assembly, opts = {}) {
  if (!assembly || typeof assembly !== 'object') return assembly
  const sections = Array.isArray(assembly.sections) ? assembly.sections : []
  const injectText = typeof opts.injectText === 'string' ? opts.injectText : ''
  const dropConflicts = opts.dropConflicts !== false

  const mine = []
  const rest = []
  const dropped = []
  let injectSeen = false

  for (const section of sections) {
    if (!section || typeof section !== 'object') continue
    const name = String(section.name || '')
    if (OWNED.test(name)) {
      // 注入正文以这里解析出的为准（按当前模型选变体），其余自有段原样保留
      if (name === INJECT_SECTION || /^dsh-purge(:inject)?$/i.test(name)) {
        if (injectSeen) continue
        injectSeen = true
        mine.push(injectText ? { name: INJECT_SECTION, text: injectText, interpolate: false } : section)
        continue
      }
      mine.push(section)
      continue
    }
    if (isConflict(name, dropConflicts)) {
      dropped.push(name)
      continue
    }
    rest.push(section)
  }

  if (injectText && !injectSeen) mine.unshift({ name: INJECT_SECTION, text: injectText, interpolate: false })

  return { ...assembly, sections: [...mine, ...rest], __dropped: dropped }
}

/**
 * 安装 waterfall。宿主签名有 2 参与 3 参两种（旧 cordis），都兜住。
 * @param {any} ctx
 * @param {(context:any, assembly:any) => { enabled:boolean, home:string, dropConflicts:boolean, maxBytes?:number }} getOptions
 */
export function installAssembleHook(ctx, getOptions) {
  const handler = async (...args) => {
    const assembly = args[0]
    const context = args[1]
    const next = typeof args[args.length - 1] === 'function' && args.length >= 3 ? args[args.length - 1] : null

    let assembled = assembly
    if (next) {
      try {
        assembled = await next()
      } catch {
        assembled = assembly
      }
    }

    let opts = { enabled: false }
    try {
      opts = getOptions(context, assembled) || opts
    } catch {
      return assembled
    }

    try {
      if (!opts.enabled) {
        rememberAssembly({ enabled: false, bytes: 0, source: 'off', model: modelOf(context) })
        return assembled
      }
      const home = opts.home
      const state = readState(home)
      const model = modelOf(context) || modelOf(assembled)
      const resolved = resolveInject(home, {
        state,
        model,
        maxBytes: opts.maxBytes,
        categories: opts.categories !== false,
      })
      if (!resolved.text) return assembled
      const text = escapeInterpolation(resolved.text)
      const rewritten = rewriteAssembly(assembled, { injectText: text, dropConflicts: opts.dropConflicts })
      const info = rememberAssembly({
        enabled: true,
        bytes: Buffer.byteLength(text, 'utf8'),
        source: resolved.source,
        variant: resolved.variant,
        model,
        sections: Array.isArray(rewritten.sections) ? rewritten.sections.length : 0,
        dropped: rewritten.__dropped || [],
        truncated: resolved.truncated,
      })
      noteQuietly(home, { bytes: info.bytes, source: info.source, model })
      delete rewritten.__dropped
      return rewritten
    } catch {
      return assembled
    }
  }

  try {
    ctx.on('system-prompt/assemble', handler)
    return true
  } catch {
    return false
  }
}
