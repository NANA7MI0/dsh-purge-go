// dsh-go 原生界面：状态条 + 两个面板 + 输入区按钮。
// 没有 dsh-go 桥接的主机（纯终端、桌面）走不到这里，插件其余部分照常工作。
import fs from 'node:fs'
import path from 'node:path'
import { snapshot, stripData, patchSnapshot } from './view.js'

const KB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
import { toggle, revert, seed, useVariant, mapModel, copyText, patchApply, patchRevert } from './ops.js'
import { invalidatePatches } from './view.js'

const T = (locale, zh, en) => (locale === 'en' ? en : zh)

/**
 * @param {any} ctx 已经 inject(['dshGo']) 的 ctx
 * @param {{ home: string, config: any, warn: (message: string) => void }} deps
 */
/** 把诊断写进文件——引擎的 stderr 指向 /dev/null，console 输出看不到。 */
/**
 * 把诊断追加进文件——引擎的 stderr 指向 /dev/null，console 输出看不到。
 * 用追加而不是覆盖：之前用 writeFileSync，后面的 stage:'done' 会把前面的
 * bridge-probe 记录整个冲掉，实验做了等于没做。
 */
function diag(home, payload) {
  try {
    const dir = path.join(home, 'dsh-purge')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'native-diag.log')
    const line = JSON.stringify({ at: new Date().toISOString(), ...payload })
    fs.appendFileSync(file, line + '\n')
  } catch {
    /* 写不进就算了，不能因为诊断挂掉插件 */
  }
}

export function installNative(ctx, deps) {
  const { home, config, warn } = deps
  const bridge = ctx && ctx.dshGo
  // 先把「拿到什么」记下来，再去判断——出问题时这行是唯一的线索
  diag(home, {
    stage: 'enter',
    hasCtx: Boolean(ctx),
    hasBridge: Boolean(bridge),
    bridgeType: typeof bridge,
    bridgeKeys: bridge && typeof bridge === 'object' ? Object.keys(bridge) : [],
    strip: bridge ? typeof bridge.strip : 'n/a',
    panel: bridge ? typeof bridge.panel : 'n/a',
    on: bridge ? typeof bridge.on : 'n/a',
    refresh: bridge ? typeof bridge.refresh : 'n/a',
  })
  if (!bridge || typeof bridge !== 'object') {
    diag(home, { stage: 'abort', reason: 'bridge 不存在或不是对象' })
    return false
  }


  const snap = () => snapshot(home, config)

  /**
   * 让 App 重新拉一次状态条。
   * 协议里的 bridge.refresh 只通知 strip（见引擎 dsh-client-bridge core.js），
   * 面板重绘走 action 返回值里的 { refresh: true }——两条通道各管一半，都要用。
   */
  const pushes = new Set()
  const bump = () => {
    try {
      bridge.refresh?.()
    } catch {
      /* 旧桥接没有 refresh，忽略 */
    }
    for (const push of [...pushes]) {
      try {
        push()
      } catch {
        /* 单个订阅坏了不影响其它 */
      }
    }
  }

  const guarded = (label, fn) => (...args) => {
    try {
      return fn(...args)
    } catch (error) {
      warn(`dsh-go ${label}: ${error?.message || error}`)
      return { toast: T(args?.[1]?.locale, '操作失败', 'Failed'), refresh: true }
    }
  }

  // 状态条已移除，只留 composer.actions 的胶囊与 composer.tools 的「正文」。

  const on = (id, handler) => {
    try {
      if (typeof bridge.on === 'function') bridge.on(id, guarded(id, handler))
    } catch (error) {
      warn(`按钮 ${id} 注册失败：${error?.message || error}`)
    }
  }
  diag(home, { stage: 'done', registered: [] })

  return true
}
