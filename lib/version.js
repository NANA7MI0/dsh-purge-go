// 版本号：一处读，两边用。
//
// 为什么要单独立一个文件：index.js 会 import tools.js，tools.js 再回头 import index.js
// 就成了循环依赖。版本信息两边都要，所以抽出来。
//
// 为什么需要区分「运行中」和「磁盘」：
//   面板「更新」只换磁盘代码、不重启引擎进程。正在跑的模块还是旧的，
//   但版本号读的是磁盘 package.json —— 于是界面显示新版本、行为还是旧模块。
//   平板实测过一次：更新到 0.7.5 后、重启前，recover 仍按旧逻辑把「引用」判成拒绝，
//   而界面写着 0.7.5，用户以为已经修好了。
//
// RUNNING_VERSION 在模块被 import 时求值一次，之后不再变 —— 它代表「现在真正在跑的那份代码」。
// diskVersion() 每次现读 —— 它代表「下次重启会加载的那份」。
import fs from 'node:fs'

function readDisk() {
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    return String(JSON.parse(raw).version || '')
  } catch { return '' }
}

/** 本模块被加载时的磁盘版本。加载之后即使磁盘变了，这个值也不动。 */
export const RUNNING_VERSION = readDisk()

/** 磁盘上的当前版本（每次现读，会随更新变化）。 */
export function diskVersion() {
  return readDisk()
}

/**
 * 运行态和磁盘是否一致。false 说明「更新了但没重启」，界面上的版本号不可信。
 */
export function versionMismatch() {
  const disk = diskVersion()
  if (!disk || !RUNNING_VERSION) return false
  return disk !== RUNNING_VERSION
}
