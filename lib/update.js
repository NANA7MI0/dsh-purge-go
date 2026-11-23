// 仓库更新检测：查 GitHub Release，跟本地 package.json 的版本比。
//
// 三个约束：
//   1. 不阻塞面板——collect() 是同步的，这里只读缓存，过期了才异步去查；
//   2. 查不到就当没有——国内连不上 GitHub 是常态，报错只在日志里，界面上静默；
//   3. 缓存 6 小时——GitHub 匿名 API 每小时 60 次，30 秒一次的推送不能每次都打。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'NANA7MI0/dsh-purge-go'
const CACHE_MS = 6 * 3600 * 1000
// 实测：国内到 GitHub 要 3 秒出头，4 秒会卡在边缘；8 秒留出余量。
const TIMEOUT_MS = 8000
// 读仓库里的 package.json 而不是 GitHub API：
// 匿名 API 每小时只有 60 次，装的人一多必然 403；raw 不走那个配额，也更快。
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/main/package.json`
// raw 不通时的备用：codeload 是 GitHub 的文件分发节点，跟主站不是同一条路。
const TARBALL_URL = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`

let cache = { at: 0, latest: '', error: '' }
let inflight = null

/** 本机版本：从仓库的 package.json 读，软链路径先解析成真实路径。 */
export function localVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const real = fs.realpathSync(here)
    const pkg = path.join(path.dirname(real), 'package.json')
    return String(JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '')
  } catch {
    return ''
  }
}

/** 仓库根：更新要在那里跑 git pull。拿不到就说明这不是 git 克隆装法。 */
export function repoRoot() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const root = path.dirname(fs.realpathSync(here))
    return fs.existsSync(path.join(root, '.git')) ? root : ''
  } catch {
    return ''
  }
}

/** 版本比较：只认 x.y.z 三段，a>b 返回正数。 */
export function compareVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/** 写一行诊断——引擎的 stderr 指向 /dev/null，console 看不到。 */
function diag(payload) {
  try {
    const home = String(process.env.DSH_HOME || '').trim() || path.join(require('node:os').homedir(), '.dsh')
    const dir = path.join(home, 'dsh-purge')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'update-diag.log'), JSON.stringify({ at: new Date().toISOString(), ...payload }) + '\n')
  } catch {}
}

/** 缓存是否新鲜。collect() 用它决定要不要在界面上显示东西。 */
export function peek() {
  return cache
}

/** 是否该去查了（缓存过期或从没查过）。 */
export function stale() {
  return Date.now() - cache.at > CACHE_MS
}

/** 从 codeload 的归档里只取根级 package.json 的 version——raw 不通时的备用路。 */
async function versionFromTarball(signal) {
  const res = await fetch(TARBALL_URL, { headers: { 'User-Agent': 'dsh-go-purge' }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const { gunzipSync } = await import('node:zlib')
  const raw = gunzipSync(buf)
  // 老实按 tar 格式走：每项是 512 字节头 + 内容（补齐到 512 的整数倍）。
  // 一开始图快、直接在解压结果里搜索 "package.json"，结果第一次命中是 README 正文里的
  // 字样（实测 @55397 是 "…、cordis.patch.yml、\n   package.json…"），拿到的 size 全错。
  let off = 0
  while (off + 512 <= raw.length) {
    const header = raw.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeField, 8)
    if (!Number.isFinite(size) || size < 0) break
    if (/^[^/]+\/package\.json$/.test(name)) {
      const text = raw.subarray(off + 512, off + 512 + size).toString('utf8')
      try {
        const v = String(JSON.parse(text)?.version || '').trim()
        if (v) return v
      } catch {
        /* 这一项坏了就继续找 */
      }
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('归档里没找到根级 package.json')
}

/** 异步查一次，返回 Promise。并发调用共用同一个请求。 */
export function check() {
  if (inflight) return inflight
  inflight = (async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    let v = ''
    let via = 'raw'
    try {
      const res = await fetch(RAW_URL, { headers: { 'User-Agent': 'dsh-go-purge' }, signal: ctrl.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      v = String(json?.version || '').trim()
      if (!v) throw new Error('package.json 里没有 version')
    } catch {
      // raw 在很多网络下不通（实测只有 codeload 可达）。检测不能因此废掉——
      // 读不到版本，面板就不会出现「更新」按钮，用户连点的机会都没有。
      via = 'codeload'
      try {
        v = await versionFromTarball(ctrl.signal)
      } catch {
        v = ''
      }
    }
    try {
      if (!v) throw new Error('两条路都拿不到版本')
      cache = { at: Date.now(), latest: v, error: '' }
      diag({ stage: 'check-ok', latest: v, via, local: localVersion() })
    } catch (error) {
      // 连不上就不改 latest，只记错误——上次查到的仍然有效，别因为一次超时把提示清掉
      cache = { ...cache, at: Date.now(), error: String(error?.message || error).slice(0, 40) }
      diag({ stage: 'check-fail', error: cache.error })
    } finally {
      clearTimeout(timer)
      inflight = null
    }
    return cache
  })()
  return inflight
}

/** 界面要显示的一句话。空字符串 = 不显示。 */
export function updateText() {
  const local = localVersion()
  if (!local || !cache.latest) return ''
  const newer = compareVersion(cache.latest, local) > 0
  // 只在有更新时记一行，避免 collect() 每 30 秒刷一条日志
  if (newer) diag({ stage: 'updateText', latest: cache.latest, local })
  return newer ? `有新版本 ${cache.latest}（当前 ${local}）` : ''
}

/** 有没有更新可装。 */
export function hasUpdate() {
  return Boolean(updateText())
}