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
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
import { probe } from '../patches/lib/core.mjs'
import { collect, buildView, installDshGo } from '../lib/dshgo.js'
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
  // 备份里 dsh-base 可能只有 cordis.patch.yml，缺 package.json → engineVersion() 返回 null
  // → findReusableBackup 一律拒绝 → 一堆依赖版本号的分支全走不到。补上，跟真实引擎同形。
  const basePkg = path.join(root, 'dsh-base', 'package.json')
  if (!fs.existsSync(basePkg)) {
    fs.mkdirSync(path.dirname(basePkg), { recursive: true })
    fs.writeFileSync(basePkg, JSON.stringify({ name: 'dsh-base', version: '0.2.2-rc.1' }))
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
  // 分子分母不能写死：补丁表加一条这个数就变。用「等于适用条数」来判，
  // 而不是等于某个具体数字——这条测的是「剔没剔 reverse」，不是「一共几条」。
  {
    const parts = String(s.patchText || '').split('/')
    const num = Number(parts[0])
    const den = Number(parts[1])
    check('分子分母不含反向补丁（#2/#3）',
      Number.isFinite(num) && Number.isFinite(den) && num === den && den > 20,
      s.patchText)
  }
  check('总状态说「正常」', s.summary.includes('正常'), s.summary)
  check('tone 是 good', s.tone === 'good', s.tone)
  check('四个按钮齐全',
    s.buttonItems.length === 4 && ['重读', '一键注入', '开关注入'].every((n) => s.buttonItems.some((b) => b.label === n)),
    s.buttonItems.map((b) => b.label).join('/'))
  check('状态条不出现', s.alert === false && s.alertText === '', s.alertText)
  // 补丁详情引导：只在分子等于分母（面板显示 N/N）时出现。
  // 判据绑在显示的数字上，所以这里也拿数字验——两套条件迟早会打架。
  check('全打上时给补丁详情引导',
    typeof s.patchCaption === 'string'
      && s.patchCaption.includes('已全应用')
      && s.patchCaption.includes('purge_status'),
    JSON.stringify(s.patchCaption))
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
  // 补丁没打全时不能出现「已全应用」——那是整个功能唯一不能错的地方。
  check('补丁异常时不给详情引导', s.patchCaption === '', JSON.stringify(s.patchCaption))
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





console.log('\n场景 12：一键注入——已打满时短路，没打满时必须真打')
{
  // 短路判据写错就会「该打不打」，这是最难发现的一类 bug：面板说正常，实际补丁没生效。
  // 所以两侧都要验：打满时必须跳过（省 4-5 秒），没打满时必须真打 46 个文件。
  const { patchApply } = await import('../lib/ops.js')

  // 已打满：引擎干净 + 有备份 + 先打一遍
  const T1 = fs.mkdtempSync(path.join(os.tmpdir(), 'oc1-'))
  fs.cpSync(ENGINE_SRC, T1, { recursive: true })
  const H1 = tmp('och1-')
  fs.mkdirSync(H1 + '/dsh-purge', { recursive: true })
  const first = patchApply(H1, { root: T1 })
  const t0 = Date.now()
  const again = patchApply(H1, { root: T1 })
  const ms = Date.now() - t0
  console.log('    已打满再点一次：applied=' + again.applied + ' upToDate=' + again.upToDate + ' 耗时=' + ms + 'ms')
  check('已打满时短路（applied=0）', again.applied === 0, String(again.applied))
  check('短路标记为 true', again.upToDate === true, String(again.upToDate))
  check('短路后变快（本机 < 1000ms）', ms < 1000, ms + 'ms')

  // 没打满：干净引擎必须真打
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'oc2-'))
  const rb = realBackup()
  if (rb) {
    for (const f of rb.files) {
      const rel = typeof f === 'string' ? f : f.rel
      const s = path.join(rb.base, rb.bk, 'files', rel)
      const d = path.join(clean, rel)
      fs.mkdirSync(path.dirname(d), { recursive: true })
      if (fs.existsSync(s)) fs.copyFileSync(s, d)
    }
  }
  // 先探一次：这时候引擎还没被打过，applied 必须是 0（否则下面的「真打」测不出东西）
  const r0 = probe(clean)
  const real0 = r0.filter((r) => r.reverse !== true && r.status !== 'no_pkg')
  const applied0 = real0.filter((r) => r.status === 'applied').length
  check('干净引擎上确实一条都没打（否则下面的对照没意义）', applied0 === 0, String(applied0))
  const H2 = tmp('och2-')
  fs.mkdirSync(H2 + '/dsh-purge', { recursive: true })
  const fresh = patchApply(H2, { root: clean })
  console.log('    干净引擎第一次打：applied=' + fresh.applied + ' upToDate=' + fresh.upToDate)
  check('没打满时必须真打', fresh.applied > 0, String(fresh.applied))
  check('没打满时不能标 upToDate', fresh.upToDate !== true, String(fresh.upToDate))

  // 半截引擎（只打了一部分）也必须真打——这条专门防「判据写成 some（只要有一条 applied 就算完）」。
  // 干净引擎上 applied 是 0，some 和 every 结果一样，测不出区别；只有半截状态才分得开。
  // ENGINE_SRC 是干净骨架，得先打满再换回几个文件，才是真正的「半截」状态
  const half = fs.mkdtempSync(path.join(os.tmpdir(), 'oc3-'))
  fs.cpSync(ENGINE_SRC, half, { recursive: true })
  const Hpre = tmp('oc3pre-')
  fs.mkdirSync(Hpre + '/dsh-purge', { recursive: true })
  patchApply(Hpre, { root: half })
  if (rb) {
    let n = 0
    for (const f of rb.files) {
      if (n >= 5) break
      const rel = typeof f === 'string' ? f : f.rel
      const src = path.join(rb.base, rb.bk, 'files', rel)
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(half, rel)); n += 1 }
    }
  }
  const rh = probe(half)
  const realH = rh.filter((r) => r.reverse !== true && r.status !== 'no_pkg')
  const appliedH = realH.filter((r) => r.status === 'applied').length
  console.log('    半截引擎 applied=' + appliedH + '/' + realH.length)
  check('半截引擎上确实有 applied（否则这条测不出 some/every 的区别）', appliedH > 0, String(appliedH))
  check('半截引擎上 applied 不满', appliedH < realH.length, appliedH + '/' + realH.length)
  const H3 = tmp('och3-')
  fs.mkdirSync(H3 + '/dsh-purge', { recursive: true })
  fs.cpSync(Hpre + '/dsh-purge/patch-backup', H3 + '/dsh-purge/patch-backup', { recursive: true })
  const halfRun = patchApply(H3, { root: half })
  console.log('    半截引擎点一键：applied=' + halfRun.applied + ' upToDate=' + halfRun.upToDate)
  check('半截引擎不许短路', halfRun.upToDate !== true, String(halfRun.upToDate))
  // 半截状态下：要么真打、要么明确拒绝，但不许「假装成功」
  const okOrRefused = halfRun.applied > 0 || (halfRun.ok === false && halfRun.errors.length > 0)
  check('半截引擎：真打或明确拒绝，不许假成功', okOrRefused, 'applied=' + halfRun.applied + ' errors=' + halfRun.errors.length)
  if (halfRun.ok === false) {
    const msg = String(halfRun.errors[0].error || '')
    console.log('    半截引擎被拒：' + msg.slice(0, 50))
    check('拒绝时说清了要重装引擎包', /重装引擎包/.test(msg), msg.slice(0, 40))
  }

}

