// 探一下 github.com 通不通。
//
// 为什么不用 curl：实测有一台平板（dsh-go 装在平板上）根本没装 curl，
// 连 wget 都没有。那种机器上只要代码里写 curl，探测永远失败——于是每次更新
// 都跳过 git pull、白走一遍下载归档的慢路，看起来像「更新很慢」。
// 引擎本身就跑在 node 上，用 node 的 https 探最保险。
import https from 'node:https'

/**
 * @param {number} [timeoutMs] 超时，默认 4 秒
 * @returns {Promise<boolean>} 能建立连接（2xx/3xx/4xx 都算通，只有连不上才算不通）
 */
export function probeGithub(timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      resolve(ok)
    }
    try {
      const req = https.request(
        { host: 'github.com', port: 443, path: '/', method: 'HEAD', timeout: timeoutMs },
        (res) => {
          res.resume()
          // 只认「真的连到 GitHub」的响应。
          //
          // 以前只要回了状态码就算通——但被运营商劫持、被公司网关拦、被 DNS 污染时
          // 对方也会回一个 200（挂着广告页或拦截提示），于是探测说「通」，
          // 接着白等 25 秒 git pull 超时，最后报的还是「连不上」。
          // 401/404 是 GitHub 自己的响应，算通；200/301/302 也行。5xx 和劫持页不算。
          const code = Number(res.statusCode) || 0
          finish(code > 0 && code < 500)
        },
      )
      req.on('timeout', () => { req.destroy(); finish(false) })
      req.on('error', () => finish(false))
      req.end()
    } catch {
      finish(false)
    }
  })
}
