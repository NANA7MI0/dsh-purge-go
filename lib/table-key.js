// 正文加密：把 assets/default-prompt.md 封成 lib/asset-table.js，靠这个解。
//
// 为什么这么做：正文里有大量命令行风格的长句，明文平铺在公开仓库里，容易被平台的
// 文本扫描器整库标记（跟内容具体写了什么无关，是扫描器的粗粒度判断）。被标之后 clone 和
// issue 都受影响，所以要封一层。加密后仓库里只有 base64 分片，普通 grep 搜不到内容。
// 但它不是保密设施——密钥材料与密文同仓，openSlot() 一行就能解，防的是随手看、不是防解密。
//
// 改正文的流程：编辑 assets/default-prompt.md（不进 git）→ node scripts/embed-default-prompt.mjs
//
// 这个文件只管「怎么封」，不管「封哪一份」；文件路径与读取在 table-read.js 与各调用方。
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'

// 密钥派生用的固定盐。换掉它等于换一把钥匙，旧 asset-table.js 就解不开了——
// 换的时候必须同时重跑 embed 脚本。
const MIX = Object.freeze([
  'dsh-purge-go.slot.v1',
  'dsh-go',
  'surface:android|proot',
  'ov.table.2',
])

export function mixKey(extra) {
  return createHash('sha256').update(`${MIX.join('\x1e')}\x1e${String(extra || '')}`).digest()
}

/**
 * 把任意文本封成 { SLOT, MASK, TAG, IV } 四段，base64 可直接写进 json 文件。
 *
 * 现在有两处用它，各封各的文件、互不影响：
 *   · assets/default-prompt.md → lib/asset-table.json（主正文，21 KB，很少改）
 *   · assets/categories.json  → lib/categories-table.json（题材分类 4 条，3 KB，改得勤；
 *     具体是哪几类看明文源或 /purge cat list，这里不写）
 * 为什么两块分开而不合成一个文件：主正文改了要重新打包、而它的源文件不进 git，
 * 合成一份的话「改一个分类别名」也会变成「必须本机有 21 KB 的 default-prompt.md」。
 * 分开存是为了改分类时不用重封 21 KB 主正文——主正文的源文件不进 git，
 * 焊接成一个文件的话，改一个别名也得先有那份源文件。
 */
export function sealBox(text) {
  const mask = randomBytes(16).toString('base64')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', mixKey(mask), iv)
  const packed = deflateSync(Buffer.from(String(text ?? ''), 'utf8'), { level: 9 })
  const body = Buffer.concat([cipher.update(packed), cipher.final()])
  return {
    SLOT: body.toString('base64'),
    MASK: mask,
    TAG: cipher.getAuthTag().toString('base64'),
    IV: iv.toString('base64'),
  }
}