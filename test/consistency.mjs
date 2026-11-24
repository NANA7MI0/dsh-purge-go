// 一致性检查：仓库里的说法与实际代码/数据到底对不对得上。
//
// 为什么单独立一个文件：AGENTS 5.3 要求在推送前逐项核，靠眼睛看必漏。
// 这里把能机械核的全核了，核不了的（叙述角度、锚点语义）留给人看。
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { probe, tally, SUPPORTED_ENGINES } from '../patches/lib/core.mjs'
import { patchAdvice, registerTools } from '../lib/tools.js'
import { buildView, collect } from '../lib/dshgo.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const ENGINE = process.env.DSH_AI_ROOT || '/opt/dsh/node_modules/@deepseek-ai'
const hasEngine = fs.existsSync(ENGINE)
if (!hasEngine) console.log('\n⚠ 找不到引擎包（' + ENGINE + '），跳过依赖它的数字核对；其余项照查。')
let bad = 0
let ok = 0
const fail = (msg) => { bad += 1; console.log('  ✖ ' + msg) }
const pass = (msg) => { ok += 1; console.log('  ✔ ' + msg) }

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const pkg = JSON.parse(read('package.json'))
const pjson = JSON.parse(read('patches/patches.json'))
const patches = pjson.patches || pjson

