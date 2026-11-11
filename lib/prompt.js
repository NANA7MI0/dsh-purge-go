// 提示词正文的解析与落盘。
// 解析优先级：byModel 指定变体 > 当前变体 > $DSH_HOME/prompt-inject.md > 包内 assets/default-prompt.md
import fs from 'node:fs'
import path from 'node:path'
import { dshHome, injectPath, promptsDir, readText, ensureDir, isDir, fileBytes } from './home.js'
import { loadCategories, applyCategories, looksLikeFrame } from './categories.js'

export const DEFAULT_VARIANT = 'default'

const DEFAULT_PROMPT_URL = new URL('../assets/default-prompt.md', import.meta.url)

/** 包内自带正文（首次启动用来 seed）。 */
export function defaultPromptText() {
  try {
    return fs.readFileSync(DEFAULT_PROMPT_URL, 'utf8')
  } catch {
    return ''
  }
}

/** 去 BOM、CRLF→LF、去掉尾部空白行。 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/** 变体名/模型名 → 安全文件名。模型名里带 `/`、`:` 是常态（如 vendor/model:free）。 */
export function sanitizeName(name) {
  const cleaned = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 64)
  return cleaned || DEFAULT_VARIANT
}

export function variantPath(home, name) {
  return path.join(promptsDir(home), `${sanitizeName(name)}.md`)
}

export function readVariant(home, name) {
  return normalizeText(readText(variantPath(home, name)))
}

/** @returns {{name:string,bytes:number,mtimeMs:number}[]} */
export function listVariants(home = dshHome()) {
  const dir = promptsDir(home)
  if (!isDir(dir)) return []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
    const full = path.join(dir, entry.name)
    const name = entry.name.replace(/\.md$/i, '')
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(full).mtimeMs
    } catch {
      mtimeMs = 0
    }
    out.push({ name, bytes: fileBytes(full), mtimeMs })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

export function writeVariant(home, name, text) {
  const target = variantPath(home, name)
  ensureDir(path.dirname(target))
  fs.writeFileSync(target, `${normalizeText(text)}\n`, 'utf8')
  return target
}

/** 从组装上下文里捞当前模型名（不同宿主字段名不一致，挨个试）。 */
export function modelOf(context) {
  if (!context || typeof context !== 'object') return ''
  const candidates = [
    context.variables && context.variables.model,
    context.assembly && context.assembly.variables && context.assembly.variables.model,
    context.model,
    context.agent && context.agent.model,
    context.agent && context.agent.options && context.agent.options.model,
    context.agent && context.agent.session && context.agent.session.header && context.agent.session.header.model,
    context.session && context.session.header && context.session.header.model,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * 解析本次要注入的正文。
 * @param {string} home
 * @param {{ state?: any, model?: string, maxBytes?: number }} [opts]
 * @returns {{ text:string, source:string, variant:string, model:string, bytes:number, truncated:boolean }}
 */
export function resolveInject(home, opts = {}) {
  const state = opts.state || {}
  const model = String(opts.model || '')
  const modelKey = model ? sanitizeName(model) : ''
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : 0

  let text = ''
  let source = 'empty'
  let variant = DEFAULT_VARIANT

  const mapped = modelKey && state.byModel ? state.byModel[modelKey] : ''
  if (mapped) {
    const hit = readVariant(home, mapped)
    if (hit) {
      text = hit
      source = 'variant:model'
      variant = mapped
    }
  }

  if (!text) {
    const active = typeof state.variant === 'string' && state.variant.trim() ? state.variant.trim() : DEFAULT_VARIANT
    if (active !== DEFAULT_VARIANT) {
      const hit = readVariant(home, active)
      if (hit) {
        text = hit
        source = 'variant'
        variant = active
      }
    }
  }

  if (!text) {
    const file = normalizeText(readText(injectPath(home)))
    if (file) {
      text = file
      source = 'prompt-inject.md'
    }
  }

  if (!text) {
    const builtin = normalizeText(defaultPromptText())
    if (builtin) {
      text = builtin
      source = 'builtin'
    }
  }

  // 题材分类扩展层：Scoped Rules 26+ 与意图映射扩展行在组装时整块重算，正文文件里不必留痕。
  let categoryCount = 0
  if (text && opts.categories !== false && looksLikeFrame(text)) {
    try {
      const loaded = loadCategories(home)
      categoryCount = loaded.entries.length
      text = applyCategories(text, loaded.entries)
    } catch {
      /* 分类读坏了不影响主正文 */
    }
  }

  let truncated = false
  if (maxBytes && Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
    truncated = true
  }

  return { text, source, variant, model, bytes: Buffer.byteLength(text, 'utf8'), truncated, categories: categoryCount }
}

/**
 * 首次启动把包内正文落到 $DSH_HOME/prompt-inject.md（桌面版也读这个文件，两边可共用）。
 * @returns {{ written:boolean, path:string, bytes:number }}
 */
export function seedInject(home = dshHome(), opts = {}) {
  const target = injectPath(home)
  const existing = normalizeText(readText(target))
  if (existing && !opts.force) return { written: false, path: target, bytes: fileBytes(target) }
  const raw = normalizeText(defaultPromptText())
  if (!raw) return { written: false, path: target, bytes: 0 }
  let builtin = raw
  try {
    builtin = applyCategories(raw, loadCategories(home).entries)
  } catch {
    builtin = raw
  }
  ensureDir(path.dirname(target))
  fs.writeFileSync(target, `${builtin}\n`, 'utf8')
  return { written: true, path: target, bytes: fileBytes(target) }
}

export function writeInject(home, text) {
  const target = injectPath(home)
  ensureDir(path.dirname(target))
  fs.writeFileSync(target, `${normalizeText(text)}\n`, 'utf8')
  return { path: target, bytes: fileBytes(target) }
}

/** DSH 只承认 {{cwd}} / {{model}} / {{provider}}，其余 `{{` 会把整段丢掉 → 拆开写。 */
const ALLOWED_VAR = /^\{\{\s*(cwd|model|provider)\s*\}\}$/
export function escapeInterpolation(text) {
  const src = String(text ?? '')
  let out = ''
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{{', i)
    if (open === -1) {
      out += src.slice(i)
      break
    }
    out += src.slice(i, open)
    const close = src.indexOf('}}', open + 2)
    if (close === -1) {
      out += src.slice(open)
      break
    }
    const token = src.slice(open, close + 2)
    out += ALLOWED_VAR.test(token) ? token : `{ ${token.slice(1).replace(/^\s+/, '')}`
    i = close + 2
  }
  return out
}
