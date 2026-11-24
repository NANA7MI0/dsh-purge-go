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

const [home, rootArg, wasOnRaw] = process.argv.slice(2)
// root 要能被下面的兜底改写，所以先解构成 rootArg 再赋给 let。
let root = rootArg || ''
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

// root 为空不能直接退出：面板那条路传的是 config?.aiRoot || ''，而引擎里 aiRoot 经常是空的
// （实测过）。以前这里 exit 2，子进程又被 stdio:ignore + unref，用户完全看不到——
// 表现就是「更新完了，补丁一条没重打，面板还是旧数字」。
// 现在改成自己探测：detectRoot() 会按已知路径找引擎包。
if (!home) {
  console.error('usage: node settle.mjs <home> [engineRoot] [wasOn]')
  process.exit(2)
}
if (!root) {
  try {
    const { detectRoot } = await import(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'patches', 'lib', 'core.mjs'))
    root = detectRoot()
    log('root', 'detected', { root })
  } catch (error) {
    log('root', 'failed', { error: String(error && error.message) })
    console.error('拿不到引擎目录，也没传进来，收尾没法做：' + String(error && error.message))
    process.exit(2)
  }
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

log('start', 'enter', { home, root, wasOn })

// 六步收尾统一走 lib/settle-steps.mjs —— 和 update-worker 共用同一份，
// 免得「点按钮能打上、跑 install.sh 打不上」这种分叉再次出现。
// settle 这条路径不传 prepare：它本身就是「已经更新完、只做收尾」，
// 补备份在 update-worker 和 purge-patch 里各自做过了。
const { runSettleSteps } = await import(path.join(path.dirname(new URL(import.meta.url).pathname), 'lib', 'settle-steps.mjs'))
const { problems } = await runSettleSteps({
  home, root, wasOn, ops: mods.ops, sync: mods.sync, state: mods.state, log,
})

log('done', problems.length ? 'with-problems' : 'clean', { problems })
process.exit(problems.length ? 1 : 0)