console.log('\n场景 13：目标文件被删掉时，不许短路（否则永远修不回来）')
{
  // 这是最容易漏的一条：probe 原来的 existsSync 那层 continue 让「目标文件被删」成了盲区，
  // 一条补丁只要有别的目标还在，就照样判 applied ——「已全部打上」的短路于是一直说正常，
  // 而手动 restore 本来是能把文件补回来的。
  const { patchApply } = await import('../lib/ops.js')
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'))
  fs.cpSync(ENGINE_SRC, T, { recursive: true })
  const H = tmp('mfh-')
  fs.mkdirSync(H + '/dsh-purge', { recursive: true })
  patchApply(H, { root: T })          // 先打满

  // 挑一个真实存在的目标文件删掉
  const rowsNow = probe(T)
  let victim = null
  for (const r of rowsNow) {
    if (r.reverse === true) continue
    const f = (r.files || [])[0]
    if (f && fs.existsSync(f)) { victim = f; break }
  }
  if (!victim) skip('删目标文件', '没找到可删的目标文件')
  else {
    fs.rmSync(victim)
    console.log('    删掉：' + path.relative(T, victim))
    const after = probe(T)
    // 缺文件有两种表现，取决于它是不是某条补丁的唯一目标：
    //   · 唯一目标 → 那条走 no_file，status 直接变；
    //   · 多目标之一 → status 仍是 applied，但 missingTargets > 0。
    // 两种都必须让 probe 看出来，否则短路会一直说正常。
    const withMissing = after.filter((r) => (r.missingTargets || 0) > 0)
    const wentNoFile = after.filter((r) => r.status === 'no_file' || r.status === 'no_pkg')
    console.log('    probe 发现：缺目标 ' + withMissing.length + ' 条 / 整条 no_file ' + wentNoFile.length + ' 条')
    check('probe 能用某种方式看出目标缺了', withMissing.length > 0 || wentNoFile.length > 0,
      'missingTargets=' + withMissing.length + ' no_file=' + wentNoFile.length)

    const t0 = Date.now()
    const r2 = patchApply(H, { root: T })
    console.log('    再点一键：applied=' + r2.applied + ' upToDate=' + r2.upToDate)
    check('有目标缺失时不许短路', r2.upToDate !== true, String(r2.upToDate))
    check('文件被补回来了', fs.existsSync(victim), '补不回来会一直缺')
  }
}

