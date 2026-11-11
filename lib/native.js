// dsh-go 原生界面：状态条 + 两个面板 + 输入区按钮。
// 没有 dsh-go 桥接的主机（纯终端、桌面）走不到这里，插件其余部分照常工作。
import { snapshot, panelView, promptView, stripData } from './view.js'
import { toggle, revert, seed, useVariant, mapModel, copyText } from './ops.js'

const T = (locale, zh, en) => (locale === 'en' ? en : zh)

/**
 * @param {any} ctx 已经 inject(['dshGo']) 的 ctx
 * @param {{ home: string, config: any, warn: (message: string) => void }} deps
 */
export function installNative(ctx, deps) {
  const bridge = ctx.dshGo
  if (!bridge || typeof bridge !== 'object') return false
  const { home, config, warn } = deps
  const snap = () => snapshot(home, config)

  /** 让 App 重新拉一次视图/状态条。 */
  const pushes = new Set()
  const bump = () => {
    for (const id of ['purge', 'prompt', 'state']) {
      try {
        bridge.refresh?.(id)
      } catch {
        /* 旧桥接没有 refresh，忽略 */
      }
    }
    // 老桥接不认 refresh('state') 时，直接把状态条再推一次
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
      return { toast: T(args?.[1]?.locale, '操作失败', 'Failed') }
    }
  }

  try {
    if (typeof bridge.strip === 'function') {
      bridge.strip('state', (scope, emit, caps) => {
        const push = () => {
          try {
            emit(stripData(snap(), caps?.locale))
          } catch {
            /* emit 失败不重试 */
          }
        }
        pushes.add(push)
        push()
        return () => pushes.delete(push)
      })
    }
  } catch (error) {
    warn(`状态条注册失败：${error?.message || error}`)
  }

  try {
    if (typeof bridge.panel === 'function') {
      bridge.panel('purge', {
        view: (scope, caps) => panelView(snap(), caps, config),
        actions: {
          toggle: guarded('toggle', (scope, event) => {
            const result = toggle(home)
            bump()
            return { toast: result.enabled ? T(event?.locale, '破甲已开启', 'Purge on') : T(event?.locale, '破甲已关闭', 'Purge off') }
          }),
          reload: guarded('reload', (scope, event) => {
            bump()
            return { toast: T(event?.locale, '已重读正文', 'Reloaded') }
          }),
          seed: guarded('seed', (scope, event) => {
            const result = seed(home)
            bump()
            return { toast: result.written ? T(event?.locale, '默认正文已落盘', 'Seeded') : T(event?.locale, '已有正文，未覆盖', 'Kept existing') }
          }),
          revert: guarded('revert', (scope, event) => {
            const result = revert(home)
            bump()
            return {
              toast: result.backup ? T(event?.locale, '已关闭并备份', 'Off, backed up') : T(event?.locale, '已关闭', 'Off'),
            }
          }),
          use: guarded('use', (scope, event) => {
            const name = event?.value?.name
            useVariant(home, name)
            bump()
            return { toast: T(event?.locale, `已切到 ${name}`, `Now ${name}`) }
          }),
          unmap: guarded('unmap', (scope, event) => {
            const model = event?.value?.model
            mapModel(home, model, '')
            bump()
            return { toast: T(event?.locale, '已取消按模型指定', 'Unmapped') }
          }),
        },
      })

      bridge.panel('prompt', {
        view: (scope, caps) => promptView(snap(), caps),
        actions: {
          copy: guarded('copy', (scope, event) => {
            const current = snap()
            const copied = copyText(current)
            bump()
            return [
              { type: 'copy', text: copied.text },
              {
                type: 'toast',
                text: copied.truncated ? T(event?.locale, '已复制前 8000 字', 'Copied first 8000') : T(event?.locale, '已复制正文', 'Copied'),
              },
            ]
          }),
          toggle: guarded('toggle', (scope, event) => {
            const result = toggle(home)
            bump()
            return { toast: result.enabled ? T(event?.locale, '破甲已开启', 'Purge on') : T(event?.locale, '破甲已关闭', 'Purge off') }
          }),
        },
      })
    }
  } catch (error) {
    warn(`面板注册失败：${error?.message || error}`)
  }

  const on = (id, handler) => {
    try {
      if (typeof bridge.on === 'function') bridge.on(id, guarded(id, handler))
    } catch (error) {
      warn(`按钮 ${id} 注册失败：${error?.message || error}`)
    }
  }

  on('toggle', (scope, event) => {
    const result = toggle(home)
    bump()
    return { toast: result.enabled ? T(event?.locale, '破甲已开启', 'Purge on') : T(event?.locale, '破甲已关闭', 'Purge off') }
  })
  on('reload', (scope, event) => {
    bump()
    return { toast: T(event?.locale, '已重读正文', 'Reloaded') }
  })
  // 加号工具（id 为 body）由清单的 panel 字段直接开面板；这里只是老宿主不认 panel 时的兜底
  on('body', () => ({ open: 'panel:prompt' }))

  return true
}
