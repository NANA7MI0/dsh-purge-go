#!/usr/bin/env node
// 把 assets/default-prompt.md 打包成 lib/asset-table.json。
// 改完正文跑一次：node scripts/embed-default-prompt.mjs
//
// 为什么存成 json 而不是 js：读 json 用 fs.readFileSync，文件缺失只是 try/catch 里返回空；
// 而 import 一个 js 模块，文件缺失会直接 ERR_MODULE_NOT_FOUND，把整个插件拖崩。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sealBox } from '../lib/table-key.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = path.join(root, 'assets', 'default-prompt.md')
const dest = path.join(root, 'lib', 'asset-table.json')

if (!fs.existsSync(src)) {
  console.error('找不到源文件：' + src)
  console.error('这份文件不进 git，新克隆的仓库里没有。从旧版目录或备份里取回来再跑。')
  process.exit(1)
}

const text = fs.readFileSync(src, 'utf8')
if (!text.trim()) {
  console.error('源文件是空的，不打包。')
  process.exit(1)
}

const packed = sealBox(text)
// 原子写：中途被杀留下半截 JSON，运行时就解不开（见 lib/table-read.js 的告警），
// 而这种「写了一半」最难查
{
  const tmp = dest + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(packed, null, 2) + String.fromCharCode(10), 'utf8')
  fs.renameSync(tmp, dest)
}
const bytes = fs.statSync(dest).size
process.stdout.write('已打包 ' + path.relative(root, dest) + '：源 ' + text.length + ' 字符 → 产物 ' + bytes + ' 字节' + String.fromCharCode(10))