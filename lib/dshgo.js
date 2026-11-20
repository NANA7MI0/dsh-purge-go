// dsh-go 原生界面：输入框上方的状态条 + 点开的面板。
//
// 和旧实现的关键差别（旧实现把手机卡死过一次，见 native-diag.log 与操作记录）：
//   view 只返回**静态骨架**，值全是数据绑定 { $: 'data.x' }，一次计算都不做；
//   真正的取数在 data() 里，异步算完 emit 出去，30 秒一次。
// App 每次重绘都会调 view，把扫盘塞进 view 里等于每次重绘扫一遍 331 个包。
import fs from 'node:fs'
import path from 'node:path'
import { snapshot, patchSnapshot, invalidatePatches } from './view.js'
import { toggle, patchApply, patchRevert } from './ops.js'
import { readState, setEnabled } from './state.js'
import { DEFAULT_VARIANT } from './prompt.js'
import { patchAdvice } from './tools.js'

const PANEL_ID = 'status'
const ALERT_ID = 'purge-alert'
const REFRESH_MS = 30_000

const KB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`

/**
 * 当前默认模型。
 *
 * 面板上「模型」这一行原本读 snap.last.model，那是「最后一次提示词装配时报上来的模型」，
 * 只有发过消息才有值——刚装好、还没聊天时是空的，显示成「（未指定）」，
 * 看着像破甲没生效。所以发过消息用真值，没发过就从哪个 profile 在用、
 * 它的 cordis.patch.yml 里 agent-default-model 配了什么去读。
 * 用正则扫，不引 yaml 依赖：这一行永远是缩进的 `model: xxx`。
 */
function defaultModel(home) {
  try {
    const base = path.join(home, 'profiles')
    if (!fs.existsSync(base)) return ''
    for (const name of fs.readdirSync(base)) {
      const file = path.join(base, name, 'cordis.patch.yml')
      if (!fs.existsSync(file)) continue
      const text = fs.readFileSync(file, 'utf8')
      // agent-default-model 那一段里的 model:
      const block = text.split(/^- id:/m).find((part) => part.startsWith(' agent-default-model') || part.startsWith('agent-default-model'))
      const m = (block || text).match(/^\s*model:\s*([^\s#]+)/m)
      if (m && m[1]) return m[1]
    }
  } catch {
    /* 读不到就算了 */
  }
  return ''
}

/** 算一份面板要用的数据。慢，只在 data() 里调。 */
function collect(home, config) {
  const snap = snapshot(home, config)
  const p = patchSnapshot(config?.aiRoot)
  const rows = Array.isArray(p?.rows) ? p.rows : []
  // no_file 不能漏：core 在「candidates 命中但文件不存在」时会返回它，
  // 漏掉就会既不在明细里出现、又被 patchAdvice 算进待办，用户永远消不掉那条告警。
  const counts = { applied: 0, partial: 0, miss: 0, noNeedle: 0, noPkg: 0, drifted: 0, hit: 0, noFile: 0 }
  // 「要不要处理」不看状态本身，看 patchAdvice 怎么判——它认得哪些是手机端天然打不上、
  // 不用管的（比如只针对桌面 Web 端的补丁），自己重算会把它们误报成待办。
  let need = 0
  for (const row of rows) {
    const s = row?.status
    if (s === 'applied') counts.applied += 1
    else if (s === 'partial') counts.partial += 1
    else if (s === 'no_needle') counts.noNeedle += 1
    else if (s === 'no_pkg') counts.noPkg += 1
    else if (s === 'drifted') counts.drifted += 1
    else if (s === 'hit') counts.hit += 1
    else if (s === 'miss') counts.miss += 1
    else if (s === 'no_file') counts.noFile += 1
    let advice = ''
    try { advice = patchAdvice(row) } catch { advice = '' }
    if (advice && !advice.includes('不用管')) need += 1
  }
  const applicable = rows.length - counts.noPkg
  // partial 的语义是「多套写法里命中了本机这一套，其余是别的引擎版本和桌面端的备用分支」——
  // 也就是说这条**已经生效了**。算进生效数，否则面板会显示 56/57 这种看着像没打完的数字，
  // 底下还写「1 条手机端用不到」，读起来像有毛病。probe 的原始统计不动，只改展示口径。
  const effective = (counts.applied || 0) + (counts.partial || 0)
  // 颜色要跟着严重程度走：注入层关掉、补丁被整体覆盖 → 红（bad）；
  // 只有个别补丁要处理 → 黄（warn）；一切正常 → 绿（good）。
  // 之前这里没考虑注入层关掉的情况，于是「提示词注入层已关闭」配的是绿色，
  // 看着像没事——那是最该让人看见的状态。
  // （旧的 brokenLayer 判断已合并到下面，跟着 APPLIED_FLOOR 一起用）
  // 手机端该打的补丁全打上了，就是「完全正常」——别让 N/M 的算法（M 里还含
  // 桌面专属的补丁）看着像没打完。注入层关着、或真有待办，再说别的。
  // 光看「有没有待办」不够：App 更新把补丁全部冲掉时，多数补丁会变成 no_needle /
  // miss 且带人工说明，patchAdvice 一律判「不用管」，need 反而是 0——那时不能算正常。
  // 所以再卡一道已生效条数（和 tools.js 里的 PATCH_BROKEN_THRESHOLD 同口径）。
  const APPLIED_FLOOR = 10
  // 判「补丁层被打穿」也要用 effective，不能只看 applied。
  // 不然某版引擎上多数补丁变成 partial 时，会出现「面板写 48/57」和
  // 「顶部红条说补丁被覆盖了」同时存在——同一屏两个结论，用户不知道该信哪个。
  const brokenLayer = rows.length > 0 && effective < APPLIED_FLOOR
  // hit = 「目标文件在，pattern 也匹配，但还没打」。它是「补丁没打上」最直接的信号。
  // 有两种补丁天然会在原版上显示 applied：把破甲文案改回官方说法的反向补丁（#2 #3），
  // 它们的「目标状态」就是原版，所以原版引擎上本来就满足。所以判断「有没有打补丁」
  // 不能只看 applied 的数量，要看还有多少条等着打。
  const reverted = counts.hit > 5
  const tone =
    !snap.enabled || rows.length === 0 || brokenLayer
      ? 'bad'
      : counts.drifted > 0 || need > 0 || reverted
        ? 'warn'
        : 'good'
  const healthy =
    rows.length > 0 &&
    snap.enabled &&
    need === 0 &&
    counts.drifted === 0 &&
    effective >= APPLIED_FLOOR &&
    !reverted

  // 两层同时没工作的时候，别分开说两遍——那时候人也分不清该点哪个按钮，
  // 直接告诉他「破甲没在工作」并指向「一键注入」，一步搞定。
  const injectOff = snap.enabled === false
  const patchOff = reverted || brokenLayer
  let summary
  if (rows.length === 0) {
    summary = '没找到引擎包，补丁层无法判定。点下面「重读」再试一次。'
  } else if (injectOff && patchOff) {
    summary = '破甲未正常工作：提示词注入和补丁都没生效。点下面的「一键注入」一次搞定。'
  } else if (patchOff) {
    summary = reverted
      ? `补丁还没打上（${counts.hit} 条待打）。点下面的「一键注入」，打完重启一次引擎。`
      : '补丁被覆盖了（App 更新会重置引擎）。点下面的「一键注入」，打完重启一次引擎。'
  } else if (injectOff) {
    summary = '提示词注入层已关闭。点下面的「一键注入」或「开关注入」打开。'
  } else if (healthy) {
    summary = '破甲能力完全正常。'
  } else {
    summary = `有 ${need} 条补丁需要处理，见下面的明细。`
  }

  // 每组一张表：状态 → 该状态的补丁名。手机上不要 86 行全铺。
  const groups = [
    ['hit', '可以再打'],
    ['drifted', '被升级冲掉'],
    ['miss', '打不上'],
    ['no_file', '目标文件缺失'],
    ['partial', '部分生效'],
    ['no_needle', '无目标句'],
    ['applied', '已生效'],
    ['no_pkg', '桌面专属'],
  ]
  const tables = []
  for (const [key, label] of groups) {
    const list = rows.filter((row) => row?.status === key)
    if (list.length === 0) continue
    tables.push({
      type: 'table',
      // 表头第一列原来写的是状态名（「已生效」「可以再打」），单元格里却是补丁 id。
      // 每张表本来就只装一个状态，状态名该当标题，不该当列名。
      columns: ['#', '补丁', '说明'],
      rows: list.slice(0, 20).map((row) => {
        let advice = ''
        try { advice = patchAdvice(row) } catch { advice = '' }
        return [
          String(row?.id ?? ''),
          String(row?.name || ''),
          String(advice || '').slice(0, 32),
        ]
      }),
    })
    if (list.length > 20) {
      tables.push({ type: 'text', text: `…另有 ${list.length - 20} 条未列出`, tone: 'muted' })
    }
  }

  return {
    summary,
    tone: healthy ? 'good' : tone,
    enabled: snap.enabled ? '开' : '关',
    bytes: KB(snap.bytes || 0),
    // snap.variant 至少是 'default'，用 || 永远不触发；想显示中文得跟默认值比
    variant: !snap.variant || snap.variant === DEFAULT_VARIANT ? '默认' : snap.variant,
    // 发过消息就用装配时报上来的真值，没发过就读 profile 里配的默认模型
    model: snap.last?.model || defaultModel(home) || '跟随引擎默认',
    // 未打补丁时别显示「2/57」——那 2 条是把文案改回官方说法的反向补丁，
    // 原版天然满足，写出来只会让人以为「打了但没打全」。
    patchText: reverted ? '未打' : `${effective}/${applicable}`,
    // 55/57 里的「57」是手机适用的条数，不是全部 86 条；剩下那 2 条手机端本来就用不到。
    // 把这点写清楚，否则看着像「没打完」。
    patchCaption: (() => {
      // 扫不到引擎包时不能说「已全部生效」——那时 applicable 也是 0，会被算成「0 条全生效」，
      // 和上面「补丁层无法判定」自相矛盾。
      if (rows.length === 0 || applicable === 0) return '没有扫描到引擎包'
      // 未打补丁时 leftover 是「还没打」，不是「用不到」，别混。
      if (reverted) return `手机适用 ${applicable} 条，${counts.hit} 条等着打`
      // 和上面「待办」用同一个口径：patchAdvice 说「不用管」的都算「手机端用不到」。
      // 早先这里自己算 needWork = applicable - applied - noNeedle，于是 #56 这种
      // 「目标包在、代码不在」的桌面专属补丁被算成「待处理」，而下面五行里的「待办」
      // 又按 patchAdvice 判成「不用管」——同一屏上一处说 1 条待处理、一处说没有要处理的。
      const needWork = need
      const cannotUse = Math.max(0, applicable - effective - needWork)
      const parts = [`手机适用 ${applicable} 条`]
      if (needWork === 0 && cannotUse === 0) parts.push('已全部生效')
      else {
        parts.push(`${effective} 条已生效`)
        if (needWork > 0) parts.push(`${needWork} 条待处理`)
        if (cannotUse > 0) parts.push(`${cannotUse} 条手机端用不到`)
      }
      if (counts.noPkg > 0) parts.push(`另 ${counts.noPkg} 条桌面专属`)
      return parts.join(' · ')
    })(),
    needText: need === 0 ? '没有要处理的' : `${need} 条要处理`,
    // 异常 = 引擎被 App 更新覆盖过（补丁层被冲掉），或注入层被关掉。
    // 状态条只在异常时现身，正常时发空串自己隐藏。
    alert: !healthy,
    // 状态条 24 字上限：两层都停就直说「未正常工作」，只说「注入关了」会让人以为补丁还在。
    alertText: injectOff && patchOff
      ? '破甲未工作 · 点开修复'
      : injectOff
        ? '破甲已关 · 点开恢复'
        : '破甲异常 · 点开处理',
    tables,
    empty: tables.length === 0,
  }
}

/** 静态骨架：不碰文件、不算任何东西，只描述布局与绑定路径。 */
export function buildView() {
  return {
    v: 1,
    type: 'stack',
    title: '破甲状态',
    children: [
      { type: 'callout', tone: { $: 'data.tone' }, text: { $: 'data.summary' } },
      {
        type: 'metric',
        label: '补丁层',
        value: { $: 'data.patchText' },
        tone: { $: 'data.tone' },
        caption: { $: 'data.patchCaption' },
      },
      {
        type: 'keyValue',
        items: [
          ['注入', { $: 'data.enabled' }],
          ['正文', { $: 'data.bytes' }],
          ['变体', { $: 'data.variant' }],
          ['模型', { $: 'data.model' }],
          ['待办', { $: 'data.needText' }],
        ],
      },
      // 上限 4 个按钮，所以「应用补丁」被「一键注入」取代——后者连提示词一起开。
      { type: 'actions', items: [
        { label: '重读', action: 'refresh', icon: 'refresh', style: 'primary' },
        { label: '一键注入', action: 'oneClick', icon: 'bolt' },
        { label: '开关注入', action: 'toggle', icon: 'power' },
        { label: '还原补丁', action: 'patchRevert', icon: 'retry' },
      ] },
      { type: 'text', text: '明细', tone: 'muted' },
      // 明细表由 data 推；空数组时 App 不画
      { type: 'stack', children: { $: 'data.tables' } },
    ],
  }
}

/**
 * 注册状态条与面板。桥接不存在时（网页版、纯终端）静默跳过。
 *
 * 传进来的应当是**插件自己的 ctx**，不是 ctx.inject(['dshGo']) 的回调 ctx ——
 * 后者是个子 fiber 的上下文，桥接服务重建时会被整体销毁，连带把我们注册的
 * 状态条与面板一起清掉，而子 fiber 未必会再跑一次回调（手机上实测：引擎启动后
 * 注册 339 毫秒就被清空，之后再没人补回来，App 里一直显示「插件还没处理这一项」）。
 * 用插件自己的 ctx 注册，副作用跟着插件走；服务换了由上层负责重新调这里。
 *
 * @param {any} ctx 插件自己的 ctx
 * @param {{ home: string, config: any, warn: (m: string) => void, diag?: Function }} deps
 * @returns {string[]} 注册到了哪些面
 */
export function installDshGo(ctx, deps) {
  const { home, config, warn } = deps
  // ctx.get(name, false) 是 cordis 里唯一「不声明 inject 也能拿服务」的口子：
  // 直接写 ctx.dshGo 会抛 cannot get property "dshGo" without inject，
  // 而声明进顶层 inject 又会让没有桥接的宿主（网页版、纯终端）整个插件不加载。
  let go = null
  try {
    go = typeof ctx?.get === 'function' ? ctx.get('dshGo', false) : null
  } catch {
    go = null
  }
  if (!go || typeof go !== 'object') return []

  const registered = []
  const cleanups = []
  const timers = new Set()
  const stripEmitters = new Set()
  // 用 Set 而不是单槽：同一个面板声明了 session.tab / chat.panel / features 三个挂载点，
  // 单槽会让第二个挂载顶掉第一个，关掉任意一个还会把另一个的刷新通道置空。
  const panelEmitters = new Set()

  const push = () => {
    let data
    try {
      data = collect(home, config)
    } catch (error) {
      warn(`dsh-go 取状态失败：${error?.message || error}`)
      return
    }
    for (const emit of [...panelEmitters]) {
      try {
        emit(data)
      } catch {
        /* 这一个面板已关闭 */
      }
    }
    // 状态条只在异常时出现：正常就发空字符串，App 那边 text 为空会直接不画
    // （dsh-Go 的 composer_strip.dart 里：if (line.text.isNotEmpty) ready.add(...)）。
    // 应用完补丁，下一拍 push 发空串，状态条自己就没了。
    for (const emit of [...stripEmitters]) {
      try {
        emit(data.alert ? { text: data.alertText, icon: 'warning', tone: 'warn' } : { text: '' })
      } catch {
        /* 状态条未显示 */
      }
    }
  }

  if (typeof go.strip === 'function') {
    try {
      cleanups.push(go.strip(ALERT_ID, (scope, emit) => {
        stripEmitters.add(emit)
        // 先发空串：正常情况就别让状态条冒出来
        try { emit({ text: '' }) } catch { /* 未显示 */ }
        const first = setTimeout(push, 0)
        if (typeof first.unref === 'function') first.unref()
        timers.add(first)
        const timer = setInterval(push, REFRESH_MS)
        if (typeof timer.unref === 'function') timer.unref()
        timers.add(timer)
        return () => {
          clearInterval(timer)
          timers.delete(timer)
          stripEmitters.delete(emit)
        }
      }))
      registered.push(`strip:${ALERT_ID}`)
    } catch (error) {
      warn(`状态条注册失败：${error?.message || error}`)
    }
  }

  if (typeof go.panel === 'function') {
    try {
      cleanups.push(go.panel(PANEL_ID, {
        view: () => buildView(),
        data: (scope, emit) => {
          panelEmitters.add(emit)
          const first = setTimeout(push, 0)
          if (typeof first.unref === 'function') first.unref()
          timers.add(first)
          const timer = setInterval(push, REFRESH_MS)
          if (typeof timer.unref === 'function') timer.unref()
          timers.add(timer)
          return () => {
            clearInterval(timer)
            timers.delete(timer)
            panelEmitters.delete(emit)
          }
        },
        actions: {
          // 面板按钮的回调**同步**超时只有 3 秒（原生界面诊断页那条「点按 3 秒后才返回，已忽略」就是它），
          // 但打补丁要扫 331 个包、改 41 个文件，手机上十几秒起步。
          // 正确做法是用协议 §4.7 的 deferred：返回 { pending, result }，
          // App 会一直转圈到 Promise 结束，然后再收尾 —— 不需要我们自己 setTimeout 抢跑。
          // pending.label 最多 16 字，timeoutMs 上限 60 秒，每个插件同时最多 2 个。
          // 重读是本机 40ms 级的活（手机上 proot 慢十倍也就 1 秒出头），远在 3 秒回调超时内，
          // 所以**同步做、同步返回**。用 pending 反而要多一整套转圈/取消/竞态处理，
          // 还会出现「点了取消却仍弹已重读」——因为 Promise 早就完成、toast 已经开始发了。
          refresh: () => {
            invalidatePatches()
            push()
            return { toast: '已重读' }
          },
          // 一键注入：两层一起拉起来——打开提示词注入 + 把补丁打上。
          // 打补丁很慢，所以整段放进 result；两层本来就正常时直接说「无需再打」。
          // 打补丁要扫 331 个包、改最多 41 个文件、每个文件还要 node --check，
          // 手机上十几秒起步，**必须**用 deferred（同步返回会撞 3 秒超时）。
          // result 接 signal：用户点取消时 bridge 会 abort，我们要在中途检查并放弃，
          // 否则「取消之后仍然弹已打上」——那比不给反馈更让人困惑。
          oneClick: () => ({
            pending: { label: '正在注入…', timeoutMs: 60000 },
            result: async (signal) => {
              let wasEnabled = true
              try {
                wasEnabled = readState(home).enabled !== false
                if (!wasEnabled) setEnabled(home, true)
              } catch (error) {
                return { toast: `开注入失败：${String(error?.message || error).slice(0, 20)}` }
              }
              try {
                if (signal?.aborted) return {}   // 已经被取消：什么都不发
                const r = patchApply(home, { root: config?.aiRoot })
                invalidatePatches()
                push()
                // 打完再看一眼：这十几秒里用户可能已经取消了，
                // 那就别把「已打上」推回去（补丁确实生效了，但 UI 上不该再冒泡）。
                if (signal?.aborted) return {}
                if (!r?.ok) return { toast: `补丁失败：${String(r?.errors?.[0]?.error || '未知').slice(0, 24)}` }
                // 什么都没改 = 本来就在正常工作，别报「补丁 0 条已打上」让人以为失败
                if (!(r.applied > 0)) return { toast: wasEnabled ? '破甲已正常工作，无需再打' : '注入已开，补丁已是最新' }
                return { toast: `补丁 ${r.applied} 条已打上，重启后生效` }
              } catch (error) {
                return { toast: `注入失败：${String(error?.message || error).slice(0, 24)}` }
              }
            },
          }),
          // 开关注入只是写一个 JSON + 扫一次盘，同样是秒级以内的活，同步做。
          // 同步做还有个好处：面板数据在同一个回调里就推下去了，顶部状态立刻变，
          // 不会出现「点了关、上面还显示开、要重进才刷新」。
          toggle: () => {
            try {
              const { enabled } = toggle(home)
              push()
              return { toast: enabled ? '注入已开' : '注入已关' }
            } catch (error) {
              return { toast: `切换失败：${String(error?.message || error).slice(0, 24)}` }
            }
          },
          // 当前四个按钮里没有「应用补丁」——它被「一键注入」取代了（上限 4 个）。
          // 留着给以后加按钮用，同样走 deferred。
          patchApply: () => ({
            pending: { label: '正在打补丁…', timeoutMs: 60000 },
            result: async () => {
              try {
                const r = patchApply(home, { root: config?.aiRoot })
                invalidatePatches()
                push()
                return { toast: r?.ok ? `已应用 ${r.applied ?? 0} 个补丁` : `应用失败：${String(r?.errors?.[0]?.error || '未知').slice(0, 20)}` }
              } catch (error) {
                return { toast: `应用失败：${String(error?.message || error).slice(0, 24)}` }
              }
            },
          }),
          // 还原是最慢的一个：扫两遍快照 + 复制最多 41 个文件。
          // 还原只是「把备份里的文件复制回去」，本机 74ms、手机上 proot 慢十倍也就 1 秒内，
          // 同样在 3 秒回调超时之内 —— 所以**同步做**。
          //
          // 之前这里用了 deferred（转圈 + 可取消），但还原太快了：用户点取消时
          // Promise 往往已经跑完、toast 已经发出，于是出现「点了取消却弹已还原」。
          // 这不是加几个 signal 检查能根治的——竞态窗口本身就在那儿。
          // 同步做完直接给结果，没有转圈、没有取消、也就没有竞态。
          patchRevert: () => {
            try {
              const before = patchSnapshot(config?.aiRoot).rows.filter((x) => x.status === 'applied').length
              const r = patchRevert(home, { root: config?.aiRoot })
              invalidatePatches()
              const after = patchSnapshot(config?.aiRoot).rows.filter((x) => x.status === 'applied').length
              push()
              if (r?.ok) {
                // 备份里可能只有「尝试过但没打上」的文件（写回去内容一样），
                // 这时已生效条数不会变——别说「已还原」让人以为补丁撤了。
                return { toast: after === before ? '没有可回退的补丁（不是本插件打的）' : `已还原 ${r.restored ?? 0} 个文件` }
              }
              // 版本对不上时按三种情况给不同的话——用户看到的是「该干什么」，不是错误码。
              // 用 find 而不是取 [0]：manifest 文件数对不上之类的问题会先 push 一条没 kind 的错，
              // 取第 0 个就会漏掉真正该显示的版本提示。
              const kind = (r?.errors || []).find((e) => e && e.kind)?.kind
              if (kind === 'engine_unsupported') {
                return { toast: '引擎版本变了且没适配，先别注入（可能崩），看 README 第 15 章' }
              }
              if (kind === 'engine_supported') {
                return { toast: '引擎版本已适配，点「一键注入」重打一次就行' }
              }
              if (kind === 'app_changed') {
                return { toast: 'App 更新过了，点「一键注入」重建备份' }
              }
              const why = String(r?.errors?.[0]?.error || '未知原因')
              return { toast: why.includes('没有可还原') || why.includes('备份目录为空')
                ? '还没有插件备份，先点「一键注入」打一次'
                : `还原失败：${why.slice(0, 24)}` }
            } catch (error) {
              return { toast: `还原失败：${String(error?.message || error).slice(0, 24)}` }
            }
          },
        },
      }))
      registered.push(`panel:${PANEL_ID}`)
    } catch (error) {
      warn(`面板注册失败：${error?.message || error}`)
    }
  }

  // 记在返回数组上，方便上层在服务换代时一次性撤掉旧注册
  registered.cleanups = cleanups
  // App 只要还在订阅状态条，就说明注册活着（producer 是订阅时才调的）。
  // 上层用它判断「要不要补注册」，避免每次补都把用户眼皮底下的状态条闪一下。
  // 面板被打开过、或状态条在推，就说明注册被 App 认得，不必再补
  registered.isLive = () => panelEmitters.size > 0 || stripEmitters.size > 0
  return registered
}

/** 撤掉上一次注册。服务换代或插件卸载时调用。 */
export function uninstallDshGo(registered) {
  for (const dispose of registered?.cleanups ?? []) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      /* 旧注册已经没了 */
    }
  }
  return []
}
