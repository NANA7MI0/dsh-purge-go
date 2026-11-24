// 备份里缺哪些目标文件 —— 只此一处实现。
//
// 为什么要单独一个文件：这个判断原本有两份副本（lib/prepare.js 与 lib/topup.js），
// 改了一份没改另一份，就会出现「prepare 算出来缺 3 个、topup 认为一个都不缺、filled 恒为 0」
// 这种自相矛盾。两份逻辑必须完全一致，所以放在一处、两边 import。
import fs from 'node:fs'
import path from 'node:path'

/**
 * 备份里缺哪些目标文件。
 *
 * 两种缺失都算：
 *   ① 目标里有、manifest 里没有 —— 补丁目标长大了（0.7.0 加了 presets/ptc/pipeline.js）
 *   ② manifest 里记了、但 files/ 下真的没有 —— 备份被截断、磁盘损坏、或手工删过
 *
 * 老实现只判 ①，② 会被当成「已覆盖」而永远补不上，最后卡在「备份不完整」让人去重装引擎。
 *
 * @param {string} dir 备份目录（含 manifest.json 与 files/）
 * @param {string[]} targets 相对引擎 root 的路径列表
 * @returns {string[]} 缺的 rel 列表
 */
export function missingTargets(dir, targets) {
  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch {
    return []
  }
  const have = new Set(
    (manifest?.files || [])
      .map((f) => (typeof f === 'string' ? f : f && f.rel))
      .filter(Boolean)
  )
  const miss = []
  for (const rel of targets) {
    if (!have.has(rel) || !fs.existsSync(path.join(dir, 'files', rel))) miss.push(rel)
  }
  return miss
}
