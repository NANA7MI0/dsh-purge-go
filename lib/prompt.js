// 提示词正文的解析与落盘。
// 解析优先级：byModel 指定变体 > 当前变体 > $DSH_HOME/prompt-inject.md > 包内 assets/default-prompt.md
import fs from 'node:fs'
import path from 'node:path'
import { dshHome, injectPath, promptsDir, readText, ensureDir, isDir, isFile, fileBytes, writeAtomic, appendDiag } from './home.js'
import { loadCategories, applyCategories, looksLikeFrame } from './categories.js'
import { openSlot } from './table-read.js'

export const DEFAULT_VARIANT = 'default'

const DEFAULT_PROMPT_URL = new URL('../assets/default-prompt.md', import.meta.url)

let sealedCache = null

/**
 * 包内自带正文（首次启动用来 seed）。
 *
 * 优先用 lib/asset-table.json 里的加密副本——仓库里只有它，明文 assets/default-prompt.md 不进 git。
 * 解不开（没打包、或换了密钥）才退回明文文件；开发时直接编辑明文、跑 embed 脚本即可。
 */
export function defaultPromptText() {
  // 只缓存非空的：解不开时不缓存，下次还会重试。
  // 以前一旦解出空串就永久返回空，install.sh 覆盖好 asset-table.json 之后
  // 同一个进程里依然读不到正文，只能重启引擎。
  if (sealedCache) return sealedCache
  try {
    const sealed = openSlot()
    if (sealed) { sealedCache = sealed; return sealed }
  } catch {}
  try {
    sealedCache = fs.readFileSync(DEFAULT_PROMPT_URL, 'utf8')
  } catch {
    sealedCache = ''
  }
  return sealedCache
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

/**
 * 变体名到文件路径。
 *
 * 为什么不再过 sanitizeName：那是「文件名清洗」规则，会把大小写压平、把中文整段
 * 换成下划线——『中文变体』会变成空串、再退回 'default'，于是 use 成功、实际没切，
 * 甚至把用户手写的变体写进 default.md 把默认变体覆盖掉。
 *
 * 现在直接用原始名，只做路径穿越防护。变体名是用户在 prompts/ 目录里自己建的文件名，
 * 保留原样最符合直觉：列表里显示什么，命令行就敲什么。
 */
export function variantPath(home, name) {
  const raw = String(name ?? '').trim()
  if (!raw) throw new Error('变体名为空')
  // 只允许单层文件名：不许带目录分隔符、不许 . 或 .. 开头、不许有 NUL
  if (/[\/\\\0]/.test(raw) || raw === '.' || raw === '..' || raw.startsWith('.')) {
    throw new Error(`变体名不能用这个：${raw}`)
  }
  return path.join(promptsDir(home), `${raw}.md`)
}

export function readVariant(home, name) {
  // 读操作不该抛：名字不合法（空、带目录分隔符）等于「这个变体不存在」，
  // 返回空串让调用方接着走下一级来源（变体 → prompt-inject.md → 内置）。
  // 校验留给 variantPath（写入路径），那里抛错才对——写错地方是真事故。
  try {
    return normalizeText(readText(variantPath(home, name)))
  } catch {
    return ''
  }
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
  // 顺序有讲究：modelSelection 排第一。
  //
  // agent.options.model 是「这个会话第一次记录选择之前的兜底值」（引擎自己的
  // dsh-agent/lib/types/model-selection.js 注释就是这么写的）。用户在会话中途切换模型后，
  // modelSelection 才是当前值，而 options 还停在初始那个——以前 options 排在前面，
  // 于是「按模型指定变体」一直按旧模型选，切了模型也不生效，而且看不出任何异常。
  const candidates = [
    context.modelSelection && context.modelSelection.model,
    context.variables && context.variables.model,
    context.assembly && context.assembly.variables && context.assembly.variables.model,
    context.model,
    context.agent && context.agent.model,
    context.agent && context.agent.session && context.agent.session.header && context.agent.session.header.model,
    context.session && context.session.header && context.session.header.model,
    // 兜底放最后：只在上面全都没有时才用初始值
    context.agent && context.agent.options && context.agent.options.model,
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
  // 模型名直接当 byModel 的键用原始值：JSON 键支持任意 UTF-8，不需要按文件名清洗。
  // 以前过 sanitizeName，『深度求索/对话』会被压成 'default'，所有中文模型塌成同一个键。
  const modelKey = model.trim()
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
  //
  // 关掉时（categories === false）也要调一次 applyCategories，传 enabled:false——
  // 它会把正文里已经存在的分类块删掉。以前这里是「关掉就整段跳过」，
  // 结果老用户正文里早先烘焙进去的那块一直留着，等于开关关不掉。
  let categoryCount = 0
  if (text && looksLikeFrame(text)) {
    try {
      const on = opts.categories !== false
      const loaded = loadCategories(home)
      categoryCount = on ? loaded.entries.length : 0
      text = applyCategories(text, loaded.entries, { enabled: on })
    } catch (error) {
      // 分类读坏了不影响主正文，但不能一声不响：以前这里纯注释，
      // 结果是「注入正文少了一千多字节的分类块，面板上什么都看不出来」。
      appendDiag(home || dshHome(), { stage: 'categories', error: String(error?.message || error).slice(0, 120) })
    }
  }

  let truncated = false
  if (maxBytes && Buffer.byteLength(text, 'utf8') > maxBytes) {
    // 按码点累加，不能在 Buffer 上按字节切：截断点落在汉字/emoji 中间会生成 U+FFFD，
    // 提示词末尾变成乱码，而且替换符本身占 3 字节，实际长度还会超过配置的上限。
    let bytes = 0
    let end = 0
    for (const ch of text) {
      const n = Buffer.byteLength(ch, 'utf8')
      if (bytes + n > maxBytes) break
      bytes += n
      end += ch.length
    }
    text = text.slice(0, end).trimEnd()
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
  // 判「要不要 seed」看**文件在不在**，不看内容是否为空。
  //
  // 以前用 normalizeText(readText(target)) 判空：用户故意把正文清空（只留空白/换行）时，
  // 规范化后是空串，于是被当成「还没 seed 过」，下次启动又把 21 KB 默认正文写回去——
  // 用户想彻底关掉注入的努力被静默撤销。
  // 文件存在就说明「这个用户已经有自己的正文了，哪怕是空的」，不该动。
  if (isFile(target) && !opts.force) {
    return { written: false, path: target, bytes: fileBytes(target) }
  }
  const existing = normalizeText(readText(target))
  if (existing && !opts.force) return { written: false, path: target, bytes: fileBytes(target) }
  const raw = normalizeText(defaultPromptText())
  if (!raw) return { written: false, path: target, bytes: 0 }
  // 种子只写主正文，**不烘焙分类块**。
  // 原因：分类层是「组装时按开关决定拼不拼」的东西，一旦写进文件就变成了正文的一部分，
  // 之后 categories:false 关不掉、手删标记还会被 applyCategories 的追加分支加回来。
  // 老用户文件里已经烘焙过的块，会在 categories:false 生效时由 applyCategories 自动清掉。
  const builtin = raw
  // 原子写：assemble 每一步都会读这个文件，杀进程/断电留下半截正文会让提示词整段坏掉
  writeAtomic(target, `${builtin}\n`)
  return { written: true, path: target, bytes: fileBytes(target) }
}

export function writeInject(home, text) {
  const target = injectPath(home)
  writeAtomic(target, `${normalizeText(text)}\n`)
  return { path: target, bytes: fileBytes(target) }
}

/**
 * DSH 只承认 {{cwd}} / {{model}} / {{provider}}，其余 `{{` 会把整段丢掉 → 拆开写。
 *
 * 注意：注入正文这一段**不再用它**（assemble.js 里的那段注册时就 interpolate:false，
 * 引擎根本不做替换）。留在这里是给「需要插值的段」备用的——目前没有这样的段调用它，
 * 只有测试在测它的行为。真要接到某段上，先确认那段的 interpolate 是 true。 */
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
