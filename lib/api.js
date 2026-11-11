// dsh-purge-go: 给 Web 面板用的 HTTP 接口
// 挂到宿主 webServer 的 /dsh-purge/ 前缀下
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const JSON_HEAD = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEAD, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** 读 patches.json，返回条数与分类统计。 */
function readPatchTable(pkgRoot) {
  const file = path.join(pkgRoot, 'patches', 'patches.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const list = Array.isArray(raw) ? raw : raw.patches || raw.entries || []
  const byLayer = {}
  for (const p of list) {
    const k = p.layer || p.layer_en || '其他'
    byLayer[k] = (byLayer[k] || 0) + 1
  }
  return { list, byLayer }
}

/** 读上一次 probe 的结果（可能不存在）。 */
function readProbeCache(dir) {
  for (const name of ['patch-probe.json', 'patches/patch-probe.json']) {
    const f = path.join(dir, name)
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'))
    } catch {
      /* 继续找 */
    }
  }
  return null
}

/** 找最近一次 apply 生成的备份目录。 */
function latestBackup(pkgRoot) {
  try {
    const hits = fs
      .readdirSync(pkgRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('backup-'))
      .map((d) => ({ name: d.name, at: fs.statSync(path.join(pkgRoot, d.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    return hits[0] ? hits[0].name : null
  } catch {
    return null
  }
}

export function installApi(ctx, opts = {}) {
  const pkgRoot = opts.pkgRoot
  const home = opts.home

  const status = () => {
    const out = { ok: true, engine: 'dsh-go', version: opts.version || null }
    try {
      const { list, byLayer } = readPatchTable(pkgRoot)
      out.patches = { total: list.length, byLayer }
    } catch (e) {
      out.patches = { total: 0, error: String(e && e.message ? e.message : e) }
    }
    const probe = readProbeCache(pkgRoot)
    if (probe && probe.tally) out.probe = probe.tally
    else if (probe && typeof probe === 'object') out.probe = probe
    out.backup = latestBackup(pkgRoot)
    try {
      const promptFile = path.join(home, 'prompt-inject.md')
      out.prompt = fs.existsSync(promptFile)
        ? { present: true, bytes: fs.statSync(promptFile).size }
        : { present: false }
    } catch {
      out.prompt = { present: false }
    }
    return out
  }

  const applyPatches = async () => {
    const { stdout, stderr } = await run(
      process.execPath,
      [path.join(pkgRoot, 'patches', 'purge-patch.mjs'), 'apply'],
      { cwd: pkgRoot, timeout: 120000, maxBuffer: 8 << 20 },
    )
    return { ok: true, stdout, stderr, status: status() }
  }

  const revertPatches = async () => {
    const bak = latestBackup(pkgRoot)
    if (!bak) return { ok: false, error: '没有可用的备份目录' }
    const { stdout, stderr } = await run(
      process.execPath,
      [path.join(pkgRoot, 'patches', 'purge-patch.mjs'), 'restore', '--backup', path.join(pkgRoot, bak)],
      { cwd: pkgRoot, timeout: 120000, maxBuffer: 8 << 20 },
    )
    return { ok: true, stdout, stderr, status: status() }
  }

  // 面板的 apiUrl() 会以模块所在目录为基准拼接：模块在 /plugins/<pkg>/client.js 时，
  // 请求会变成 /plugins/dsh-purge/status。两个前缀都要认。
  // 面板的 apiUrl() 依据模块 URL 拼基准，实际前缀可能是 /plugins/… 也可能带别的
  // 中间段。这里不猜：任何路径里含 dsh-purge 的都认，取出其后的部分作为子路径。
  const canon = (pathname) => {
    const q = pathname.replace(/\/+$/, '')
    const i = q.indexOf('dsh-purge')
    if (i < 0) return null
    const rest = q.slice(i + 'dsh-purge'.length)
    return rest || '/'
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const sub = canon(url.pathname)
    if (sub === null) return send(res, 404, { ok: false, error: 'unknown endpoint', path: url.pathname })
    try {
      console.error('[dsh-purge-go] api ' + req.method + ' ' + url.pathname + ' -> ' + (sub === '/' ? '/status' : sub))
    } catch {
      /* 日志失败不影响响应 */
    }
    const p = sub === '/' ? '/status' : sub
    try {
      if (req.method === 'GET' && (p === '/dsh-purge' || p === '/dsh-purge/status')) {
        return send(res, 200, status())
      }
      if (req.method === 'POST' && p === '/dsh-purge/apply') {
        return send(res, 200, await applyPatches())
      }
      if (req.method === 'POST' && p === '/dsh-purge/revert') {
        return send(res, 200, await revertPatches())
      }
      // 面板会轮询这些，明确告诉它手机端不提供
      const known = [
        '/dsh-purge/update',
        '/dsh-purge/uninstall',
        '/dsh-purge/restart',
        '/dsh-purge/community',
        '/dsh-purge/rules',
        '/dsh-purge/skills',
        '/dsh-purge/skill',
      ]
      if (known.includes(p)) {
        return send(res, 200, { ok: false, unsupported: true, reason: 'dsh-go 不提供该功能' })
      }
      return send(res, 404, { ok: false, error: 'unknown endpoint', path: p })
    } catch (e) {
      return send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
    }
  }

  // dsh-go 的 route-guard 会给每个命名路由套 Connection 鉴权（Host/Origin 围栏 +
  // 浏览器 cookie）。面板是同源页面，cookie 本来就带；但为了让它和 curl 都能测，
  // 把这条前缀路由登记进宿主的开放名单，并在 handler 里自己做 loopback 校验。
  const guarded = async (req, res) => {
    const host = String(req.headers.host || '')
    const hostname = host.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '')
    const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
    if (!loopback) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Forbidden\n')
      return
    }
    return handler(req, res)
  }

  try {
    const WebServer = ctx.webServer.constructor
    if (WebServer && WebServer.dshGoOpenRoutes instanceof Set) {
      WebServer.dshGoOpenRoutes.add('prefixes /dsh-purge')
      WebServer.dshGoOpenRoutes.add('prefixes /plugins/dsh-purge')
    }
  } catch {
    /* 宿主没有这套 guard 时忽略 */
  }

  // 注意：绝不能注册 prefixes "/"。dsh-go 的 webserver 会用最长前缀匹配，
  // 但根前缀会把页面本身（GET /）也吞掉，导致 App 首页 404、连接失败。
  // 这里只注册确定属于面板的路径。
  ctx.effect(() => {
    const offs = []
    for (const p of ['/dsh-purge', '/plugins/dsh-purge']) {
      offs.push(ctx.webServer.register({ kind: 'prefixes', path: p, handler: guarded }))
    }
    return () => {
      for (const off of offs) off()
    }
  }, 'dsh-purge-go: panel api')
}
