// 真实场景测试：造出用户真会遇到的几种状态，看面板和状态条实际说什么。
//
// 和 test/*.test.js 的区别：单测验「函数返回对不对」，这里验「用户看到的那句话对不对」——
// 文案说反了比功能坏了更坑人（用户会照着那句话做错事）。
//
// 两条硬规矩：
//   1. **绝不碰真实引擎**。所有场景都在 /tmp 的副本上跑。引擎骨架从备份重建；
//      重建不出来就整体退出并报错，不静默跳过——静默跳过会让「全部通过」变成谎话。
//   2. **跳过要说出来**。确实需要本机有备份才能覆盖的场景，打 [跳过] 并计入 skipped，
//      最后一行写清「通过 X · 跳过 Y」，让看输出的人知道覆盖面。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { probe } from '../patches/lib/core.mjs'
import { collect, buildView } from '../lib/dshgo.js'
import { patchApply, patchRevert, findReusableBackup, missingBackupFiles } from '../lib/ops.js'

let pass = 0
let fail = 0
let skipped = 0

function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✔ ' + name) }
  else { fail += 1; console.log('  ✖ ' + name + (detail ? '  → ' + detail : '')) }
}
/** 本次造的所有临时目录，跑完统一删掉。 */
const created = []
/** mkdtemp 的包装：自动记进 created，避免漏删。 */
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(d)
  return d
}
function skip(what, why) {
  skipped += 1
  console.log('  [跳过] ' + what + '：' + why)
}

