// 真引擎烟测：用 DSH 引擎自带的 cordis + systemPrompt + tools 真实加载本插件，
// 验证「段注册 → assemble waterfall 重排 → 工具 schema / 渲染 / 工具卡」在真宿主里成立。
//
// 跑法（任选其一）：
//   DSH_ENGINE_DIR=/opt/dshapp/runtime node scripts/engine-smoke.mjs     # Linux / Android PRoot
//   ELECTRON_RUN_AS_NODE=1 "D:/DEEPSEEK/DeepSeek Harness.exe" scripts/engine-smoke.mjs  # Windows 桌面版
//   node scripts/engine-smoke.mjs                                       # 自动探测
//
// 引擎目录解析顺序：$DSH_ENGINE_DIR → 当前 node 可执行文件旁边的引擎（Windows 桌面版
// <安装目录>/resources/app/dsh、AppImage 解包目录）→ `dsh` 在 PATH 上时的安装根 → 常见安装位。
// 探测失败的候选目录会全部打印出来，方便手动指定。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')

const hasCordis = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'))

function dshBinRoot() {
  try {
    const bin = execFileSync('dsh', ['--print-engine-dir'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return bin || ''
  } catch {
    try {
      const real = fs.realpathSync(execFileSync('sh', ['-c', 'command -v dsh'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim())
      // <root>/bin/dsh.js 或 <root>/node_modules/.bin/dsh
      const guess = [path.resolve(path.dirname(real), '..'), path.resolve(path.dirname(real), '../..')]
      return guess.find(hasCordis) || ''
    } catch {
      return ''
    }
  }
}

const candidates = [
  process.env.DSH_ENGINE_DIR,
  path.resolve(path.dirname(process.execPath), 'resources/app/dsh'),
  path.resolve(path.dirname(process.execPath), 'resources/app'),
  dshBinRoot(),
  '/opt/dshapp/runtime',
  '/usr/local/lib/dsh',
  '/usr/lib/dsh',
  '/opt/dsh',
].filter(Boolean)

const engineDir = candidates.find(hasCordis)
if (!engineDir) {
  console.error('✗ 没找到 DSH 引擎目录（需要其中含 node_modules/@deepseek-ai/cordis）。')
  console.error('  已尝试：')
  for (const dir of candidates) console.error(`    - ${dir}`)
  console.error('  用法：DSH_ENGINE_DIR=<引擎根目录> node scripts/engine-smoke.mjs')
  process.exit(2)
}
const modules = path.join(engineDir, 'node_modules')
console.log('引擎目录：', engineDir)

const load = (spec) => import(pathToFileURL(path.join(modules, spec)).href)
const local = (spec) => import(pathToFileURL(path.join(pkgDir, spec)).href)

const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt/lib/index.js')
const toolsApi = await load('@deepseek-ai/dsh-tools/lib/index.js')
const plugin = await local('lib/index.js')
const { setEnabled } = await local('lib/state.js')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-go-engine-'))
const ctx = new Context()

// 真工具注册约束：schema 要过 assertSupportedJsonSchema，output 必须带 render。
const registered = new Map()
ctx.provide('tools', {
  register(definition) {
    if (!definition.output || typeof definition.output.render !== 'function') throw new Error('output 不完整')
    toolsApi.assertSupportedJsonSchema(definition.parameters)
    toolsApi.assertSupportedJsonSchema(definition.output.schema)
    registered.set(definition.name, definition)
  },
})

await ctx.plugin(SystemPrompt)
const prompt = ctx.get('systemPrompt')
if (!prompt) throw new Error('systemPrompt 没起来')

// 补出真宿主里会有的身份段，才能验证「压掉身份段 + 自己排最前」
const before = (await prompt.assemble({ agent: { id: 'smoke' } })).sections.map((section) => section.name)
console.log('宿主自带段：', before.join(' > ') || '(空)')
if (!before.includes('harness:identity')) prompt.section({ name: 'harness:identity', order: -1000, text: 'HARNESS IDENTITY' })
if (!before.includes('agent:instructions')) prompt.section({ name: 'agent:instructions', order: 9000, text: 'AGENT INSTRUCTIONS' })

ctx.plugin(plugin.default ?? plugin, { home, verbose: true })
await new Promise((resolve) => setTimeout(resolve, 50))

const assembly = await prompt.assemble({ agent: { id: 'smoke' } })
const names = assembly.sections.map((section) => section.name)
const head = assembly.sections.find((section) => section.name === 'dsh-purge')
console.log('段顺序：', names.join(' > '))
console.log('首段：', names[0], '| 正文', Buffer.byteLength(head?.text || '', 'utf8'), '字节')
if (names[0] !== 'dsh-purge') throw new Error('注入段没有排到最前')
if (Buffer.byteLength(head?.text || '', 'utf8') < 20000) throw new Error('注入正文偏小')
if (names.includes('harness:identity')) throw new Error('官方身份段没被压掉')
if (!names.includes('agent:instructions')) throw new Error('不该压掉 agent:instructions')
if (!names.includes('dshpg-capabilities')) throw new Error('能力协议段缺失')

console.log('工具：', [...registered.keys()].join(', '))
const status = registered.get('purge_status')
const value = await status.execute({})
const meta = status.output.presentationMeta({}, value)
const view = meta?.['dsh-go/view']
console.log('工具卡：', JSON.stringify(meta).length, '字节，根组件', view?.type, '| 标题', view?.title)
if (!view || view.type !== 'stack') throw new Error('工具卡没有视图')

setEnabled(home, false)
const offNames = (await prompt.assemble({ agent: { id: 'smoke' } })).sections.map((section) => section.name)
console.log('关闭后：', offNames.join(' > '))
if (!offNames.includes('harness:identity')) throw new Error('关闭后应当原样放行（身份段没回来）')
if (!offNames.includes('deployment:persona-prefix')) throw new Error('关闭后 persona 段不该被压')

console.log('\nOK')
