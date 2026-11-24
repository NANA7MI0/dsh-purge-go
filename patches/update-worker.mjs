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
if (!home || !repo) {
  console.error('usage: node update-worker.mjs <home> <repoDir> [engineRoot]')
  process.exit(2)
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
  console.error('update-worker: 推断不出引擎目录，请在第三个参数里给')
  process.exit(2)
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
      fs.writeFileSync(logPath, buf.subarray(Math.floor(buf.length / 2)))
    }
  } catch {
    /* 日志写不进不影响干活 */
  }
}

/** 面板靠这个文件知道「后台在干什么」。status: running / done / failed。 */
function setState(patch) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    const prev = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}
    fs.writeFileSync(statePath, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }))
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
const fail = (reason, kind) => {
  log('fail', 'abort', { reason, kind: kind || '' })
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
    fail('下载仓库归档失败（' + msg.slice(0, 60) + '）。检查网络后重试。')
  }

  // 解包+覆盖交给 lib/unpack-repo.js（内部调 patches/lib/replace-repo.sh）：
  // 它先铺新的、再删多余的，中途被打断也不会留下空仓库，.git 与 node_modules 一概不动。
  // 以前这段在 update-worker 和 dshgo.js 各有一份、还分叉过，现在收在一处。
  // 注意传的是 repo（插件仓库），不是引擎目录——
  // 传错会把整个插件仓库铺进 @deepseek-ai/，实测过一次，引擎目录被污染 12 项。
  const script = unpackScript({ tgz, tmp, dest: repo })
  const fb = await run(repo, 'sh', ['-c', script], 120_000)
  log('fallback', fb.code === 0 ? 'ok' : 'failed', { code: fb.code, err: String(fb.err || '').slice(0, 120) })
  if (fb.code !== 0) fail('下载或覆盖失败：' + String(fb.err || fb.out || '').slice(0, 80))
  via = 'tarball'
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
const { runSettleSteps } = await import(
  path.join(path.dirname(new URL(import.meta.url).pathname), 'lib', 'settle-steps.mjs'),
)
const { problems } = await runSettleSteps({
  home, root, wasOn,
  ops: mods.ops, sync: mods.sync, state: mods.state,
  prepare: mods.prepare,   // 只有这条路径补备份：它跑在「拉完新代码、还没还原」的时刻
  log,
})

setState({
  status: problems.length ? 'done-with-problems' : 'done',
  from: before,
  to: after || before,
  via,
  problems,
})
log('done', problems.length ? 'with-problems' : 'clean', { problems, from: before, to: after })
process.exit(problems.length ? 1 : 0)
