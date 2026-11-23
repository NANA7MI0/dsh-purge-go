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
