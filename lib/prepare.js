// 还原前的准备：把选中那份备份补齐（缺的文件从 npm 拉原始包补回来）。
//
// 为什么单独一个文件、不塞进 ops.js：补丁目标会长大（新版本多打几个文件），
// 但备份是打补丁那一刻建的，只包含当时的目标。老备份还原时「47 个目标只覆盖 41 个」，
// 剩下几个永远带着补丁标记——面板一直显示「N 条待处理」，用户以为更新没成功。
//
// 放独立文件还有个实际原因：ops.js 是被反复改动的热点文件，这个逻辑夹在里面
// 曾经被几次 git 操作覆盖掉，单独成文件后一眼能看出在不在。
import fs from 'node:fs'
import path from 'node:path'
import { topUpBackup } from './topup.js'
import { probe, detectRoot } from '../patches/lib/core.mjs'

/**
 * 备份里缺哪些目标文件。
 * @param {string} dir 备份目录（含 manifest.json 与 files/）
 * @param {string[]} targets 相对引擎 root 的路径列表
 */
export function missingTargets(dir, targets) {
  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch {
    return []
  }
  const have = new Set((manifest?.files || []).map((f) => (typeof f === 'string' ? f : f && f.rel)).filter(Boolean))
  return targets.filter((rel) => !have.has(rel) && !fs.existsSync(path.join(dir, 'files', rel)))
}

/** 当前引擎的全部补丁目标（相对路径）。 */
export function currentTargets(root) {
  const out = []
  try {
    for (const row of probe(root)) {
      for (const f of row.files || []) {
        try { out.push(path.relative(root, f)) } catch { /* 跨盘跳过 */ }
      }
    }
  } catch {
    return []
  }
  return out
}

/** 最新一份备份目录（按目录名倒序）。没有就返回空串。 */
export function latestBackupDir(home) {
  const base = path.join(String(home || ''), 'dsh-purge', 'patch-backup')
  try {
    for (const n of fs.readdirSync(base).sort().reverse()) {
      const d = path.join(base, n)
      try {
        if (fs.statSync(path.join(d, 'files')).isDirectory()) return d
      } catch { /* 不是备份 */ }
    }
  } catch { /* 没有备份目录 */ }
  return ''
}

/**
 * 补齐最新那份备份。补不齐不算错——照旧还原能还原的部分，由调用方把残句话清楚。
 *
 * @returns {Promise<{dir:string, filled:string[], failed:Array}>}
 */
export async function prepareBackup(home, opts = {}) {
  const root = opts.root || detectRoot()
  const targets = currentTargets(root)
  if (!targets.length) return { dir: '', filled: [], failed: [] }

  const dir = opts.dir || latestBackupDir(home)
  if (!dir) return { dir: '', filled: [], failed: [] }

  try {
    const r = await topUpBackup(dir, targets, root)
    return { dir, filled: r.filled, failed: r.failed }
  } catch (error) {
    return { dir, filled: [], failed: [{ rel: '(整体)', why: String(error && error.message).slice(0, 60) }] }
  }
}
