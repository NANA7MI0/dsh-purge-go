#!/usr/bin/env node
// 后台更新：拉取/下载新代码，覆盖仓库，再做收尾（还原补丁、按新版本重打、同步原生目录）。
//
// 为什么整个更新都要挪出引擎进程：
//   实测「点更新 → App 显示正在拉取 → 一会儿弹未完成」。拉取、下载、覆盖、重打补丁
//   加起来少则十几秒、多则半分钟，全在引擎进程里跑，超过界面对按钮的等待上限就弹未完成。
//   这里把它整个丢给独立进程，引擎侧只负责「起进程 + 立刻回话」，绝不会超时。
//
// 用法：node update-worker.mjs <home> <repoDir> <engineRoot>
//   home       DSH_HOME
//   repoDir    插件仓库目录（读版本号、跑 git pull）
//   engineRoot 引擎包目录（@deepseek-ai 的上一层，补丁打在这里）
// 进度写两个文件，面板和人都能看：
//   ~/.dsh/dsh-purge/update-state.json  面板读它显示「正在后台更新…」
//   ~/.dsh/dsh-purge/settle.log         每一步的时间戳，卡住了能看出停在哪
import fs from 'node:fs'
import path from 'node:path'
import { probeGithub } from '../lib/netprobe.js'
import { unpackScript, downloadArchive } from '../lib/unpack-repo.js'
import { execFile } from 'node:child_process'

const [home, repo, rootArg] = process.argv.slice(2)

/**
 * 退出前先把「我失败了」写进状态文件。
 *
 * 以前这里的参数校验直接 process.exit(2)，状态文件还停在启动方写的 'running'——
 * 于是面板的「更新」按钮永远不出现（它只在 !isUpdating 时才显示），
 * 用户会看到按钮一直是「重读」，点多少次都没用，重启 App 也没用。
 */
function bail(reason) {
  try {
    const dir = path.join(home || process.env.DSH_HOME || '', 'dsh-purge')
    if (home) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'update-state.json'),
        JSON.stringify({ status: 'failed', error: reason, at: new Date().toISOString() }),
      )
    }
  } catch { /* 状态写不进也不能拦住退出 */ }
  console.error(reason)
  process.exit(2)
}

if (!home || !repo) {
  bail('用法不对：需要 <home> <repoDir> [engineRoot]' + (home ? '（缺仓库目录，可能不是 git 克隆装的）' : ''))
}

// engineRoot 允许不传：引擎侧 config.aiRoot 常常是空的（实测因此 worker 每次都以
// 「参数不对」退出，界面上看起来就是「说在后台更新，重启还是老版本」）。
// 不传就从引擎自身的包目录推断，跟插件其余部分用的是同一个入口。
let root = rootArg || ''
if (!root) {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname)
    const core = await import(path.join(here, 'lib', 'core.mjs'))
    root = core.detectRoot()
  } catch {
    root = ''
  }
}
if (!root) {
  // 走 bail：它会先把 status:'failed' 写进 update-state.json 再退出。
  // 以前这里只 console.error + exit 2，状态文件还停在启动方写的 'running'，
  // 面板的「更新」按钮要等 10 分钟超时才会回来。
  bail('推断不出引擎目录（第三个参数没给，自动探测也失败）')
}

