// dsh-go 原生界面：输入框上方的胶囊（清单静态声明）+ 一条状态条 + 四个面板 + 一个会话动作。
//
// 分工：
//   · package.json → dshGo.contributes 决定 App 里出现什么（胶囊、状态条、面板、会话动作）；
//   · 这里只处理点按：bridge.on(id) / bridge.strip(id, data) / bridge.panel(id, {view, actions})。
// App 只画清单和 JSON 视图，不执行插件代码；没有 dsh-go 桥接的宿主（纯终端、桌面）
// 走不到这个文件，插件其余部分照常工作（工具、命令、提示词段都不依赖它）。
import fs from 'node:fs'
import path from 'node:path'
import {
  snapshot,
  patchSnapshot,
  invalidatePatches,
  warmPatchCache,
  cachedPatchSummary,
  stripData,
  statusPanelView,
  patchesPanelView,
  promptPanelView,
  categoriesPanelView,
  reportText,
} from './view.js'
import {
  toggle,
  revert,
  seed,
  patchApply,
  patchRevert,
  copyText,
  categoryList,
  categoryToggle,
  categoryBake,
  categoryReset,
} from './ops.js'

const T = (locale, zh, en) => (locale === 'en' ? en : zh)
const clipToast = (text, max = 34) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * 把诊断追加进文件——引擎的 stderr 指向 /dev/null，console 输出看不到。
 * 用追加而不是覆盖：后一个 stage 的记录不会把前一个冲掉。
 */
function diag(home, payload) {
  try {
    const dir = path.join(home, 'dsh-purge')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'native-diag.log')
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...payload }) + '\n')
  } catch {
    /* 写不进就算了，不能因为诊断挂掉插件 */
  }
}

/**
 * @param {any} ctx 已经 inject(['dshGo']) 的 ctx
 * @param {{ home: string, config: any, warn: (message: string) => void }} deps
 */
