// 解开 lib/asset-table.json 里的正文。解不开就返回空串，调用方自己退回明文文件。
//
// 读 json 而不是 import js 模块：文件缺失 / 格式坏掉只是返回 ''，不会让整个插件加载失败。
import fs from 'node:fs'
import { createDecipheriv } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { mixKey } from './table-key.js'

const TABLE_URL = new URL('./asset-table.json', import.meta.url)

// 按文件路径缓存：现在有两份密封文件（主正文、题材分类），
// 用同一个变量缓存会串味——第二次调用会拿到上一个文件的内容。
const cache = new Map()

/**
 * 解开任一密封文件，返回原文；解不开返回 ''，不抛。
 * 结果按 url 缓存，一个进程只解一次。
 * @param {URL} url 形如 new URL('./xxx-table.json', import.meta.url)
 */
export function openBox(url) {
  const key = String(url)
  if (cache.has(key)) return cache.get(key)
  let text = ''
  try {
    const { SLOT, MASK, TAG, IV } = JSON.parse(fs.readFileSync(url, 'utf8'))
    const decipher = createDecipheriv('aes-256-gcm', mixKey(MASK), Buffer.from(IV, 'base64'))
    decipher.setAuthTag(Buffer.from(TAG, 'base64'))
    const raw = Buffer.concat([
      decipher.update(Buffer.from(SLOT, 'base64')),
      decipher.final(),
    ])
    text = inflateSync(raw).toString('utf8')
  } catch {
    text = ''
  }
  cache.set(key, text)
  return text
}

/** 解出包内主正文；失败返回 ''。 */
export function openSlot() {
  return openBox(TABLE_URL)
}