/** 一个假 home，注入层状态可控，且备份目录独立。 */
function fakeHome(enabled = true) {
  const home = tmp('scn-home-')
  fs.mkdirSync(path.join(home, 'dsh-purge'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-purge', 'state.json'), JSON.stringify({ enabled, variant: null }))
  return home
}

/** 本机真实备份（只读）。没有就返回 null。 */
function realBackup() {
  const base = (process.env.DSH_HOME || process.env.HOME + '/.dsh') + '/dsh-purge/patch-backup'
  try {
    // 从新往旧找第一份「有 manifest 且记了文件」的——install.sh 失败时会留下没有
    // manifest 的空壳目录，只取最新一份就会挑到它，然后读失败、整段测试崩掉。
    const names = fs.readdirSync(base).sort().reverse()
    for (const bk of names) {
      try {
        const m = JSON.parse(fs.readFileSync(base + '/' + bk + '/manifest.json', 'utf8'))
        if (Array.isArray(m.files) && m.files.length) return { base, bk, files: m.files }
      } catch { /* 空壳或坏备份，看下一份 */ }
    }
    return null
  } catch { return null }
}

/**
 * 从备份重建一份「原版引擎」到临时目录。所有场景都用它，绝不读真实引擎。
 * 重建不出来就整体退出——没有它，这些场景测的就不是真实形状的东西了。
 */
function buildEngine() {
  const rb = realBackup()
  if (!rb) return null
  const root = tmp('scn-engine-')
  for (const f of rb.files) {
    const rel = typeof f === 'string' ? f : f.rel
    const src = path.join(rb.base, rb.bk, 'files', rel)
    const dst = path.join(root, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    if (fs.existsSync(src)) fs.copyFileSync(src, dst)
  }
  return root
}

/** 把副本引擎打成「已打补丁」的样子：跑一次真实的 apply。 */
function patchEngine(root) {
  const home = fakeHome(true)
  const r = patchApply(home, { root })
  return r
}

const ENGINE_SRC = buildEngine()
if (!ENGINE_SRC) {
  console.error('\n✖ 造不出引擎副本：本机没有可用的补丁备份（$DSH_HOME/dsh-purge/patch-backup 为空）。')
  console.error('  这些场景必须在真实形状的引擎上跑，没有骨架就没有意义——')
  console.error('  所以这里直接判失败，而不是跳过（跳过会让人以为测过了）。')
  console.error('  先跑一次 sh install.sh 生成备份，再回来跑。')
  process.exitCode = 1
}
else {
console.log('引擎副本：' + ENGINE_SRC)

console.log('\n场景 1：补丁全打上的样子')
{
  const root = tmp('scn-s1-')
  fs.cpSync(ENGINE_SRC, root, { recursive: true })
  const home = fakeHome(true)
  const pa = patchApply(home, { root })
  const s = collect(home, { aiRoot: root })
  console.log('    打了 ' + pa.applied + ' 个文件；面板 ' + s.summary + ' / ' + s.patchText)
  check('补丁是 N/N（全部打上）', /^\d+\/\d+$/.test(s.patchText) && s.patchText.split('/')[0] === s.patchText.split('/')[1], s.patchText)
  check('分子分母不含反向补丁（#2/#3）', s.patchText.startsWith('58/'), s.patchText)
  check('总状态说「正常」', s.summary.includes('正常'), s.summary)
  check('tone 是 good', s.tone === 'good', s.tone)
  check('四个按钮齐全',
    s.buttonItems.length === 4 && ['重读', '一键注入', '开关注入'].every((n) => s.buttonItems.some((b) => b.label === n)),
    s.buttonItems.map((b) => b.label).join('/'))
  check('状态条不出现', s.alert === false && s.alertText === '', s.alertText)
  // 原来断言 s.tables === undefined 是恒真的——collect 压根不产这个键，
  // 等于什么都没验。真正该验的是「面板结构里没有表格节点、也没有 data.tables 绑定」。
  const view = buildView()
  const flat = JSON.stringify(view)
  check('面板结构里没有表格节点', !flat.includes('"table"'), flat.slice(0, 60))
  check('没有任何 data.tables 绑定', !flat.includes('data.tables'))
  check('面板只有三块（总结 / 补丁 / 按钮，加一条可选更新行）',
    view.children.length <= 4, String(view.children.length))
}

console.log('\n场景 2：注入层被关掉')
{
  const root = tmp('scn-s2-')
  fs.cpSync(ENGINE_SRC, root, { recursive: true })
  const home = fakeHome(false)
  patchApply(home, { root })
  const s = collect(home, { aiRoot: root })
  console.log('    状态条：' + s.alertText)
  check('状态条出现', s.alert === true)
  check('说的是「已关」不是「异常」', s.alertText.includes('已关'), s.alertText)
}

console.log('\n场景 3：引擎没打过补丁（刚装好 / App 更新冲掉了）')
{
  const root = tmp('scn-s3-')
  fs.cpSync(ENGINE_SRC, root, { recursive: true })
  const home = fakeHome(true)
  const rows = probe(root)
  const t = rows.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a }, {})
  const s = collect(home, { aiRoot: root })
  console.log('    tally：' + JSON.stringify(t))
  console.log('    面板：' + s.summary + ' / ' + s.patchText)
  console.log('    状态条：' + s.alertText)
  // 反向补丁要从 applied 里剔掉再判：原版引擎上 #2/#3 会因 markers 命中原文案而判 applied，
  // 直接用 t.applied 会得到 2 而不是 0，断言放过了「面板其实还有 2 条空转」这件事。
  const realApplied = rows.filter((r) => r.reverse !== true && r.status === 'applied').length
  check('真实 applied 为 0（原版一条都没打）', realApplied === 0, 'applied=' + realApplied)
  check('状态条出现', s.alert === true)
  check('面板不写 N/N 全绿', s.patchText.split('/')[0] !== s.patchText.split('/')[1] || s.patchText === '未打', s.patchText)
}

console.log('\n场景 4：备份脏了（里面带着补丁标记）')
{
  const home = tmp('scn-s4-')
  const dir = path.join(home, 'dsh-purge', 'patch-backup', 'dirty')
  fs.mkdirSync(path.join(dir, 'files', 'dsh-alpha'), { recursive: true })
  const files = []
  for (let i = 0; i < 25; i++) {
    const rel = 'dsh-alpha/f' + i + '.js'
    files.push({ rel, hash: 'h' })
    fs.writeFileSync(path.join(dir, 'files', rel), 'x // [dsh-purge] dirty')
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    root: '/x', at: '2026-11-20T00:00:00.000Z', engine: { version: '0.2.2-rc.1' }, files,
  }))
  const got = findReusableBackup(home, '0.2.2-rc.1')
  console.log('    脏备份能不能被复用：' + (got ? '能（错了）' : '不能（对）'))
  check('脏备份不被复用', got === null, got ? '被选中了' : '')
}