console.log('\n场景 14：一键注入无论哪条路径都要给一句话，不许静默')
{
  // 用户报「点注入有时跳提示有时不跳」。根因是 deferred 的 result 在 signal.aborted 时
  // 返回了空对象 {}——补丁其实打完了，但用户一个字都看不到。慢的那次更容易被 abort，
  // 所以表现成「时灵时不灵」。这里把四条路径都验一遍：正常、无 signal、已取消、失败。
  const rows = []
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'))
  fs.cpSync(ENGINE_SRC, T, { recursive: true })
  const H = tmp('tth-')
  fs.mkdirSync(H + '/dsh-purge', { recursive: true })
  fs.writeFileSync(H + '/dsh-purge/state.json', JSON.stringify({ enabled: true }))

  let acts = null
  const go = {
    strip: (i, f) => { f('s', () => {}); return () => {} },
    panel: (i, spec) => { spec.view(); spec.data('p', () => {}); acts = spec.actions; return () => {} },
  }
  installDshGo(
    { get: (n) => (n === 'dshGo' ? go : null), effect: (f) => f(), on: () => {}, emit: () => {} },
    { home: H, config: { aiRoot: T }, warn: () => {} },
  )

  const normal = await acts.oneClick().result()
  rows.push(['正常', normal])
  const noSignal = await acts.oneClick().result(undefined)
  rows.push(['无 signal', noSignal])
  const ac = new AbortController()
  ac.abort()
  const aborted = await acts.oneClick().result(ac.signal)
  rows.push(['已取消', aborted])

  for (const [k, v] of rows) {
    console.log('    ' + k + '：' + JSON.stringify(v))
    check(k + ' 要有一句 toast', Boolean(v && typeof v.toast === 'string' && v.toast.length > 0), JSON.stringify(v))
  }

  // 补丁失败也要有 toast
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttb-'))
  fs.mkdirSync(path.join(badRoot, 'dsh-base'), { recursive: true })
  fs.writeFileSync(path.join(badRoot, 'dsh-base', 'package.json'), JSON.stringify({ version: '9.9.9-x' }))
  const H2 = tmp('tth2-')
  fs.mkdirSync(H2 + '/dsh-purge', { recursive: true })
  let acts2 = null
  const go2 = { strip: (i, f) => { f('s', () => {}); return () => {} }, panel: (i, s) => { s.view(); s.data('p', () => {}); acts2 = s.actions; return () => {} } }
  installDshGo(
    { get: (n) => (n === 'dshGo' ? go2 : null), effect: (f) => f(), on: () => {}, emit: () => {} },
    { home: H2, config: { aiRoot: badRoot }, warn: () => {} },
  )
  const failed = await acts2.oneClick().result()
  console.log('    失败：' + JSON.stringify(failed))
  check('失败时也要有一句 toast', Boolean(failed && failed.toast), JSON.stringify(failed))
}