export function installNative(ctx, deps) {
  const { home, config, warn } = deps
  const bridge = ctx && ctx.dshGo

  diag(home, {
    stage: 'enter',
    hasCtx: Boolean(ctx),
    hasBridge: Boolean(bridge),
    bridgeType: typeof bridge,
    bridgeVersion: bridge?.bridge ?? '',
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
  const patches = () => patchSnapshot()
  const registered = []

  /**
   * 让状态条重新取一次数据。
   * 桥接的 refresh(id) 只通知状态条那一路（面板重绘走 action 返回值里的 refresh 效果），
   * 两条通道各管一半，都要用。refresh 需要 id，传空等于什么都不做。
   */
  const bump = () => {
    try {
      bridge.refresh?.('purge-strip')
    } catch {
      /* 旧桥接没有 refresh，忽略 */
    }
  }

  /** 包一层：任何异常都变成一句人话提示 + 一次重绘，不让点按整体失败。 */
  const guarded = (label, fn) => (scope, event) => {
    try {
      return fn(scope, event)
    } catch (error) {
      warn(`dsh-go ${label}: ${error?.message || error}`)
      bump()
      return { toast: T(event?.locale, '操作失败，见面板', 'Failed'), refresh: true }
    }
  }

  const register = (kind, id, fn) => {
    try {
      if (kind === 'on') bridge.on(id, fn)
      else if (kind === 'strip') bridge.strip(id, fn)
      else bridge.panel(id, fn)
      registered.push(`${kind}:${id}`)
    } catch (error) {
      warn(`dsh-go ${kind} ${id} 注册失败：${error?.message || error}`)
    }
  }

  // ── 状态条 ────────────────────────────────────────────────────────────
  // 数据函数每 20 秒推一次：注入层读盘很便宜，补丁层只读 30 秒缓存（绝不在这里扫盘）。
  register('strip', 'purge-strip', (scope, emit, caps) => {
    const tick = () => {
      try {
        emit(stripData(snap(), cachedPatchSummary(), caps?.locale || ''))
      } catch {
        /* 单次失败不终止数据源，下一拍再试 */
      }
    }
    tick()
    const timer = setInterval(tick, 20_000)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  // ── 胶囊 / 会话动作的点按 ─────────────────────────────────────────────
  register(
    'on',
    'purge-toggle',
    guarded('purge-toggle', (scope, event) => {
      const next = toggle(home)
      bump()
      return {
        toast: next.enabled ? T(event?.locale, '破甲已开启', 'Injection on') : T(event?.locale, '破甲已关闭', 'Injection off'),
        refresh: true,
      }
    }),
  )

  register(
    'on',
    'purge-report',
    guarded('purge-report', (scope, event) => {
      const body = reportText(snap(), patches(), event?.locale)
      return { copy: body, toast: T(event?.locale, '破甲报告已复制', 'Report copied') }
    }),
  )

  // ── 面板一：破甲总览 ──────────────────────────────────────────────────
  register('panel', 'purge-status', {
    view: (scope, caps) => statusPanelView(snap(), patches(), caps),
    actions: {
      toggle: guarded('status/toggle', (scope, event) => {
        const next = toggle(home)
        bump()
        return { toast: next.enabled ? T(event?.locale, '破甲已开启', 'Injection on') : T(event?.locale, '破甲已关闭', 'Injection off'), refresh: true }
      }),
      openPatches: () => ({ open: 'panel:purge-patches' }),
      openPrompt: () => ({ open: 'panel:purge-prompt' }),
      openCats: () => ({ open: 'panel:purge-cats' }),
    },
  })

  // ── 面板二：补丁层（两个破坏性动作都先要确认） ────────────────────────
  register('panel', 'purge-patches', {
    view: (scope, caps) => patchesPanelView(patches(), caps),
    actions: {
      patchApply: guarded('patches/apply', (scope, event) => {
        if (event?.value?.confirmed === false) return { toast: T(event?.locale, '已取消', 'Cancelled'), refresh: true }
        const result = patchApply(home)
        invalidatePatches()
        bump()
        return {
          toast: result.ok
            ? result.applied > 0
              ? T(event?.locale, `已打补丁：${result.applied} 处`, `Applied ${result.applied}`)
              : T(event?.locale, '没有新补丁可打', 'Nothing to apply')
            : clipToast(T(event?.locale, `打补丁失败：${result.reason || '未知原因'}`, `Apply failed: ${result.reason || 'unknown'}`)),
          refresh: true,
        }
      }),
      patchRevert: guarded('patches/revert', (scope, event) => {
        if (event?.value?.confirmed === false) return { toast: T(event?.locale, '已取消', 'Cancelled'), refresh: true }
        const result = patchRevert(home)
        invalidatePatches()
        bump()
        return {
          toast: result.ok
            ? T(event?.locale, `已还原 ${result.restored} 个文件`, `Restored ${result.restored} files`)
            : clipToast(T(event?.locale, `还原失败：${result.reason || '未知原因'}`, `Revert failed: ${result.reason || 'unknown'}`)),
          refresh: true,
        }
      }),
    },
  })

  // ── 面板三：注入正文 ──────────────────────────────────────────────────
  register('panel', 'purge-prompt', {
    view: (scope, caps) => promptPanelView(snap(), caps),
    actions: {
      copy: guarded('prompt/copy', (scope, event) => {
        const copied = copyText(snap())
        return {
          copy: copied.text,
          toast: copied.truncated ? T(event?.locale, '正文过长，已复制前 8000 字', 'Copied first 8000 chars') : T(event?.locale, '正文已复制', 'Prompt copied'),
        }
      }),
      toggle: guarded('prompt/toggle', (scope, event) => {
        const next = toggle(home)
        bump()
        return { toast: next.enabled ? T(event?.locale, '破甲已开启', 'Injection on') : T(event?.locale, '破甲已关闭', 'Injection off'), refresh: true }
      }),
      seed: guarded('prompt/seed', (scope, event) => {
        const result = seed(home, {})
        bump()
        return { toast: result.written ? T(event?.locale, '已落盘默认正文', 'Default prompt written') : T(event?.locale, '沿用现有正文', 'Kept existing prompt'), refresh: true }
      }),
      revert: guarded('prompt/revert', (scope, event) => {
        const result = revert(home)
        bump()
        return {
          toast: result.backup ? T(event?.locale, '已关闭并备份', 'Off, backed up') : T(event?.locale, '已关闭（无正文可备份）', 'Off, nothing to back up'),
          refresh: true,
        }
      }),
    },
  })

  // ── 面板四：题材分类 ──────────────────────────────────────────────────
  register('panel', 'purge-cats', {
    view: (scope, caps) => categoriesPanelView(categoryList(home), caps),
    actions: {
      catToggle: guarded('cats/toggle', (scope, event) => {
        const id = String(event?.value?.id || '')
        const wanted = event?.value?.enabled !== false
        if (!id) return { toast: T(event?.locale, '这一条没有 id', 'No id'), refresh: true }
        categoryToggle(home, id, wanted)
        return { toast: T(event?.locale, `${id} 已${wanted ? '开' : '关'}`, `${id} ${wanted ? 'on' : 'off'}`), refresh: true }
      }),
      catBake: guarded('cats/bake', (scope, event) => {
        const baked = categoryBake(home)
        bump()
        return { toast: T(event?.locale, `已写入 ${baked.categories} 条分类`, `Baked ${baked.categories} categories`), refresh: true }
      }),
      catReset: guarded('cats/reset', (scope, event) => {
        categoryReset(home)
        return { toast: T(event?.locale, '覆盖层已清空', 'Overlay reset'), refresh: true }
      }),
    },
  })

  // 补丁缓存预热：放在加载路径之外，第一次打开面板不必等 probe()。
  try {
    const timer = setTimeout(() => warmPatchCache(), 1500)
    timer.unref?.()
  } catch {
    /* 没有定时器的宿主 */
  }

  diag(home, { stage: 'done', registered })
  return true
}
