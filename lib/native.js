// dsh-go 原生界面：状态条 + 两个面板 + 输入区按钮。
// 没有 dsh-go 桥接的主机（纯终端、桌面）走不到这里，插件其余部分照常工作。
import fs from 'node:fs'
import path from 'node:path'
import { snapshot, stripData, patchSnapshot } from './view.js'
import { installDshGo, uninstallDshGo } from './dshgo.js'

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
  // 不能写 ctx.dshGo：cordis 会抛 cannot get property "dshGo" without inject。
  // ctx.get(name, false) 是唯一不声明 inject 也能拿服务的口子。
  let bridge = null
  try {
    bridge = typeof ctx?.get === 'function' ? ctx.get('dshGo', false) : null
  } catch {
    bridge = null
  }
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

  // 状态条 + 面板：view 只给静态骨架，数据由 data() 推（30 秒一次）。
  // 旧实现把扫盘塞进 view，App 每次重绘都会跑一遍，把手机拖死过。
  //
  // 这里不用 ctx.inject(['dshGo'], cb) 拿 scoped：那个子 fiber 会在桥接服务换代时
  // 被销毁，连带清掉我们的注册，而它未必会再跑一次回调（手机上实测过：引擎启动后
  // 注册 339 毫秒就被清空，之后再没人补，App 一直报「插件还没处理这一项」）。
  // 改成用插件自己的 ctx 注册，并每秒看一眼 dshGo 换没换实例，换了就重新注册。
  let registered = []

  let lastLive = false

  const rearm = () => {
    let live = false
    try {
      live = typeof registered?.isLive === 'function' ? registered.isLive() : false
    } catch {
      live = false
    }
    // 还活着就别动它——重注册会让 App 取消订阅再重订，状态条会闪一下
    if (live) {
      lastLive = true
      return
    }
    try {
      registered = uninstallDshGo(registered)
    } catch {
      /* 旧注册已经没了 */
    }
    try {
      registered = installDshGo(ctx, { ...deps, diag })
      diag(home, { stage: 'rearm', registered, wasLive: lastLive })
    } catch (error) {
      warn(`dsh-go 原生界面注册失败：${error?.message || error}`)
    }
  }

  rearm()

  // 引擎启动那一小段时间里，桥接服务会被换掉一次，把我们先前的注册一起带走
  // （实测：注册 339 毫秒后被清空，之后再没人补，App 一直报「插件还没处理这一项」）。
  // 没法便宜地判断服务有没有换实例——ctx.dshGo 每次访问都返回新代理——所以启动后
  // 在几个时间点各补一次注册，覆盖那段窗口。之后不再重复，免得反复触发 App 重拉清单。
  for (const delay of [1_000, 3_000, 8_000, 20_000]) {
    const t = setTimeout(rearm, delay)
    if (typeof t.unref === 'function') t.unref()
  }

  diag(home, { stage: 'done', registered })

  return true
}
