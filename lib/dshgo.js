// dsh-go 原生界面：输入框上方的状态条 + 点开的面板。
//
// 和旧实现的关键差别（旧实现把手机卡死过一次，见 native-diag.log 与操作记录）：
//   view 只返回静态骨架，值全是数据绑定 { $: 'data.x' }，一次计算都不做；
//   真正的取数在 data() 里，异步算完 emit 出去，30 秒一次。
// App 每次重绘都会调 view，把扫盘塞进 view 里等于每次重绘扫一遍 331 个包。
import fs from 'node:fs'
import path from 'node:path'
import { snapshot, patchSnapshot, invalidatePatches } from './view.js'
import { toggle, patchApply, patchRevert } from './ops.js'
import { readState, setEnabled } from './state.js'
import { patchAdvice } from './tools.js'
import { updateText, stale, check as checkUpdate, repoRoot, localVersion } from './update.js'
import { syncNative } from './sync.js'
import { execFile } from 'node:child_process'

const PANEL_ID = 'status'
const ALERT_ID = 'purge-alert'
const REFRESH_MS = 30_000


/** 跑一条外部命令，收 stdout/stderr/退出码。永不抛错——调用方自己看 code。 */
function run(cwd, cmd, args, timeout = 30_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        out: String(stdout || ''),
        err: String(stderr || (error && error.message) || ''),
      })
    })
  })
}

/** 算一份面板要用的数据。慢，只在 data() 里调。 */
export function collect(home, config) {
  const snap = snapshot(home, config)
  const p = patchSnapshot(config?.aiRoot)
  // 剔掉反向补丁（#2/#3）：它们的 markers 写的就是官方原版文案，所以任何没打过补丁的
  // 引擎上都会判 applied——它们不改任何文件，只是「万一那段被别的补丁改花了，改回来」。
  // 留着它们会让分母从 58 变成 60，看着像 60 条都被改过。
  const rows = (Array.isArray(p?.rows) ? p.rows : []).filter((row) => row?.reverse !== true)
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
    // partial 单列，不进 need：它不是「该打没打上」，进 need 会和分子打架——
    // 它跟「待打」是两回事：待打要重跑 apply，partial 重跑也没用（那边本机就没有）。
    // 它也不该被说成「已全部生效」，所以单独给一档文案。
    if (s === 'partial') continue
    let advice = ''
    try { advice = patchAdvice(row) } catch { advice = '' }
    if (advice && !advice.includes('不用管')) need += 1
  }
  const applicable = rows.length - counts.noPkg
  // 分子只算真正打完的 applied。partial 单列一档（"N 条只改了一部分"）：
  //   · 算进分子会出现「5/5」却在文案里写「1 条只改了一部分」，数字和文字对不上；
  //   · 完全不算又会让它从面板上消失，用户不知道有东西没改全。
  // 分成「applied / partial / 待打 / 用不到」四档之后，四者相加正好等于 applicable。
  const effective = counts.applied || 0
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
  // 判「补丁层被打穿」要用 applied + partial，不能只看 applied：
  // 某版引擎上多数补丁变成 partial 时，只看 applied 会出现「面板写 48/60」和
  // 「顶部红条说补丁被覆盖了」同时存在——同一屏两个结论，用户不知道该信哪个。
  // 但这两个数现在分了档（见上），所以单独算一个专给阈值用的合计。
  const landed = effective + (counts.partial || 0)
  const brokenLayer = rows.length > 0 && landed < APPLIED_FLOOR
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
    landed >= APPLIED_FLOOR &&
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
    // 带上版本号：点「更新」时 App 那边可能弹「没完成」（bridge 的等待上限），
    // 那时候用户唯一的凭据就是这一行——看到数字变了就知道其实成功了。
    const v = localVersion()
    summary = v ? `破甲能力完全正常（v${v}）。` : '破甲能力完全正常。'
  } else {
    summary = `有 ${need} 条补丁需要处理。点「一键注入」重打一遍。`
  }

  // 更新提示单独一行（view 里的 warning 元素），不拼进 summary——

  // updateText() 要跑一次 git，慢；下面「有更新时第 4 位换成更新」还要用同一个值，
  // 所以只算一次存起来——原来这里调了两次，每 30 秒白跑一遍 git。
  const upd = updateText()

  return {
    // 有新版本时界面显示这一句；空串 = 不显示
    updateText: upd,
    // 有更新时第 4 位是「更新」，否则是「还原补丁」——凑满 4 个不超上限
    buttonItems: (() => {
      const base = [
        { label: '重读', action: 'refresh', icon: 'refresh', style: 'primary' },
        { label: '一键注入', action: 'oneClick', icon: 'bolt' },
        { label: '开关注入', action: 'toggle', icon: 'power' },
      ]
      return upd
        ? [...base, { label: '更新', action: 'update', icon: 'download' }]
        : [...base, { label: '还原补丁', action: 'patchRevert', icon: 'retry' }]
    })(),
    summary,
    tone: healthy ? 'good' : tone,
    // 发过消息就用装配时报上来的真值，没发过就读 profile 里配的默认模型
    // 未打补丁时别显示「2/60」——那 2 条是把文案改回官方说法的反向补丁，
    // 原版天然满足，写出来只会让人以为「打了但没打全」。
    // applicable=0 说明没扫到引擎包（路径不对、装错地方）。这时候写「0/0」纯属噪音——
    // 用户看到两个零不知道是「没打」还是「坏了」，直接写「无法判定」。
    // 一律用 N/M：用户明确要「保留数字」，那异常态也应该是 0/58、31/58 这种，
    // 而不是「未打」三个字——同一个位置一会儿数字一会儿文字，反而要多想一步。
    // 只有两种例外：扫不到引擎包（0/0 没意义）和「全都还没打」时分数太难看，
    // 后者给「未打」是为了不让人误以为「打了 2 条」（2 是反向补丁的位置，已剔掉）。
    patchText: applicable === 0
      ? '无法判定'
      : reverted && effective === 0
        ? '未打'
        : `${effective}/${applicable}`,
    // 异常 = 引擎被 App 更新覆盖过（补丁层被冲掉），或注入层被关掉。
    // 状态条只在异常时现身，正常时发空串自己隐藏。
    alert: !healthy,
    // 状态条 24 字上限：两层都停就直说「未正常工作」，只说「注入关了」会让人以为补丁还在。
    // 正常时必须给空串：emit 那边虽然是按 alert 分支发的，但这儿留着一句「破甲异常」
    // 的文案，一旦别处（新版本面板、调试输出、缓存）直接读这个字段，就会正常状态也冒红条。
    alertText: !healthy
      ? injectOff && patchOff
        ? '破甲未工作 · 点开修复'
        : injectOff
          ? '破甲已关 · 点开恢复'
          : '破甲异常 · 点开处理'
      : '',

  }
}