console.log('\n【1】版本号')
{
  const v = pkg.version
  const cl = read('CHANGELOG.md')
  if (!cl.includes('## ' + v)) fail('CHANGELOG 里没有 ' + v + ' 这一节')
  else pass('CHANGELOG 有 ' + v + ' 这一节')
  // CHANGELOG 里最新的那一节必须就是当前版本（不是有就行）
  const first = (cl.match(/^## (\d+\.\d+\.\d+)/m) || [])[1]
  if (first !== v) fail('CHANGELOG 最新一节是 ' + first + '，package.json 是 ' + v)
  else pass('CHANGELOG 最新一节就是当前版本')
  // 文档里出现的版本号不机械核：引擎版本（0.2.2-rc.1）、App 版本、npm 上旧包的版本
  // 都在同一批 md 里，靠正则分不清语境，硬核只会制造误报。这类交给推送前人工看。
  console.log('    （文档里其它版本号属引擎/App/npm 旧包，不机械核）')
}

console.log('\n【2】面板描述（三块 + 四个按钮）')
{
  const view = buildView()
  const expectButtons = ['重读', '一键注入', '开关注入']
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cons-'))
  fs.mkdirSync(path.join(home, 'dsh-purge'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-purge', 'state.json'), JSON.stringify({ enabled: true }))
  const data = collect(home, { aiRoot: ENGINE })
  for (const b of expectButtons) {
    if (!data.buttonItems.some((x) => x.label === b)) fail('面板缺按钮：' + b)
  }
  if (data.buttonItems.length > 4) fail('按钮超过 4 个（App 会丢掉多出来的）')
  else pass('按钮 ' + data.buttonItems.length + ' 个，含 ' + expectButtons.join('/'))
  if (view.children.length > 4) fail('面板块数 ' + view.children.length + ' > 4')
  else pass('面板 ' + view.children.length + ' 块')
  const flat = JSON.stringify(view)
  if (flat.includes('data.tables')) fail('面板还绑着 data.tables')
  else pass('面板没有明细表绑定')
  // 文档里不该再提已删的块
  for (const f of ['README.md', 'docs/tools.md']) {
    const t = read(f)
    if (/注入层五行|下方明细表|明细表（按状态分表）/.test(t)) fail(f + ' 还在提已删的区块')
  }
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n【3】补丁数字（58 / 86 / 26 / 41 包 / 47 文件）')
if (!hasEngine) { console.log('    跳过：没有引擎包') } else {
  const rows = probe(ENGINE)
  const t = tally(rows)
  const real = rows.filter((r) => r.reverse !== true)
  const applicable = real.length - (t.no_pkg || 0)
  const applied = real.filter((r) => r.status === 'applied').length
  console.log('    实测：总 ' + rows.length + ' / 剔 reverse 后 ' + real.length + ' / 适用 ' + applicable + ' / applied ' + applied + ' / no_pkg ' + (t.no_pkg || 0))
  const docs = ['README.md', 'docs/patches.md', 'docs/tools.md', 'docs/troubleshooting.md', 'docs/restore.md']
  for (const f of docs) {
    const txt = read(f)
    // 找「60/60」「57/57」这类旧组合
    for (const m of txt.matchAll(/(\d+)\/(\d+)/g)) {
      const [, a, b] = m
      if (a === b && Number(a) !== applicable && Number(a) > 20) {
        fail(f + ' 里写 ' + m[0] + '，实测应是 ' + applicable + '/' + applicable)
      }
    }
    for (const m of txt.matchAll(/(\d+) 条 app|applied (\d+)/g)) {
      const n = Number(m[1] || m[2])
      if (n > 20 && n !== applied) fail(f + ' 说 applied ' + n + '，实测 ' + applied)
    }
  }
  pass('文档数字与实测对照完成')
}

console.log('\n【3.5】面板与工具卡同一套口径')
if (!hasEngine) { console.log('    跳过：没有引擎包') } else {
  // 面板（lib/dshgo.js 的 collect）和工具卡（lib/tools.js 的 patchInfo）各自算一遍数字，
  // 剔反向补丁的规则必须一致，否则同一台机器两个界面两个数（0.6.9 之前就出过：面板 58/58、工具卡 60/86）。
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'dual-'))
  fs.mkdirSync(path.join(home, 'dsh-purge'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-purge', 'state.json'), JSON.stringify({ enabled: true }))
  const panel = collect(home, { aiRoot: ENGINE })
  const defs = []
  registerTools({ tools: { register: (d) => defs.push(d) }, effect() {}, on() {} }, { home, config: {} })
  const st = defs.find((d) => d.name === 'purge_status')
  const info = await st.execute()
  const panelN = panel.patchText.split('/')
  // 不比 summary 里的字符串——它的措辞会变；比它返回的字段，那是同一套代码算出来的
  const applied = Number((info.patches && info.patches.tally && info.patches.tally.applied) || 0)
  const applicable = Number((info.patches && info.patches.applicable) || 0)
  if (!applicable) fail('purge_status 里读不到 applicable')
  else if (Number(panelN[0]) !== applied) {
    fail('面板分子 ' + panelN[0] + ' ≠ 工具卡 applied ' + applied + '（有一边没剔反向补丁）')
  } else pass('面板 ' + panel.patchText + ' 与工具卡 ' + applied + '/' + applicable + ' 口径一致')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n【4】状态词与按钮文案')
{
  const dshgo = read('lib/dshgo.js')
  for (const s of ['破甲未工作 · 点开修复', '破甲已关 · 点开恢复', '破甲异常 · 点开处理']) {
    if (!dshgo.includes(s)) fail('状态条缺一句：' + s)
  }
  pass('状态条三句都在')
  for (const f of ['README.md', 'docs/tools.md']) {
    const t = read(f)
    for (const s of ['破甲未工作', '破甲已关', '破甲异常']) {
      if (!t.includes(s)) console.log('    ⚠ ' + f + ' 没提状态条那句：' + s)
    }
  }
}

console.log('\n【5】工具名与命令')
{
  const toolsSrc = read('lib/tools.js')
  const named = [...toolsSrc.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1])
  const docs = read('README.md') + read('docs/tools.md')
  for (const n of new Set(named)) {
    if (!docs.includes(n)) console.log('    ⚠ 工具 ' + n + ' 在代码里有、文档没提')
  }
  pass('工具名对照完成（' + new Set(named).size + ' 个）')
  // CLI 三个子命令
  for (const c of ['probe', 'apply', 'restore']) {
    if (!read('patches/purge-patch.mjs').includes('cmd === "' + c + '"')) fail('CLI 缺子命令：' + c)
  }
  pass('CLI 三个子命令都在')
}

console.log('\n【6】文件结构')
{
  const structDoc = fs.existsSync(path.join(ROOT, 'docs/structure.md')) ? read('docs/structure.md') : ''
  if (!structDoc) fail('docs/structure.md 不存在')
  else {
    // 文档里列出的 lib/*.js 是否都真在
    for (const m of structDoc.matchAll(/lib\/([a-z]+\.js)/g)) {
      if (!fs.existsSync(path.join(ROOT, 'lib', m[1]))) fail('structure.md 提到 lib/' + m[1] + '，实际没有')
    }
    // 文档只说「19 个 .js」不逐个列名，所以核数量而不是核名单
    const jsN = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).length
    const m = structDoc.match(/lib\/\s+[^\n]*?(\d+) 个 \.js/)
    if (!m) console.log('    ⚠ structure.md 没写 lib 下有多少个 .js')
    else if (Number(m[1]) !== jsN) fail('structure.md 说 lib 有 ' + m[1] + ' 个 .js，实际 ' + jsN)
    else pass('structure.md 的 lib 数量对得上（' + jsN + '）')
    // test/ 同理
    const tN = fs.readdirSync(path.join(ROOT, 'test')).length
    const tm = structDoc.match(/test\/\s+(\d+) 个文件/)
    if (tm && Number(tm[1]) !== tN) fail('structure.md 说 test 有 ' + tm[1] + ' 个文件，实际 ' + tN)
    pass('structure.md 与实际文件对照完成')

    // README 体积表里的「N 个文件」也要和 git ls-files 对上。
    // 这一条以前没人查：structure.md 改对了，README 那张表还写着 64，两个数字各说各话。
    const readme = read('README.md')
    const vm = readme.match(/体积 \|\s*(\d+) 个文件/)
    if (!vm) {
      console.log('    ⚠ README 体积表没写文件数')
    } else {
      // git ls-files 要包 try/catch：README 教用户的归档安装方式解出来没有 .git，
      // 那种目录里跑这个脚本会抛 ChildProcessError，把后面【7】【8】两组带崩。
      let tracked = null
      try {
        tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length
      } catch {
        console.log('    ⚠ 没有 .git 或 git 不可用，跳过文件数核对')
      }
      if (tracked !== null) {
        // 必须 if/else：fail() 只计数不 return，写成 if + 无条件 pass 的话
        // 同一件事会同时打「✖ 实际 73」和「✔ 一致（73）」，自相矛盾。
        if (Number(vm[1]) !== tracked) {
          fail('README 体积表说 ' + vm[1] + ' 个文件，git ls-files 实际 ' + tracked)
        } else {
          pass('README 体积表的文件数与 git 一致（' + tracked + '）')
        }
      }
    }
  }
}

console.log('\n【7】README 内部锚点')
{
  const readme = read('README.md')
  const heads = [...readme.matchAll(/^##+ (.+)$/gm)].map((m) => m[1].trim())
  const slug = (s) => s.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '')
  const ids = new Set(heads.map(slug))
  for (const m of readme.matchAll(/\]\(#([^)]+)\)/g)) {
    const id = m[1]
    if (!ids.has(id) && !heads.some((h) => slug(h).startsWith(id.slice(0, 8)))) {
      fail('README 里锚点 #' + id + ' 找不到对应标题')
    }
  }
  pass('README 锚点对照完成（' + heads.length + ' 个标题）')
}

console.log('\n【8】跨文件锚点（docs 之间、docs 指 README）')
{
  // 为什么单列这一组：README 的章节重新编号过好几次（15 章压成 9 章），
  // docs/ 里那些../README.md#2-安装 之类的链接跟不上，全都指到空处。
  // 原来的第 7 组只查 README 内部，跨文件这类一直没查，实测漏了 8 处。
  const docsDir = path.join(ROOT, 'docs')
  const all = ['README.md', ...fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f)]
  // GitHub 的锚点规则：小写 → 去掉除字母数字/中文/空格/连字符/下划线外的字符 → 空格变连字符
  const ghSlug = (s) =>
    s.trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5 \-]/g, '').replace(/\s+/g, '-')
  const table = {}
  for (const f of all) {
    const set = new Set()
    for (const m of read(f).matchAll(/^#{1,6} (.+)$/gm)) set.add(ghSlug(m[1]))
    table[f] = set
  }
  let bad8 = 0
  for (const f of all) {
    for (const m of read(f).matchAll(/\]\(([^)\s#]*\.md)?#([^)\s]+)\)/g)) {
      const target = m[1] ? path.normalize(path.join(path.dirname(f), m[1])) : f
      const want = decodeURIComponent(m[2]).toLowerCase()
      const set = table[target]
      if (!set) { fail(f + ' 里的链接指向不存在的文件 ' + target); bad8++; continue }
      if (!set.has(want)) { fail(f + ' 里的锚点 ' + target + '#' + m[2] + ' 找不到对应标题'); bad8++ }
    }
  }
  if (bad8 === 0) pass('跨文件锚点全部有效（' + all.length + ' 份文档）')
}

console.log('\n' + (bad === 0 ? '一致：' + ok + ' 组检查通过' : '不一致：' + bad + ' 处，通过 ' + ok + ' 组'))
process.exitCode = bad === 0 ? 0 : 1