const REPO = 'NANA7MI0/dsh-purge-go'
const TARBALL = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`
const statePath = path.join(home, 'dsh-purge', 'update-state.json')
const logPath = path.join(home, 'dsh-purge', 'settle.log')
const LOG_MAX = 64 * 1024
const t0 = Date.now()

function log(step, detail, extra) {
  const line = JSON.stringify({ at: new Date().toISOString(), step, detail, ms: Date.now() - t0, ...extra }) + '\n'
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, line)
    const st = fs.statSync(logPath)
    if (st.size > LOG_MAX) {
      const buf = fs.readFileSync(logPath)
      // 按行砍，不按字节砍：日志的契约是「一行一条 JSON」，
      // 从字节中点切开会让首行变成半截，整份日志不再能被逐行解析。
      const lines = buf.toString('utf8').split('\n').filter(Boolean)
      const keep = []
      let bytes = 0
      for (let i = lines.length - 1; i >= 0; i--) {
        bytes += Buffer.byteLength(lines[i], 'utf8') + 1
        if (bytes > buf.length / 2) break
        keep.unshift(lines[i])
      }
      fs.writeFileSync(logPath, keep.length ? keep.join('\n') + '\n' : '')
    }
  } catch {
    /* 日志写不进不影响干活 */
  }
}

/** 面板靠这个文件知道「后台在干什么」。status: running / done / failed。 */
function setState(patch) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    // 解析失败当作「没有旧状态」继续写，不要放弃写。
    // 以前 JSON.parse 抛错会被整个 catch 吞掉，此后每次 setState 都失败——
    // 状态文件里永远是那段坏内容，面板既看不到「正在更新」也看不到失败原因，
    // 而按钮因为读不到状态立刻变回可点，可能起第二个 worker。
    let prev = {}
    try {
      const raw = fs.readFileSync(statePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') prev = parsed
    } catch { prev = {} }
    // 原子写：先写临时文件再 rename。直接 writeFileSync 被中断会留下半截 JSON，
    // 而 readUpdateState 对半截 JSON 返回 null——面板会以为「从来没更新过」。
    const tmp = statePath + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }))
    fs.renameSync(tmp, statePath)
  } catch {
    /* 写不进就算了，日志里还有 */
  }
}

function run(cwd, cmd, args, timeout = 60_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        out: String(stdout || ''),
        err: String(stderr || (error && error.message) || ''),
      })
    })
  })
}

const readVersion = (dir) => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
}

// kind 是给排障用的分类（old_node / download_failed / …），会写进 update-state.json 的 errorKind；
// 界面只显示 reason，但用户来报问题时我们能一眼看出是哪一类。
// 以前这个函数只收一个参数，调用处传的第二参数被默默丢掉，等于分类从来没生效过。
// 归档兜底用的临时目录。放模块级是为了让 fail() 能清掉它——
// 以前它只在 fallback 分支里局部定义，失败或被杀的路径都不会删，
// 每更新失败一次就在 /tmp 留一份 600 KB 的归档 + 解包目录。
let workTmp = ''

const cleanupTmp = () => {
  if (!workTmp) return
  try { fs.rmSync(workTmp, { recursive: true, force: true }) } catch { /* 清不掉不影响结果 */ }
  workTmp = ''
}

const fail = (reason, kind) => {
  log('fail', 'abort', { reason, kind: kind || '' })
  cleanupTmp()
  setState({ status: 'failed', error: String(reason).slice(0, 160), errorKind: kind || '' })
  process.exit(1)
}

const before = readVersion(repo)
setState({ status: 'running', from: before, to: '', error: '' })
log('start', 'enter', { home, repo, root, before })

// 1. 探网：github.com 通才值得试 git pull，否则直接走归档（省十几秒干等）

const netOk = await probeGithub()
log('probe', netOk ? 'ok' : 'unreachable', { code: netOk ? 'ok' : 'fail' })
let via = ''
if (netOk) {
  const pull = await run(repo, 'git', ['pull', '--ff-only'], 25_000)
  log('pull', pull.code === 0 ? 'ok' : 'failed', { code: pull.code, err: String(pull.err || '').slice(0, 120) })
  if (pull.code === 0) via = 'git'
}

if (!via) {
  // 归档覆盖之前必须确认工作区干净——否则会把用户没提交的改动冲掉
  const dirty = await run(repo, 'git', ['status', '--porcelain', '--untracked-files=no'], 15_000)
  if (dirty.out.trim()) fail('仓库有本地改动，先 commit 或 stash')
  const tmp = '/tmp/dshpurge-update-' + Date.now()
  workTmp = tmp
  const tgz = tmp + '/repo.tgz'
  fs.mkdirSync(tmp, { recursive: true })

  // 下载这半段收在 lib/unpack-repo.js 里，和面板更新那条路共用。
  // 以前两边各写一份，超时已经不一致（40 vs 60 秒），node 版本检查也只有一边带分类。
  try {
    const dl = await downloadArchive({ url: TARBALL, dest: tgz })
    log('download', 'ok', { bytes: dl.bytes })
  } catch (error) {
    const msg = String((error && error.message) || error)
    // node 太老归到 old_node：install.sh 认这个分类会提示升级 node，
    // 而不是笼统说「检查网络」——那种提示下用户永远修不好。
    if (/node 太老/.test(msg)) fail(msg + '。当前：' + process.version, 'old_node')
    // 传 errorKind：install.sh 和面板按这个分类给不同建议，
    // 不传的话它们只能看到空字符串，一律回「检查网络」——磁盘满、没权限也这么说。
    const kind = /ENOSPC|EFBIG|no space/i.test(msg) ? 'disk_full'
      : /EACCES|EPERM|EROFS/i.test(msg) ? 'no_permission'
      : 'download_failed'
    fail('下载仓库归档失败（' + msg.slice(0, 60) + '）。检查网络后重试。', kind)
  }

  // 解包+覆盖交给 lib/unpack-repo.js（内部调 patches/lib/replace-repo.sh）：
  // 它先铺新的、再删多余的，中途被打断也不会留下空仓库，.git 与 node_modules 一概不动。
  // 以前这段在 update-worker 和 dshgo.js 各有一份、还分叉过，现在收在一处。
  // 注意传的是 repo（插件仓库），不是引擎目录——
  // 传错会把整个插件仓库铺进 @deepseek-ai/，实测过一次，引擎目录被污染 12 项。
  // 传本地版本当底线：解出来的比它低就中止，不要覆盖成降级
  const script = unpackScript({ tgz, tmp, dest: repo, minVersion: before })
  const fb = await run(repo, 'sh', ['-c', script], 120_000)
  log('fallback', fb.code === 0 ? 'ok' : 'failed', { code: fb.code, err: String(fb.err || '').slice(0, 120) })
  if (fb.code !== 0) fail('下载或覆盖失败：' + String(fb.err || fb.out || '').slice(0, 80))
  via = 'tarball'
  // 成功也要清：解包目录里是整份仓库副本，留着只是占空间
  cleanupTmp()
}

const after = readVersion(repo)
setState({ status: 'running', from: before, to: after, via })
log('downloaded', 'ok', { via, before, after })

// 2. 收尾：关注入 → 还原补丁 → 按新版本重打 → 同步原生目录 → 恢复注入
let mods = null
try {
  const here = path.dirname(new URL(import.meta.url).pathname)
  mods = {
    ops: await import(path.join(here, '..', 'lib', 'ops.js')),
    sync: await import(path.join(here, '..', 'lib', 'sync.js')),
    state: await import(path.join(here, '..', 'lib', 'state.js')),
    prepare: await import(path.join(here, '..', 'lib', 'prepare.js')),
  }
} catch (error) {
  fail('加载插件模块失败：' + String(error && error.message).slice(0, 80))
}

// 只留这行用到的；其余解构（patchRevert/patchApply/syncNative/setEnabled）
// 已经搬进 lib/settle-steps.mjs，留着会变成「看着在用、其实没人调」的死变量。
const { readState } = mods.state

let wasOn = true
try {
  wasOn = readState(home).enabled !== false
} catch {
  wasOn = true
}

// 收尾六步统一走 lib/settle-steps.mjs —— 和 settle.mjs 共用同一份。
// 以前两处各写一遍、只有这里带 topUp，于是「点按钮能补备份、跑 install.sh 不能」，
// 同一台机器两条路结果不同。
// 不能复用上面 try 块里的 here（const 在块内），这里重算一次路径。
// 这个 import 必须包 try：上面 mods 那段（218-221 行）就有 try，
// 而这里没有。它一旦失败（文件缺失、新代码语法错、磁盘读不出来），
// 异常直接抛出 worker，进程没了但状态还停在 running——
// 面板的「更新」按钮要等 10 分钟超时才回来。
let problems = []
try {
  const { runSettleSteps } = await import(
    path.join(path.dirname(new URL(import.meta.url).pathname), 'lib', 'settle-steps.mjs'),
  )
  const res = await runSettleSteps({
    home, root, wasOn,
    ops: mods.ops, sync: mods.sync, state: mods.state,
    prepare: mods.prepare,   // 只有这条路径补备份：它跑在「拉完新代码、还没还原」的时刻
    log,
  })
  problems = Array.isArray(res?.problems) ? res.problems : []
} catch (error) {
  problems = ['收尾没跑起来：' + String(error?.message || error).slice(0, 60)]
  log('settle', 'failed', { error: String(error?.message || error).slice(0, 120) })
}

setState({
  status: problems.length ? 'done-with-problems' : 'done',
  from: before,
  to: after || before,
  via,
  problems,
})
log('done', problems.length ? 'with-problems' : 'clean', { problems, from: before, to: after })
process.exit(problems.length ? 1 : 0)
