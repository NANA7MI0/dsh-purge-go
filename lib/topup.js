// 备份补齐：从 npm 重新拉原始包，把备份里缺的文件补回来。
//
// 为什么需要它：补丁目标是会长大的（新版本多打几个文件），但备份是打补丁那一刻建的，
// 只包含当时的目标。于是老备份还原时「47 个目标里只覆盖 41 个」，剩下 6 个永远留着
// 补丁标记——面板一直显示「N 条待处理」，用户以为更新没成功。
//
// 以前的做法是让用户重装引擎包，代价太大（几十兆、要联网、容易把环境搞坏）。
// 这里改成「缺哪个就从 npm 拉原始包补哪个」，只下载用到的那几个包。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

const REGISTRY = 'https://registry.npmmirror.com'

function run(cwd, cmd, args, timeout = 120_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        out: String(stdout || ''),
        err: String(stderr || (error && error.message) || ''),
      })
    })
  })
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/**
 * 备份里缺哪些目标文件。
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
  const have = new Set((manifest?.files || []).map((f) => (typeof f === 'string' ? f : f && f.rel)).filter(Boolean))
  const miss = []
  for (const rel of targets) {
    if (have.has(rel)) continue
    if (!fs.existsSync(path.join(dir, 'files', rel))) miss.push(rel)
  }
  return miss
}

/**
 * 补齐备份缺的文件。
 *
 * 每个文件从它所属包的**同版本**原始包（npm registry）里取，取不到就跳过并记下原因——
 * 补不齐不能假装成功，调用方要按返回值说话。
 *
 * @param {string} dir 备份目录
 * @param {string[]} targets 相对引擎 root 的路径
 * @param {string} engineRoot 引擎包根目录（<root>/node_modules/@deepseek-ai）
 * @returns {Promise<{filled:string[], failed:Array<{rel:string, why:string}>}>}
 */
export async function topUpBackup(dir, targets, engineRoot) {
  const miss = missingTargets(dir, targets)
  if (!miss.length) return { filled: [], failed: [] }

  // rel 形如 "dsh-web-app/presets/standard.patch.yml"，第一段就是包名
  const byPkg = new Map()
  for (const rel of miss) {
    const parts = rel.split('/')
    if (parts.length < 2) continue
    const pkg = parts[0]
    if (!byPkg.has(pkg)) byPkg.set(pkg, [])
    byPkg.get(pkg).push({ rel, rest: parts.slice(1).join('/') })
  }

  const filled = []
  const failed = []
  const work = fs.mkdtempSync(path.join('/tmp', 'purge-topup-'))

  try {
    for (const [pkg, items] of byPkg) {
      let version = ''
      try {
        version = String(JSON.parse(fs.readFileSync(path.join(engineRoot, pkg, 'package.json'), 'utf8')).version || '')
      } catch {
        version = ''
      }
      if (!version) {
        for (const it of items) failed.push({ rel: it.rel, why: '读不到 ' + pkg + ' 的版本号' })
        continue
      }

      const dir2 = path.join(work, pkg)
      fs.mkdirSync(dir2, { recursive: true })
      const pack = await run(dir2, 'npm', ['pack', '@deepseek-ai/' + pkg + '@' + version, '--registry=' + REGISTRY], 120_000)
      if (pack.code !== 0) {
        for (const it of items) failed.push({ rel: it.rel, why: 'npm pack 失败：' + String(pack.err || '').slice(0, 60) })
        continue
      }
      const tgz = String(pack.out).trim().split('\n').filter(Boolean).pop()
      if (!tgz || !fs.existsSync(path.join(dir2, tgz))) {
        for (const it of items) failed.push({ rel: it.rel, why: '找不到下载下来的包' })
        continue
      }

      const out = path.join(dir2, 'x')
      fs.mkdirSync(out, { recursive: true })
      const untar = await run(dir2, 'tar', ['xzf', tgz, '-C', out, '--strip-components=1'], 60_000)
      if (untar.code !== 0) {
        for (const it of items) failed.push({ rel: it.rel, why: '解包失败' })
        continue
      }

      for (const it of items) {
        const src = path.join(out, it.rest)
        if (!fs.existsSync(src)) {
          failed.push({ rel: it.rel, why: '原始包里没有这个文件' })
          continue
        }
        const dst = path.join(dir, 'files', it.rel)
        try {
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          fs.copyFileSync(src, dst)
          filled.push(it.rel)
        } catch (error) {
          failed.push({ rel: it.rel, why: '写进备份失败：' + String(error && error.message).slice(0, 40) })
        }
      }
    }

    // 补完要把 manifest 补上，否则下次还认为「缺」（missingBackupFiles 读的是 manifest）
    if (filled.length) {
      try {
        const mp = path.join(dir, 'manifest.json')
        const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'))
        const have = new Set((manifest.files || []).map((f) => (typeof f === 'string' ? f : f && f.rel)).filter(Boolean))
        for (const rel of filled) {
          if (have.has(rel)) continue
          const p = path.join(dir, 'files', rel)
          manifest.files.push({ rel, size: fs.statSync(p).size, sha256: sha256(p) })
        }
        fs.writeFileSync(mp, JSON.stringify(manifest, null, 2))
      } catch {
        /* manifest 补不上就下一轮再补，不影响这次还原 */
      }
    }
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉就算了 */
    }
  }

  return { filled, failed }
}