console.log('\n场景 15：更新收尾必须跑在独立进程里（不能阻塞引擎）')
{
  // 实测把「还原+重打」放引擎进程里，会把事件循环占死四十秒：
  // 面板刷不动、对话连不上，App 依次弹「没完成」「插件超时」「对话连不上」。
  // 所以收尾必须是独立进程。这里验两头：脚本本身能跑通，spawn 本身不阻塞。
  const { spawn } = await import('node:child_process')
  const script = path.join(HERE, '..', 'patches', 'settle.mjs')
  check('settle.mjs 存在', fs.existsSync(script), script)
  if (fs.existsSync(script)) {
    // 不带参数运行应该打 usage 并退 2——能跑起来才说明语法和 import 都没问题
    const bad = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20000 })
    check('不带参数时给出 usage', /usage/i.test(String(bad.stdout || bad.stderr || '')), String(bad.status))
    check('不带参数时退出码为 2', bad.status === 2, String(bad.status))

    // 真跑一次：给临时 home（有备份）和真引擎，看它能不能走完全部步骤
    const sh = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'))
    fs.mkdirSync(sh + '/dsh-purge', { recursive: true })
    const rb2 = realBackup()
    if (rb2) {
      fs.mkdirSync(sh + '/dsh-purge/patch-backup', { recursive: true })
      fs.cpSync(path.join(rb2.base, rb2.bk), sh + '/dsh-purge/patch-backup/' + rb2.bk, { recursive: true })
    }
    const t0 = Date.now()
    const child = spawn(process.execPath, [script, sh, path.dirname(ENGINE_SRC), '0'], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.unref()
    const spawnMs = Date.now() - t0
    console.log('    spawn 耗时: ' + spawnMs + 'ms（主进程必须立刻放手）')
    check('spawn 本身不阻塞（< 500ms）', spawnMs < 500, spawnMs + 'ms')

    // 等子进程启动并写出第一条日志，确认它真的在跑。
    // 这里**不**等它跑到 done：完整一轮要六秒以上，测试里等太久没意义；
    // 「子进程能独立跑完」已经在手动验证里确认过（spawn 4ms、全程 6.1 秒、done clean）。
    // 这个场景只管一件事：主进程有没有被拖住。
    await new Promise((r) => setTimeout(r, 3000))
    const lp = sh + '/dsh-purge/settle.log'
    const hasLog = fs.existsSync(lp)
    check('子进程确实起来了（写出了日志）', hasLog, lp)
    if (hasLog) {
      const first = fs.readFileSync(lp, 'utf8').trim().split('\n')[0]
      console.log('    第一条: ' + first.slice(0, 100))
      check('子进程从 start 开始', /"step":"start"/.test(first), first.slice(0, 80))
    }
  }
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