console.log('\n场景 5：备份缺文件')
{
  const home = tmp('scn-s5-')
  const dir = path.join(home, 'dsh-purge', 'patch-backup', 'miss')
  fs.mkdirSync(path.join(dir, 'files', 'dsh-alpha'), { recursive: true })
  const files = []
  for (let i = 0; i < 25; i++) {
    const rel = 'dsh-alpha/f' + i + '.js'
    files.push({ rel, hash: 'h' })
    if (i < 20) fs.writeFileSync(path.join(dir, 'files', rel), 'ok')
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    root: '/x', at: '2026-11-20T00:00:00.000Z', engine: { version: '0.2.2-rc.1' }, files,
  }))
  const missing = missingBackupFiles(dir)
  console.log('    报缺：' + missing.length + ' 个')
  check('缺 5 个就报 5 个', missing.length === 5, String(missing.length))
}

console.log('\n场景 6：引擎目录扫不到（用户改了路径 / 装错地方）')
{
  const home = fakeHome(true)
  const s = collect(home, { aiRoot: '/tmp/nonexistent-engine-xyz' })
  console.log('    面板：' + s.summary + ' / ' + s.patchText)
  check('大字写「无法判定」而不是 0/0', s.patchText === '无法判定', s.patchText)
  check('总状态说清没找到引擎包', s.summary.includes('没找到引擎包'), s.summary)
}

console.log('\n场景 7：补丁打了一半（模拟 apply 中途崩）')
{
  const root = tmp('scn-s7-')
  fs.cpSync(ENGINE_SRC, root, { recursive: true })
  const home = fakeHome(true)
  patchApply(home, { root })
  // 把前 5 个目标文件换回原版
  const rb = realBackup()
  let n = 0
  for (const f of rb.files) {
    if (n >= 5) break
    const rel = typeof f === 'string' ? f : f.rel
    const src = path.join(rb.base, rb.bk, 'files', rel)
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(root, rel)); n += 1 }
  }
  const rows = probe(root)
  const t = rows.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a }, {})
  const applicable = rows.length - (t.no_pkg || 0)
  const applied = t.applied || 0
  const s = collect(home, { aiRoot: root })
  console.log('    半截 tally：' + JSON.stringify(t) + ' → 面板 ' + s.patchText)
  check('半截状态不该显示为全部生效', applied < applicable, applied + '/' + applicable)
  check('面板大字不是 N/N',
    s.patchText.split('/')[0] !== s.patchText.split('/')[1], s.patchText)
}

console.log('\n场景 8：库里只有脏备份，用户点「还原补丁」')
{
  const root = tmp('scn-s8-')
  fs.cpSync(ENGINE_SRC, root, { recursive: true })
  const home = tmp('scn-s8h-')
  const dir = path.join(home, 'dsh-purge', 'patch-backup', 'only-dirty')
  fs.mkdirSync(path.join(dir, 'files', 'dsh-alpha'), { recursive: true })
  const files = []
  for (let i = 0; i < 25; i++) {
    const rel = 'dsh-alpha/f' + i + '.js'
    files.push({ rel, hash: 'h' })
    fs.writeFileSync(path.join(dir, 'files', rel), 'x // [dsh-purge]')
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    root, at: '2026-11-20T00:00:00.000Z', engine: { version: '0.2.2-rc.1' }, files,
  }))
  // 记下副本引擎里所有文件的内容哈希：只比目录数的话，往已有文件里覆盖写是测不出来的
  // （真实写引擎正是覆盖写），断言会变成永远绿。
  const hashAll = (dir) => {
    const out = {}
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name)
        if (ent.isDirectory()) { walk(p); continue }
        out[path.relative(dir, p)] = fs.readFileSync(p).length + ':' + fs.readFileSync(p).subarray(0, 64).toString('hex')
      }
    }
    walk(dir)
    return out
  }
  const before = JSON.stringify(hashAll(root))
  const r = patchRevert(home, { root })
  const after = JSON.stringify(hashAll(root))
  const msg = String(r.reason || (r.errors[0] && r.errors[0].error) || '')
  console.log('    ok=' + r.ok + '  原因=' + msg.slice(0, 70))
  check('拒绝还原', r.ok === false)
  check('说清了原因', msg.length > 8, msg.slice(0, 30))
  check('拒绝时引擎一个字节都没被改', before === after)
}

