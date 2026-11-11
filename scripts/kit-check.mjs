// 用 dsh-go 官方 plugin-kit 校验本包（清单 / 贡献 / 视图），等价于手敲
//   node <kit>/bin/check.mjs . --load
// kit 位置按顺序找：$DSH_GO_KIT、../_ref/kit、./kit。找不到就打印怎么拿。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')

const candidates = [
  process.env.DSH_GO_KIT,
  path.resolve(pkgDir, '../_ref/kit'),
  path.resolve(pkgDir, '../../_ref/kit'),
  path.resolve(pkgDir, '../../../_purge-go/_ref/kit'),
  path.resolve(pkgDir, 'kit'),
].filter(Boolean)

const entry = candidates.map((dir) => path.join(dir, 'bin/check.mjs')).find((file) => fs.existsSync(file))
if (!entry) {
  console.error('找不到 plugin-kit 的 bin/check.mjs。')
  console.error('从 dsh-go 仓库取 sdk/plugin-kit，放到 ../_ref/kit，或用 DSH_GO_KIT=<dir> 指定。')
  process.exit(2)
}

const result = spawnSync(process.execPath, [entry, pkgDir, '--load', ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
