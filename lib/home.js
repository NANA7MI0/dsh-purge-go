// 路径与原子落盘。桌面版走 asar / 换包 / PowerShell，这里只认「一个可写的 DSH_HOME」，
// 所以在 Android（PRoot / Termux / App 私有目录）与 Linux/macOS 上走同一套代码。
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

/** DSH_HOME：环境变量优先，否则 ~/.dsh（与引擎自身一致）。 */
export function dshHome() {
  const env = String(process.env.DSH_HOME || '').trim()
  if (env) return path.resolve(env)
  return path.join(os.homedir(), '.dsh')
}

export function purgeDir(home = dshHome()) {
  return path.join(home, 'dsh-purge')
}

export function promptsDir(home = dshHome()) {
  return path.join(purgeDir(home), 'prompts')
}

export function backupsDir(home = dshHome()) {
  return path.join(purgeDir(home), 'backups')
}

export function statePath(home = dshHome()) {
  return path.join(purgeDir(home), 'state.json')
}

/** 注入正文的主文件：与桌面版 dsh-purge 共用同一份，两边装哪个都读它。 */
export function injectPath(home = dshHome()) {
  return path.join(home, 'prompt-inject.md')
}

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** 原子写：先写同目录临时文件再 rename，避免半写坏的正文被组装读到。 */
export function writeAtomic(p, text) {
  ensureDir(path.dirname(p))
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, p)
  return p
}

export function readJson(p, fallback = null) {
  try {
    const value = JSON.parse(fs.readFileSync(p, 'utf8'))
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

export function writeJson(p, value) {
  writeAtomic(p, `${JSON.stringify(value, null, 2)}\n`)
  return p
}

/**
 * 往 dsh-purge/native-diag.log 追加一条诊断。
 *
 * 存在的理由：以前五个地方各写各的（index / native / prompt / table-read / categories），
 * 每处都是「拼 JSON + appendFileSync」，谁都没管住大小。而面板每 30 秒刷新一次、
 * 注入每次请求都走一遍——文件夹坏掉时，日志一天能涨到几百 KB，
 * 把真正有用的那几条冲掉；而且它和别的诊断挤在同一个文件里，读的时候还要自己筛。
 *
 * 统一在这里：一行一条、超过 MAX 就按**行**砍掉前面一半（不能按字节砍，
 * 那会把某一行 JSON 切成两半，整份日志不再是「一行一条」）。
 *
 * @param {string} home DSH_HOME
 * @param {object} record 要记的内容（会自动补 at）
 * @returns {boolean} 写成功与否
 */
export const DIAG_MAX_BYTES = 64 * 1024
export function appendDiag(home, record, name = 'native-diag.log') {
  if (!home) return false
  try {
    const dir = path.join(home, 'dsh-purge')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    // 超限先按行砍：保留后半，前半是更早的记录
    try {
      const size = fs.statSync(file).size
      if (size > DIAG_MAX_BYTES) {
        const old = fs.readFileSync(file, 'utf8')
        const lines = old.split('\n').filter(Boolean)
        // 从后往前保留，直到不超过一半上限
        const keep = []
        let bytes = 0
        for (let i = lines.length - 1; i >= 0; i--) {
          bytes += Buffer.byteLength(lines[i], 'utf8') + 1
          if (bytes > DIAG_MAX_BYTES / 2) break
          keep.unshift(lines[i])
        }
        fs.writeFileSync(file, keep.length ? keep.join('\n') + '\n' : '')
      }
    } catch { /* 文件还不存在或读不到，正常往下写 */ }
    const line = JSON.stringify({ at: new Date().toISOString(), ...record })
    fs.appendFileSync(file, line + '\n')
    return true
  } catch {
    return false
  }
}

/** 备份一份文件到 dsh-purge/backups/，返回备份路径（失败返回空串）。 */
export function backupFile(home, file) {
  const text = readText(file)
  if (!text) return ''
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(backupsDir(home), `${path.basename(file)}.${stamp}.bak`)
  try {
    writeAtomic(target, text)
    return target
  } catch {
    return ''
  }
}

export function fileBytes(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}