/** 静态骨架：不碰文件、不算任何东西，只描述布局与绑定路径。 */
export function buildView() {
  return {
    v: 1,
    type: 'stack',
    title: '破甲状态',
    // 面板只回答三个问题：破甲在不在工作、补丁打没打上、四个按钮能不能点。
    // 明细（86 条逐条状态）、注入层/正文/变体/模型/待办五行、8 个状态词全部不放——
    // 那是开发者视角，用户看了只会问「部分命中是什么意思」。
    // 真要查是哪条没打上：node patches/purge-patch.mjs probe。
    children: [
      // 一句话总状态。正常时是绿的「破甲正常工作」，出问题时是「怎么了 + 该点哪个」。
      { type: 'callout', tone: { $: 'data.tone' }, text: { $: 'data.summary' } },
      // 有更新时这一行才出现（空串时 App 不画）
      { type: 'text', text: { $: 'data.updateText' }, tone: 'warn' },
      // 补丁：分子只算真改过文件的，#2/#3 这种「markers 就是原版文案」的反向补丁不算。
      // 不带 caption——原来那句「手机适用 60 条 · 已全部生效 · 另 26 条桌面专属」
      // 每个字都在解释为什么分母不是 86，而用户根本没问。
      {
        type: 'metric',
        label: '补丁',
        value: { $: 'data.patchText' },
        tone: { $: 'data.tone' },
      },
      // 按钮上限 4 个（多出来的会被 App 丢掉）。有更新时把「还原补丁」换成「更新」——
      // 二者都是低频操作，撞车时优先让用户看见能立刻做的事。
      { type: 'actions', items: { $: 'data.buttonItems' } },
    ],
  }
}

