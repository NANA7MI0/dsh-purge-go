// 解开 lib/asset-table.json 里的正文。解不开就返回空串，调用方自己退回明文文件。
//
// 读 json 而不是 import js 模块：文件缺失 / 格式坏掉只是返回 ''，不会让整个插件加载失败。
import fs from 'node:fs'
import { createDecipheriv } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { appendDiag } from './home.js'
import { mixKey } from './table-key.js'

const TABLE_URL = new URL('./asset-table.json', import.meta.url)

// 按文件路径缓存：现在有两份密封文件（主正文、题材分类），
// 用同一个变量缓存会串味——第二次调用会拿到上一个文件的内容。
const cache = new Map()
// 诊断去重：同一个文件解不开只记一次，避免面板刷新把它写成几十 KB
const DIAG_SEEN = new Set()

/**
 * 解开任一密封文件，返回原文；解不开返回 ''，不抛。
 * 结果按 url 缓存，一个进程只解一次。
 * @param {URL} url 形如 new URL('./xxx-table.json', import.meta.url)
 */
export function openBox(url) {
  const key = String(url)
  if (cache.has(key)) return cache.get(key)
  let text = ''
  let why = ''
  try {
    const { SLOT, MASK, TAG, IV } = JSON.parse(fs.readFileSync(url, 'utf8'))
    const decipher = createDecipheriv('aes-256-gcm', mixKey(MASK), Buffer.from(IV, 'base64'))
    decipher.setAuthTag(Buffer.from(TAG, 'base64'))
    const raw = Buffer.concat([
      decipher.update(Buffer.from(SLOT, 'base64')),
      decipher.final(),
    ])
    text = inflateSync(raw).toString('utf8')
  } catch (error) {
    why = String((error && error.message) || error).slice(0, 120)
    text = ''
  }
  // 解不开要留痕：正文和分类整层变空是「静默失效」——面板显示 0 字节、注入什么都不发生，
  // 用户以为是自己关了，报问题时我们手上什么线索都没有。
  // 回退到 assets/ 明文这条路在产品包里不存在（明文不进 git 也不进 npm 包），
  // 所以这里不是「有退路所以不用管」，而是「没退路更要说」。
  if (!text) {
    // 同一个文件只记一次：这个函数在面板刷新（30 秒一次）和每次注入时都会走，
    // 每次都 append 的话日志几小时就涨到几十 KB，把真正有用的线索冲掉。
    // 而且失败结果现在不缓存（见下），所以调用频率比以前更高。
    if (!DIAG_SEEN.has(key)) {
      DIAG_SEEN.add(key)
      appendDiag(process.env.DSH_HOME || '', { stage: 'openBox', file: String(url), error: why })
    }
  }
  // 只缓存成功解出来的。解不开（文件损坏 / 还没写完）不进缓存——
  // 否则同一个进程里之后文件修好了也一直返回空串，只能重启引擎。
  // 反过来，空结果不缓存也意味着「每次都重试读一遍」，代价只是读一个小 json。
  if (text) cache.set(key, text)
  return text
}

/** 解出包内主正文；失败返回 ''。 */
export function openSlot() {
  return openBox(TABLE_URL)
}