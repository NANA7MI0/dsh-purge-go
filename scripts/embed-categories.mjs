#!/usr/bin/env node
// 把 assets/categories.json 打包成 lib/categories-table.json。
// 改完分类跑一次：node scripts/embed-categories.mjs
//
// 为什么这个文件也要封：它的 rule 会拼进注入正文（prompt.js → applyCategories），
// 和 assets/default-prompt.md 一样会被仓库的整库文本扫描看见。
// 主正文封在 lib/asset-table.json 里，这份是后来加的、一直漏着。
//
// 封的是什么：4 条条目，每条含 id / 编号 / 别名表 / 规则正文 / 意图映射目标。
// 组装注入正文时，规则挂到 Scoped Rules 26 号往后，别名进意图映射表。
// 具体是哪四类、规则写了什么，看明文源 assets/categories.json（不进 git），
// 或装好后跑 /purge cat list。
//
// 为什么存 json 不存 js：读 json 用 fs.readFileSync，文件缺失只是 try/catch 里返回空；
// import 一个 js 模块，文件缺失会 ERR_MODULE_NOT_FOUND，把整个插件拖崩。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sealBox } from '../lib/table-key.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = path.join(root, 'assets', 'categories.json')
const dest = path.join(root, 'lib', 'categories-table.json')

if (!fs.existsSync(src)) {
  console.error('找不到源文件：' + src)
  console.error('这份文件不进 git，新克隆的仓库里没有。从旧版目录或备份里取回来再跑。')
  process.exit(1)
}

const text = fs.readFileSync(src, 'utf8')
// 先校验一遍：封进去的东西得是能被读回来的合法 JSON，否则要到运行时才发现
let parsed
try {
  parsed = JSON.parse(text)
} catch (error) {
  console.error('源文件不是合法 JSON，没封：' + String(error && error.message))
  process.exit(1)
}
const n = Array.isArray(parsed?.entries) ? parsed.entries.length : 0
if (!n) {
  console.error('源文件里没有 entries，没封。')
  process.exit(1)
}

const slot = sealBox(text)
fs.writeFileSync(dest, JSON.stringify(slot, null, 2) + '\n')
console.log('已封装 ' + n + ' 条分类 -> ' + path.relative(root, dest))
console.log('体积：' + (fs.statSync(dest).size / 1024).toFixed(1) + ' KB')
