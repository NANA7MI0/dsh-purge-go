// 启动后台更新进程——按钮只调这里，然后立刻回话。
//
// 为什么单独一个文件：update 那段逻辑夹在 dshgo.js 里（那是个八百多行的热点文件），
// 大段替换过三次，每次都被后续的 git 操作搞丢。独立成文件后，改它不用碰 dshgo.js，
// 一眼也能看出在不在。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { appendDiag } from './home.js'

/** 状态文件：面板读它显示「正在后台更新…」。 */
function statePath(home) {
  return path.join(String(home || ''), 'dsh-purge', 'update-state.json')
}

/** 日志：和收尾共用一份，卡住了能看出停在哪一步。 */
function logPath(home) {
  return path.join(String(home || ''), 'dsh-purge', 'settle.log')
}

// 和 dshgo.js / update-worker 一样走 appendDiag：那个函数管 64 KB 上限和按行截断。
// 这里原来自己 append，settle.log 从来没有上限——面板每 30 秒可能触一次 spawn，
// 长期跑下来会涨到几百 KB。
function note(home, detail, extra) {
  appendDiag(home, { step: 'spawn', detail, ...extra }, 'settle.log')
}

/**
 * 起一个后台进程去做整个更新（拉取/下载/覆盖/还原补丁/重打/同步原生目录）。
 *
 * 用 sh 的 nohup + & 而不是 Node 的 detached：proot 下 detached 起得来、活不下来
 * （实测日志里只有 spawn started，子进程一条自己的记录都没写）。
 *
 * @param {string} home DSH_HOME
 * @param {string} repo 插件仓库目录
 * @param {{ label?: string }} [opts]
 * @returns {{ok: boolean, pid?: number, why?: string}}
 */
export function startUpdate(home, repo, opts = {}) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const script = path.join(here, '..', 'patches', 'update-worker.mjs')
    if (!fs.existsSync(script)) {
      note(home, 'script-missing', { script })
      return { ok: false, why: '缺 update-worker.mjs' }
    }

    // 先落状态：面板靠它显示进度，也靠它区分「还在跑」和「早失败了」
    try {
      fs.mkdirSync(path.dirname(statePath(home)), { recursive: true })
      fs.writeFileSync(
        statePath(home),
        JSON.stringify({ status: 'running', from: opts.label || '', to: '', at: new Date().toISOString() }),
      )
    } catch {
      /* 状态文件写不进不影响启动 */
    }

    const cmd =
      'nohup ' + JSON.stringify(process.execPath) +
      ' ' + JSON.stringify(script) +
      ' ' + JSON.stringify(home) +
      ' ' + JSON.stringify(repo) +
      ' >> ' + JSON.stringify(logPath(home)) + ' 2>&1 &'

    const child = spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore', cwd: here })
    child.on('error', (error) => note(home, 'spawn-error', { error: String(error && error.message) }))
    child.unref()
    note(home, 'started', { pid: child.pid, script, via: 'sh-nohup' })
    return { ok: true, pid: child.pid }
  } catch (error) {
    note(home, 'spawn-threw', { error: String(error && error.message) })
    return { ok: false, why: String((error && error.message) || error) }
  }
}

/** 读后台更新状态；没跑过就是 null。 */
export function readUpdateState(home) {
  try {
    const raw = fs.readFileSync(statePath(home), 'utf8')
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

/** 状态是不是「还在跑」。 */
// 状态卡在 running 多久算「已经死了」。
// 为什么必须有：worker 可能被 Android 杀掉、nohup 不存在、参数为空、detectRoot 失败——
// 这些情况下它来不及写 failed 就退出了，状态文件永远停在 running。
// 而面板的「更新」按钮只在 !isUpdating 时出现，于是按钮永远变不回来，重启 App 也没用
// （状态文件是持久的）。
const STALE_MS = 10 * 60 * 1000

export function isUpdating(home) {
  const s = readUpdateState(home)
  if (!s || s.status !== 'running') return false
  // 没有时间戳的老状态：按「刚启动」处理，不能因为缺字段就永远卡住
  const at = Date.parse(String(s.at || ''))
  if (!Number.isFinite(at)) return false
  return Date.now() - at < STALE_MS
}
