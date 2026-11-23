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
          // 只要对方回了状态码，就说明这条路是通的（401/404 也算通）
          finish(true)
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
