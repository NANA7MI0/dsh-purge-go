// 解开 lib/asset-table.json 里的正文。解不开就返回空串，调用方自己退回明文文件。
//
// 读 json 而不是 import js 模块：文件缺失 / 格式坏掉只是返回 ''，不会让整个插件加载失败。
import fs from 'node:fs'
import { createDecipheriv } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { mixKey } from './table-key.js'

const TABLE_URL = new URL('./asset-table.json', import.meta.url)

let cache = null

/** 解出包内正文；失败返回 ''，不抛。结果缓存，一次进程只解一次。 */
export function openSlot() {
  if (cache !== null) return cache
  try {
    const { SLOT, MASK, TAG, IV } = JSON.parse(fs.readFileSync(TABLE_URL, 'utf8'))
    const decipher = createDecipheriv('aes-256-gcm', mixKey(MASK), Buffer.from(IV, 'base64'))
    decipher.setAuthTag(Buffer.from(TAG, 'base64'))
    const raw = Buffer.concat([
      decipher.update(Buffer.from(SLOT, 'base64')),
      decipher.final(),
    ])
    cache = inflateSync(raw).toString('utf8')
  } catch {
    cache = ''
  }
  return cache
}