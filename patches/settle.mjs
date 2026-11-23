#!/usr/bin/env node
// 更新后的收尾，**必须跑在独立进程里**。
//
// 为什么不在引擎进程里做：这三步（还原 47 个文件 / 重打 60 条补丁 / 每个文件 node --check）
// 手机上一次四十秒起步，而且全是同步的。放进引擎进程就会把事件循环占死——
// 面板刷不动、对话连不上，App 依次弹「没完成」「插件超时」「对话连不上」（实测）。
// 单独起一个进程，卡死也只卡它自己。
//
// 用法：node settle.mjs <home> <engineRoot> <wasOn>
//   home       DSH_HOME（备份、state.json 都在它下面）
//   engineRoot 引擎包根目录（@deepseek-ai 的上一层）
//   wasOn      更新前注入开没开（'1' / '0'）
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const [home, root, wasOnRaw] = process.argv.slice(2)
const wasOn = wasOnRaw === '1'

/** 日志固定落在这里，卡住了能看出卡在哪一步。 */
const LOG_MAX = 64 * 1024

function log(step, detail, extra) {
  if (!home) return
  const logPath = path.join(home, 'dsh-purge', 'settle.log')
  const line = JSON.stringify({ at: new Date().toISOString(), step, detail, ...extra }) + '\n'
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, line)
    const st = fs.statSync(logPath)
    if (st.size > LOG_MAX) {
      const buf = fs.readFileSync(logPath)
      fs.writeFileSync(logPath, buf.subarray(Math.floor(buf.length / 2)))
    }
  } catch {
    /* 写不进日志不能影响干活 */
  }
}

if (!home || !root) {
  console.error('usage: node settle.mjs <home> <engineRoot> [wasOn]')
  process.exit(2)
}

// 从引擎侧的安装位置解析插件自己的模块——不能假定 cwd。
// realpathSync 是为了破掉 profile 里的软链，拿到真实仓库路径。
let mods = null
try {
  const here = path.dirname(new URL(import.meta.url).pathname)
  mods = {
    ops: await import(path.join(here, '..', 'lib', 'ops.js')),
    sync: await import(path.join(here, '..', 'lib', 'sync.js')),
    state: await import(path.join(here, '..', 'lib', 'state.js')),
  }
} catch (error) {
  log('import', 'failed', { error: String(error && error.message) })
  process.exit(1)
}

const { patchRevert, patchApply } = mods.ops
const { syncNative } = mods.sync
const { setEnabled } = mods.state

const problems = []
log('start', 'enter', { home, root, wasOn })

// 1. 先关注入：旧正文配新代码容易打架，重打完再按原状态打回去
try {
  if (wasOn) setEnabled(home, false)
  log('inject-off', 'ok')
} catch (error) {
  problems.push('关注入失败')
  log('inject-off', 'failed', { error: String(error && error.message) })
}

// 2. 还原补丁。失败要留下原因——以前在引擎里被 catch 吞掉，用户只看到「N 条待处理」。
try {
  const rv = patchRevert(home, { root })
  if (rv && rv.ok === false) {
    problems.push('补丁没还原全')
    log('revert', 'incomplete', { reason: String(rv.reason || '').slice(0, 120) })
  } else {
    log('revert', 'ok', { restored: rv && rv.restored })
  }
} catch (error) {
  problems.push('还原补丁失败')
  log('revert', 'failed', { error: String(error && error.message) })
}

// 3. 按新版本的规则重打
try {
  const ap = patchApply(home, { root })
  if (ap && ap.ok === false) {
    problems.push('补丁没打全')
    log('apply', 'incomplete', { applied: ap.applied, errors: (ap.errors || []).length })
  } else {
    log('apply', 'ok', { applied: ap && ap.applied })
  }
} catch (error) {
  problems.push('重打补丁失败')
  log('apply', 'failed', { error: String(error && error.message) })
}

// 4. 同步原生目录——不同步的话插件跑的还是旧代码，面板也是旧样子
try {
  const r = syncNative(root)
  log('sync-native', 'ok', { copied: r && r.copied })
} catch (error) {
  problems.push('原生目录没同步')
  log('sync-native', 'failed', { error: String(error && error.message) })
}

// 5. 按更新前的状态恢复注入
try {
  if (wasOn) setEnabled(home, true)
  log('inject-on', 'ok')
} catch (error) {
  problems.push('恢复注入失败')
  log('inject-on', 'failed', { error: String(error && error.message) })
}

log('done', problems.length ? 'with-problems' : 'clean', { problems })
process.exit(problems.length ? 1 : 0)