/** 注册状态条与面板；桥接不存在（网页版、纯终端）时静默跳过。
 * 必须传插件自己的 ctx，不能用 ctx.inject 的回调 ctx——那是子 fiber，桥接重建时会连我们
 * 注册的面一起清掉且不重跑回调（实测注册后 339ms 被清空，之后没人补回来）。 */
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

  // 状态条和面板各有一个 30 秒定时器，都调 push()——不节流的话 collect()（含一次 git）
  // 每 30 秒要跑两遍，diag 里能看见两行重复记录。
  // 节流做法：记住上次算的时间，200ms 内重复调用直接复用上一次的数据。
  // 200ms 远大于两个定时器的抖动差、又远小于 30 秒周期，不会让用户看到过期数据。
  let lastAt = 0
  let lastData = null
  const push = () => {
    const now = Date.now()
    if (lastData && now - lastAt < 200) {
      // 同一个 tick 里的第二次调用：直接重发上次那份，不重新扫盘
      for (const emit of [...panelEmitters]) { try { emit(lastData) } catch { /* 已关闭 */ } }
      for (const emit of [...stripEmitters]) {
        try { emit(lastData.alert ? { text: lastData.alertText, icon: 'warning', tone: 'warn' } : { text: '' }) } catch { /* 未显示 */ }
      }
      return
    }
    let data
    try {
      data = collect(home, config)
    } catch (error) {
      warn(`dsh-go 取状态失败：${error?.message || error}`)
      return
    }
    lastAt = now
    lastData = data
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
          // 缓存过期就去查一次更新；查完再推一次让界面刷出来。
          // 不 await：网络慢时面板不能跟着卡住。查失败静默，界面上什么都不显示。
          if (stale()) checkUpdate().then(() => push()).catch(() => {})
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
          // 面板按钮回调的同步超时只有 3 秒（原生界面诊断页那条「点按 3 秒后才返回」就是它）。
          // 能在 3 秒内做完的就同步做、同步返回；接原生界面那几步必须用 deferred
          // （同步返回会撞超时），但 deferred 有硬上限：label ≤16 字、timeoutMs ≤60s、并发 ≤2，
          // 超了原生界面会直接拒绝——加新的 deferred 之前先看这三条。
          refresh: () => {
            invalidatePatches()
            push()
            return { toast: '已重读' }
          },
          // 一键注入：两层一起拉起来——打开提示词注入 + 把补丁打上。
          // 打补丁很慢，所以整段放进 result；两层本来就正常时直接说「无需再打」。
          // 打补丁要扫 331 个包、改最多 47 个文件、每个文件还要 node --check，
          // 手机上十几秒起步，必须用 deferred（同步返回会撞 3 秒超时）。
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
                // 还没动手就被取消：这时确实什么都没做，静默可以接受，
                // 但给一句话更诚实——用户点了取消，也该知道「确实没执行」。
                if (signal?.aborted) return { toast: '已取消，什么都没做' }
                const r = patchApply(home, { root: config?.aiRoot })
                invalidatePatches()
                push()
                // 打完再看一眼：这十几秒里 App 可能已经放弃等这次调用了（点取消、
                // 或者原生界面那边超时丢弃）。但补丁**已经打完**，静默返回会让用户完全不知道
                // 发生了什么——实测表现就是「点注入有时跳提示有时不跳」，而且慢的那次更容易不跳。
                // 所以这里不再返回空，改为说明「已完成但界面没等到」。
                if (signal?.aborted) return { toast: wasEnabled ? '补丁已打上，界面没等到回话，重开面板看状态' : '注入已开，补丁已打上，界面没等到回话' }
                if (!r?.ok) return { toast: `补丁失败：${String(r?.errors?.[0]?.error || '未知').slice(0, 24)}` }
                // 四种组合各说各的：既要报「做了什么」，也要报「跳过了什么」。
                // 只说做了的那半句会让人以为另一半没管——之前两种完全不同的状态弹同一句话。
                //   wasEnabled = 点之前注入层开没开
                //   upToDate   = 点之前补丁层是不是已经全打上了
                const patchAlready = r.upToDate === true || !(r.applied > 0)
                if (!wasEnabled && patchAlready) return { toast: '注入已开，补丁已是最新，略过' }
                if (!wasEnabled) return { toast: `注入已开，补丁已打上 ${r.applied} 条` }
                if (patchAlready) return { toast: '两层都正常，无需再打' }
                return { toast: `注入本来就开着，补丁已打上 ${r.applied} 条` }
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
          // 更新：git pull --ff-only 拉代码，然后重打补丁。
          // 不重装插件——那一步会触发宿主重新装配，从插件内部调会把自己掐死。
          // 代码是软链进原生目录和 profile 的，pull 完重启就生效。
          update: () => ({
            pending: { label: '正在拉取…', timeoutMs: 25000 },
            result: async (signal) => {
              const root = repoRoot()
              if (!root) return { toast: '不是 git 克隆装的，手动更新' }
              if (signal?.aborted) return { toast: '已取消，什么都没做' }
              const before = localVersion()
              const pull = await run(root, 'git', ['pull', '--ff-only'], 45_000)
              if (pull.code !== 0) {
                const lines = (pull.err || pull.out).trim().split('\n')
                const why = lines[lines.length - 1] || '未知原因'
                // 本地改过仓库时 pull 会被拒——这不是错，是保护，说清楚该怎么办
                return { toast: /local changes|would be overwritten/i.test(why) ? '仓库有本地改动，先 commit 或 stash' : '拉取失败：' + why.slice(0, 24) }
              }
              const after = localVersion()
              const changed = after !== before || !/Already up to date/i.test(pull.out)
              if (!changed) return { toast: '已是最新（' + (after || before) + '）' }
              // 拉都拉完了，别静默——用户得知道代码已经换了、要重启
              if (signal?.aborted) return { toast: '已拉到 ' + after + '，但界面没等到回话，重启 App 生效' }
              // 拉完立刻回话，补丁放后台打。
              //
              // 原因：手机 proot 上「还原 47 个文件 + 重打 60 条补丁 + 每个文件 node --check」
              // 实测超过 60 秒——那是 bridge 的 pending 上限，到点 App 自己弹「没完成」，
              // 而实际上活儿是干完了的（实测版本已更新、补丁仍是 60/60）。
              // 分开之后：几秒内给用户「代码已更新」，补丁在后台继续，打完 push 刷新面板。
              const afterPull = after || before
              // 用 setTimeout 而不是直接跑：patchRevert / patchApply 是同步的重活，
              // 在 async 函数里直接调会把事件循环占死十几秒——连 return 的 Promise
              // 都没机会 resolve，App 到 25 秒超时弹「没完成」（实测过）。
              // 推到下一轮事件循环，先把 toast 发出去，再开始干活。
              setTimeout(() => {
                try {
                  patchRevert(home, { root: config?.aiRoot })
                } catch { /* 没有备份就直接打，下面 patchApply 自己会处理 */ }
                try {
                  patchApply(home, { root: config?.aiRoot })
                } catch { /* 失败时面板会显示待办 */ }
                // 原生目录是复制不是软链，pull 完必须同步一次，否则插件还在跑旧代码。
                // 失败也没关系：旧目录还在，插件照常工作，只是代码不是最新的。
                try { syncNative(root) } catch { /* 同步失败不阻断更新 */ }
                invalidatePatches()
                push()
              }, 100)
              return { toast: '已更新到 ' + afterPull + '，正在重打补丁（约半分钟），完事后重启 App' }
            },
          }),
          // 这里曾经改回同步：那时还原只扫两遍快照 + 复制几十个文件，本机 74ms，
          // 在 3 秒回调超时内；而 deferred 快速完成时用户点取消会出现「点了取消却弹已还原」。
          // 后来 patchRevert 加了「逐份试备份」，份数多时要几百毫秒、手机上成倍放大，
          // 同步会撞 3 秒超时（超时后 App 丢弃返回，功能执行了但没有任何反馈），
          // 所以又回到 deferred。取消仍然只在开始前有效——见 result 里那句注释。
          //
          // 走 deferred，不跟 3 秒同步超时抢：还原要按优先级逐份试备份，
          // 备份份数多时（历史上到过 21 份）即使只扫一份也要几百毫秒，
          // 手机上 proot 慢 2–4 倍，21 份全试会超 3 秒，超时后 App 丢弃返回、
          // 功能其实执行了但用户看不到任何反馈。与 oneClick 同款：转圈 + 60 秒预算。
          patchRevert: () => ({
            pending: { label: '正在还原…', timeoutMs: 60000 },
            result: async (signal) => {
              // 取消只在「还没开始」时有效：下面是整块同步代码（两次快照扫描 + 还原），
              // 中间没有 await 让出，signal 不会在途中翻转。所以放在最开始查——放中间
              // 等于假装能中断。真让出就要把 patchSnapshot 拆成异步分片，代价远大于收益
              // （还原本身不到 1 秒，用户几乎来不及点）。
              if (signal?.aborted) return { toast: '已取消，什么都没做' }
              try {
                const before = patchSnapshot(config?.aiRoot).rows.filter((x) => x.status === 'applied').length
                const r = patchRevert(home, { root: config?.aiRoot })
                invalidatePatches()
                const after = patchSnapshot(config?.aiRoot).rows.filter((x) => x.status === 'applied').length
                push()
                if (r?.ok) {
                  // 备份里可能只有「尝试过但没打上」的文件（写回去内容一样），
                  // 这时已生效条数不会变——别说「已还原」让人以为补丁撤了。
                  const base = after === before ? '没有可回退的补丁（不是本插件打的）' : `已还原 ${r.restored ?? 0} 个文件`
                  // restore 会带 warnings（App 版本变化、root 不一致、老备份没记版本）。
                  // 之前只把 warnings 传到 ops 就断了，面板从来不看——用户看不到任何提示。
                  // toast 有字数限制，只带第一条、且截短。
                  // 桥接 toast 上限 40 字：base 最长 20（「没有可回退的补丁（不是本插件打的）」），
                  // 括号占 2，warning 只能留 18。原来留 24 会到 43 字，超出后整条可能被截掉。
                  const w = Array.isArray(r?.warnings) ? String(r.warnings[0] || '') : ''
                  const room = Math.max(0, 40 - base.length - 2)
                  return { toast: w && room > 4 ? `${base}（${w.slice(0, room)}）` : base }
                }
                // 版本对不上时按三种情况给不同的话——用户看到的是「该干什么」，不是错误码。
                // 用 find 而不是取 [0]：manifest 文件数对不上之类的问题会先 push 一条没 kind 的错，
                // 取第 0 个就会漏掉真正该显示的版本提示。
                const kind = (r?.errors || []).find((e) => e && e.kind)?.kind
                if (kind === 'engine_unsupported') {
                  return { toast: '引擎版本没适配，别注入（可能崩），看 README 第 6 章' }
                }
                if (kind === 'engine_supported') {
                  return { toast: '引擎版本已适配，点「一键注入」重打一次就行' }
                }
                // app_changed 这个 kind 已经不会出现了：restore 现在把 App 版本差异当警告、
                // 不再算错误（见 patches/lib/core.mjs 里 appMismatch 那段注释）。
                // 留着这个分支等于永远进不去，删掉免得以后有人照着它做判断。
                // 优先读 r.reason：有两类失败（residue>0、restored===0）errors 是空的，
                // 说明只写在 reason 里。只读 errors[0] 的话面板会弹「还原失败：未知原因」，
                // 把「引擎还有 N 个文件带补丁标记，请重装引擎包」这句最该看的吞掉。
                const why = String(r?.reason || r?.errors?.[0]?.error || '未知原因')
                if (why.includes('没有可还原') || why.includes('备份目录为空')) {
                  return { toast: '还没有插件备份，先点「一键注入」打一次' }
                }
                // 桥接 toast 上限 40 字，前面「还原失败：」占 5 个，正文留 30。
                return { toast: `还原失败：${why.slice(0, 30)}` }
              } catch (error) {
                return { toast: `还原失败：${String(error?.message || error).slice(0, 24)}` }
              }
            },
          }),
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
