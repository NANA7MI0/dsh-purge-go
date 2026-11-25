// 「下载归档 → 解包 → 覆盖仓库」这一整套，面板更新（dshgo.js）和后台更新进程
// （update-worker.mjs）共用。
//
// 为什么单独一个模块：这两段原来各写一份，已经分叉过两次——
//   · 「解包后把 -C 指向解包目录」一处写对一处漏了，覆盖把整个仓库铺进了引擎目录；
//   · 下载超时一处 40 秒一处 60 秒，node 版本检查也只有一处给出 old_node 分类。
// 现在收在这里，改超时、加重试都只改一个地方。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// replace-repo.sh 在 patches/lib/ 下，本模块在 lib/ 下，所以要上跳一层。
// 少写那个 '..' 会拼成 lib/patches/lib/replace-repo.sh（不存在），
// 结果归档兜底必败、还会被翻译成「连接不上 GitHub」，查起来极费劲。
export const REPLACE_REPO = path.join(HERE, '..', 'patches', 'lib', 'replace-repo.sh')

// 归档约 600 KB，60 秒对慢网也够；定成常量，别在调用处各写一个数。
export const DOWNLOAD_TIMEOUT_MS = 60_000

/**
 * 用 node 内置 fetch 下载仓库归档。
 * 不调 curl：实测有平板（dsh-go 装在平板上）根本没装 curl，连 wget 都没有。
 * 成功返回 { bytes }；失败 throw，message 是可以直接给用户看的一句话。
 */
export async function downloadArchive({ url, dest, timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
  // node 18 以下没有内置 fetch。不先判的话，报出来的是「fetch is not defined」，
  // 用户根本不知道该怎么办。这句话会被调用方拿去匹配，用来归到 old_node 那一类。
  if (typeof fetch !== 'function' || typeof AbortSignal?.timeout !== 'function') {
    throw new Error('当前 node 太老（没有内置 fetch 或 AbortSignal.timeout），升级到 18 以上再试')
  }
  // 必须带超时：fetch 默认不超时，网络半死不活时会永久挂着，
  // 用户看到的是「正在后台更新」永不结束。
  /** 把底层错误翻成人能照着做的说法。分错类会让用户白折腾（曾经磁盘满被说成网络问题）。 */
  const classify = (error) => {
    const code = String(error?.code || '')
    const msg = String(error?.message || error || '')
    if (/ENOSPC|EFBIG|EDQUOT/.test(code) || /no space left|file too large/i.test(msg)) {
      return '磁盘空间不足（' + (code || msg).slice(0, 40) + '），清出空间后重试'
    }
    if (/ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|UND_ERR/.test(code)
      || /timeout|fetch failed|network/i.test(msg)) {
      return '连不上 GitHub（' + (code || msg).slice(0, 40) + '），检查网络或代理后重试'
    }
    if (/EACCES|EPERM|EROFS/.test(code)) {
      return '没有写权限（' + code + '），检查目标目录权限'
    }
    return '下载仓库归档失败（' + (code || msg).slice(0, 60) + '）'
  }
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new Error(classify(error))
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + '（下载仓库归档被拒绝）')
  let buf
  try {
    buf = Buffer.from(await res.arrayBuffer())
  } catch (error) {
    throw new Error(classify(error))
  }
  // 小于 1 KB 基本可以断定不是压缩包（可能是错误页、或者被中间设备拦了）。
  if (buf.length < 1024) throw new Error('下载到的内容只有 ' + buf.length + ' 字节，不像压缩包')
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, buf)
  } catch (error) {
    throw new Error(classify(error))
  }
  return { bytes: buf.length }
}

/**
 * 拼出「解压归档 → 找到顶层目录 → 交给 replace-repo.sh 铺进 dest → 清临时目录」这串命令。
 * @param {{ tgz: string, tmp: string, dest: string }} o
 */
export function unpackScript({ tgz, tmp, dest, minVersion = '' }) {
  // 解包后先看一眼解出来的版本，低于本地就中止。
  //
  // 为什么要这一步：归档更新拉的是 codeload 的 main 分支快照，它可能比本地旧
  // （main 还没合并你本地的提交、或者镜像延迟）。覆盖下去就是降级，
  // 而以前只记了 before/after，问题列表里一个字都不提「版本回退」。
  //
  // 版本号用 node 读：sed 的 \1 在 JS 字符串里会被当成八进制转义，写不出来。
  // 比较用 sort -V，它能正确排 0.7.2 < 0.7.10，朴素的字符串比较不行。
  const guard = minVersion
    ? 'NEWV=$(node -p "require(String(process.argv[1])).version" "$SRC/package.json" 2>/dev/null || echo ""); ' +
      'if [ -n "$NEWV" ]; then ' +
      '  LOW=$(printf "%s\n%s\n" "' + minVersion + '" "$NEWV" | sort -V | head -1); ' +
      '  if [ "$LOW" != "' + minVersion + '" ]; then ' +
      '    echo "新代码版本 $NEWV 低于本地 ' + minVersion + '，覆盖会降级，已中止" >&2; ' +
      '    rm -rf "' + tmp + '" || true; exit 7; ' +
      '  fi; ' +
      'fi; '
    : ''
  return (
    'set -e; ' +
    'tar xzf "' + tgz + '" -C "' + tmp + '"; ' +
    'SRC=$(ls -d "' + tmp + '"/*/ | head -1); ' +
    guard +
    'sh "' + REPLACE_REPO + '" "$SRC" "' + dest + '"; ' +
    // || true：前面任何一步失败时 set -e 会直接退出，这句就不跑了，/tmp 留一份归档；
    // 而且它一旦非 0 还会让整条 sh -c 非 0，导致「其实换成了却报失败」。
    'rm -rf "' + tmp + '" || true'
  )
}
