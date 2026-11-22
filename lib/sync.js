// 把仓库里的一份，同步到 dsh-go 的原生界面目录。
//
// 为什么需要这个：原生目录是「复制」而不是软链（理由见 install.sh 第 2 步），
// 所以 git pull 之后必须重新拷一遍，否则插件读到的还是旧代码。
//
// 策略和 install.sh 一致：先建到 .tmp、逐个校验、全通过才整体替换。
// 中途失败就放弃，旧目录一点不动——这个目录残缺会让 App 整个起不来。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ITEMS = [
  'LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md',
  'assets', 'cordis.patch.yml', 'docs', 'install.sh',
  'lib', 'patches', 'package.json',
]

/** 原生目录路径：跟 install.sh 里那一份保持一致。 */
export function nativeDir() {
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-go', 'plugins', 'dsh-go-purge')
}

/**
 * 同步一次。返回 { ok, copied, skipped, error }。
 * 不抛错——调用方是面板按钮，失败只该影响提示，不该炸掉面板。
 */
export function syncNative(repoRoot) {
  const dest = nativeDir()
  const tmp = dest + '.tmp'
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
  } catch (error) {
    return { ok: false, copied: 0, error: '建不了临时目录：' + String(error?.message || error).slice(0, 40) }
  }

  let copied = 0
  const skipped = []
  for (const item of ITEMS) {
    const src = path.join(repoRoot, item)
    const dst = path.join(tmp, item)
    if (!fs.existsSync(src)) { skipped.push(item); continue }
    try {
      fs.cpSync(src, dst, { recursive: true })
      // 校验：拷过去必须能读，否则 App 读到会崩
      if (!fs.existsSync(dst)) { skipped.push(item); continue }
      fs.accessSync(dst, fs.constants.R_OK)
      copied += 1
    } catch {
      skipped.push(item)
    }
  }

  // 有一个没拷成就整批放弃，旧目录原样保留
  if (skipped.length) {
    fs.rmSync(tmp, { recursive: true, force: true })
    return { ok: false, copied, skipped, error: '这些没同步成：' + skipped.join(', ') }
  }

  try {
    const old = dest + '.old'
    fs.rmSync(old, { recursive: true, force: true })
    if (fs.existsSync(dest)) fs.renameSync(dest, old)
    fs.renameSync(tmp, dest)
    fs.rmSync(old, { recursive: true, force: true })
    return { ok: true, copied, skipped: [] }
  } catch (error) {
    // 换失败就尽量还原
    try {
      const old = dest + '.old'
      if (!fs.existsSync(dest) && fs.existsSync(old)) fs.renameSync(old, dest)
    } catch { /* 还原不了也没别的办法 */ }
    fs.rmSync(tmp, { recursive: true, force: true })
    return { ok: false, copied, error: '替换失败：' + String(error?.message || error).slice(0, 40) }
  }
}

/** 当前原生目录是不是软链（老装法留下的）——是的话提示重装一次。 */
export function nativeIsLinked() {
  try {
    const lib = path.join(nativeDir(), 'lib')
    return fs.lstatSync(lib).isSymbolicLink()
  } catch {
    return false
  }
}