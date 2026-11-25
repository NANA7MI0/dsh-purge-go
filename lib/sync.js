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
import { fileURLToPath } from 'node:url'

const ITEMS = [
  'LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md',
  'cordis.patch.yml', 'docs', 'install.sh',
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
  // 传入的可能不是仓库根。更新收尾那条路径（settle-steps）拿到的 ctx.root 是**引擎包根**
  // （@deepseek-ai 的上一层），以前直接把它传进来，11 项全部 skipped、copied:0，
  // 而调用方不看 ok，日志还记「sync-native ok」——于是「点更新 → 代码和补丁都换了 →
  // 胶囊和面板还是旧代码」，用户完全看不到报错。
  //
  // 兜底放在这里而不是只改调用方：syncNative 有两个调用方（更新收尾、install 收尾），
  // 判断「这个目录像不像插件仓库」比让每个调用方都记得传对参数更可靠。
  const looksLikeRepo = (d) => {
    try {
      return fs.existsSync(path.join(d, 'package.json')) && fs.existsSync(path.join(d, 'lib'))
    } catch { return false }
  }
  let src = repoRoot
  if (!looksLikeRepo(src)) {
    const guessed = path.dirname(fileURLToPath(import.meta.url))
    const up = path.dirname(guessed)
    if (looksLikeRepo(up)) src = up
  }
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
    let from = ''
    let dst = ''
    try {
      // 路径计算也放进 try：src 为空串时 path.join 会抛 TypeError，
      // 在外面抛出的话调用方只能看到一句「Cannot read properties」，看不出是哪一项。
      from = path.join(src, item)
      dst = path.join(tmp, item)
    } catch (error) {
      skipped.push(item + '(' + String(error?.message || error).slice(0, 20) + ')')
      continue
    }
    if (!fs.existsSync(from)) { skipped.push(item); continue }
    try {
      // 拷贝源必须是 from（这一项），不是 src（整个仓库）。
      // 写错这一处会把整个仓库复制成每一项：原生目录里 LICENSE 变成目录、
      // package.json 变成目录（App 读它就是 EISDIR）、lib/lib/index.js 层层嵌套，
      // 体积从 1.3 MB 涨到 26 MB。而且 copied 依然返回 10、ok 依然 true，
      // 日志里看不出任何异常。
      fs.cpSync(from, dst, { recursive: true })
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