console.log('\n场景 9：引擎版本不适配时点「一键注入」')
{
  const root = tmp('scn-s9-')
  fs.mkdirSync(path.join(root, 'dsh-base'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dsh-base', 'package.json'), JSON.stringify({ version: '9.9.9-unknown' }))
  const home = fakeHome(true)
  const r = patchApply(home, { root })
  const msg = String((r.errors[0] && r.errors[0].error) || '')
  console.log('    ok=' + r.ok + '  提示=' + msg.slice(0, 60))
  check('拒绝打补丁', r.ok === false)
  check('提示里有版本号', msg.includes('9.9.9'), msg.slice(0, 40))
  check('提示指向 README 第 6 章（不是不存在的 15 章）',
    msg.includes('第 6 章') && !msg.includes('15 章'), msg.slice(0, 80))
}

console.log('\n场景 10：CLI 在版本不适配时会不会静默 exit')
{
  const root = tmp('scn-s10-')
  fs.mkdirSync(path.join(root, 'dsh-base'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dsh-base', 'package.json'), JSON.stringify({ version: '9.9.9-unknown' }))
  const home = fakeHome(true)
  const out = spawnSync(process.execPath, ['patches/purge-patch.mjs', 'apply', '--root', root, '--backup', path.join(home, 'bk')], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
  const said = String(out.stdout || '') + String(out.stderr || '')
  console.log('    exit=' + out.status + '  输出=' + JSON.stringify(said.trim().slice(0, 60)))
  check('exit 非 0', out.status !== 0, String(out.status))
  check('有话说，不是静默', said.trim().length > 10, JSON.stringify(said.slice(0, 30)))
  check('说到了引擎版本', said.includes('9.9.9'), said.slice(0, 40))
}

console.log('\n场景 11：备份里某个文件丢了（预检就该拦住，不能写一半）')
{
  const rb = realBackup()
  const root = tmp('scn-s11-')
  fs.cpSync(ENGINE_SRC, root, { recursive: true })
  // 用干净的 home：若先 patchApply，里面会有一份好备份，patchRevert 会正确地挑它、
  // 测不到「唯一一份备份缺文件」这个场景。
  const home = fakeHome(true)
  const dir = path.join(home, 'dsh-purge', 'patch-backup', 'broken')
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  const files = []
  // 挑一个真实存在于备份里的文件来「漏掉」——不能硬编码路径，备份里有哪些文件是不确定的
  const victim = (typeof rb.files[0] === 'string' ? rb.files[0] : rb.files[0].rel)
  for (const f of rb.files) {
    const rel = typeof f === 'string' ? f : f.rel
    const src = path.join(rb.base, rb.bk, 'files', rel)
    files.push({ rel, hash: 'h' })
    if (rel !== victim) {   // 故意少放一个
      const dst = path.join(dir, 'files', rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      if (fs.existsSync(src)) fs.copyFileSync(src, dst)
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    root, at: '2026-11-20T00:00:00.000Z', engine: { version: '0.2.2-rc.1' }, files,
  }))
  const r = patchRevert(home, { root })
  const msg = String(r.reason || (r.errors[0] && r.errors[0].error) || '')
  console.log('    ok=' + r.ok + ' restored=' + r.restored)
  console.log('    面板会说：' + msg.slice(0, 100))
  check('拒绝或明确失败', r.ok === false, String(r.ok))
  check('说清了是「缺文件」这类原因，不是裸文件名', /缺|不完整|没还原/.test(msg), msg.slice(0, 40))
}




// 收尾：把本次造的所有临时目录删掉。每条 mkdtemp 都记在 created 里，
// 不删的话跑十几次就攒出几百个 /tmp/scn-*（实测跑半天到 757 个）。
for (const d of created) {
  try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 删不掉不影响结果 */ }
}

console.log('')
const covered = pass + fail
console.log(
  (fail === 0 ? '通过 ' : '有失败：') + pass + ' 项' + (fail ? '，失败 ' + fail + ' 项' : '') +
  (skipped ? '，跳过 ' + skipped + ' 项' : '') +
  '（共 ' + (covered + skipped) + ' 项断言）'
)
process.exitCode = fail === 0 ? 0 : 1
}
