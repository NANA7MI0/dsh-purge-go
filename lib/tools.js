// 工具：purge_status / purge_apply / purge_revert / purge_prompt
// 每个都挂一张 dsh-go 工具卡（没有桥接/App 时这张卡没人读，不影响调用）。
import { toolCard } from './card.js'
import { snapshot, statusCard, promptCard, patchSnapshot, invalidatePatches } from './view.js'
import {
  revert,
  seed,
  setPrompt,
  useVariant,
  resetVariant,
  mapModel,
  MAX_PROMPT_CHARS,
  categoryList,
  categoryAdd,
  categoryRemove,
  categoryToggle,
  categoryReset,
  categoryBake,
  findReusableBackup,
} from './ops.js'
import { dshHome } from './home.js'
import { detectRoot, engineVersion } from '../patches/lib/core.mjs'
import { setEnabled } from './state.js'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** 包根（lib/ 的上一级），用来找 patches/purge-patch.mjs。 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 调 patches/purge-patch.mjs，返回 { code, stdout, stderr }。
 *
 * restore 必须带 --backup：CLI 那边 backupDir 是必填参数（core.restore 会直接
 * 抛 "restore needs a backup directory"）。以前这里只传 mode，于是工具上的
 * 「还原补丁」永远失败——而它自己还把这个失败标成 restore_partial，
 * 措辞像「可能改了一部分」，实际一个字节没动。
 * 现在自己找最近一份能用的备份传过去；找不到就明确回「没有可还原的备份」。
 */
function runPatchScript(mode, extraArgs = []) {
  const script = join(PKG_ROOT, 'patches', 'purge-patch.mjs')
  return new Promise((resolve) => {
    execFile(process.execPath, [script, mode, ...extraArgs], { cwd: PKG_ROOT, timeout: 120_000 }, (error, stdout, stderr) => {
      // execFile 超时或被杀时 error.code 是 null，用 ?? 0 会把失败当成功
      const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0
      const why = error?.killed ? `（${error.signal || 'killed'}，可能超时）` : ''
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || error?.message || '') + why })
    })
  })
}

const text = (body) => [{ type: 'text', text: body }]

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    bytes: { type: 'number' },
    chars: { type: 'number' },
    source: { type: 'string' },
    variant: { type: 'string' },
    model: { type: 'string' },
    variants: { type: 'number' },
    injectPath: { type: 'string' },
    injectExists: { type: 'boolean' },
    dropped: { type: 'array', items: { type: 'string' } },
    home: { type: 'string' },
    summary: { type: 'string' },
    verdict: { type: 'string' },
    // 历史清洗的两个前提，分开报：
    //   scrubHook  —— 钩子挂上没（插件没加载成功就没有）
    //   scrubPatch —— 补丁在没（App 更新会重装引擎包、把它冲掉）
    // 只报一句「开着」没法排障，这两件事的坏法完全不同。
    scrubHook: { type: 'boolean' },
    scrubPatch: { type: 'boolean' },
    patches: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        root: { type: 'string' },
        total: { type: 'number' },
        tally: { type: 'object', additionalProperties: true },
        error: { type: 'string' },
        applicable: { type: 'number' },
        pending: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
              status: { type: 'string' },
              pkg: { type: 'string' },
            },
          },
        },
        // 目标文件缺失的行：文本改到位了（status 还是 applied），但有文件不在。
        // 不声明的化，patchInfo 一返回就会被 additionalProperties:false 拒掉。
        missingTargets: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
              missing: { type: 'number' },
            },
          },
        },
        partials: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
              hits: { type: 'number' },
              total: { type: 'number' },
            },
          },
        },
        layers: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string' },
              label: { type: 'string' },
              total: { type: 'number' },
              ok: { type: 'number' },
              need: { type: 'number' },
              skip: { type: 'number' },
              // 必须声明：layerSummary 会给有 partial 的层写这个字段，
              // 而这里是 additionalProperties:false——漏声明会让整个 purge_status
              // 在「有部分命中」的机器上直接抛 ToolOutputError，正好是最该看状态的时候
              partial: { type: 'number' },
            },
          },
        },
        missing: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string' },
              count: { type: 'number' },
              why: { type: 'string' },
            },
          },
        },
      },
    },
  },
}

const PROMPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    message: { type: 'string' },
    bytes: { type: 'number' },
    chars: { type: 'number' },
    variant: { type: 'string' },
    variants: { type: 'array', items: { type: 'string' } },
    preview: { type: 'string' },
    maxChars: { type: 'number' },
  },
}

const CATEGORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    count: { type: 'number' },
    entries: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
  },
}

const APPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    enabled: { type: 'boolean' },
    written: { type: 'boolean' },
    bytes: { type: 'number' },
    message: { type: 'string' },
  },
}

/** 补丁层快照：按状态分布。只在被调用时扫盘，带 30 秒缓存。条数从表里读，不写死。 */
function patchInfo() {
  const p = patchSnapshot()
  // 剔掉反向补丁（#2/#3）：它们的判据就是官方原版文案，不改任何文件。
  // 面板（lib/dshgo.js 的 collect）已经剔了，这里不剔会导致
  // 「面板写 58/58、工具卡写 60/86」，同一台机器两个数。
  const rows = (p.rows || []).filter((r) => r.reverse !== true)
  const tally = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a }, {})
  const total = rows.length
  const noPkg = Number(tally.no_pkg) || 0
  return {
    ok: Boolean(p.ok),
    root: String(p.root || ''),
    total,
    tally,
    error: String(p.error || ''),
    // 手机上有目标的条数：总数里减去目标是桌面包的那些，本来就不适用
    applicable: Math.max(0, total - noPkg),
    // 只留「该打却没打上」的，按 id 排序，给 statusText 和模型读
    // partial 不算「该打没打上」——它是「多套写法里命中了一套」，那套已经改好了，
    // 列进 pending 只会让人以为出了问题。
    pending: rows
      .filter((r) => ['miss', 'no_needle', 'no_file', 'drifted'].includes(r.status))
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ id: r.id, name: r.name, status: r.status, pkg: String(r.pkg || '') })),
    // 部分命中的那几条：单独列出来，好让 statusText 直接说清「正常、不影响破甲」，
    // 而不是只留一个「部分命中 2」让读者自己猜。
    // 目标文件缺失的行：status 还是 applied（文本确实改到位了），但有文件不在。
    // 不单列的话，这类行既不进 pending、面板也算「已生效」，用户完全看不到，
    // 而 apply 现在会去补它们（见 core.mjs 的候选条件）。
    missingTargets: rows
      .filter((r) => Number(r.missingTargets) > 0)
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ id: r.id, name: r.name, missing: Number(r.missingTargets) })),
    partials: rows
      .filter((r) => r.status === 'partial')
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ id: r.id, name: r.name, hits: Number(r.hits) || 0, total: Number(r.total) || 0 })),
    // 按用途的汇总。statusText 要它，但 statusText 走工具路径时拿不到 rows——
    // 在这里算好带出去，两条路径才有同一份数。
    layers: layerSummary(rows),
    // 目标包在手机上不存在的那些，按用途归类——用来解释「为什么不影响破甲」
    missing: missingGroups(p),
  }
}

/** 补丁条数低于这个值就判定为「被覆盖」。正常环境是 40 条以上，原版是 0~1 条。 */
const PATCH_BROKEN_THRESHOLD = 10

/**
 * 判定「补丁层到底生效没有」的唯一口径：只算 applied，不含 partial。
 *
 * 为什么不能把 partial 加进来（这是踩过的）：
 * 完全没打过补丁的干净引擎上，partial 本来就有 26 条——补丁表里每条写了几套不同
 * 引擎版本的写法，本机只有其中一套，剩下那些目标根本不存在，于是判成「改了一部分」。
 * 把它算进生效数，干净引擎会显示「26/58 已生效（44.8%）」，判成「破甲能力正常」。
 *
 * 那 partial 什么时候要看？它确实是「需要人看一眼」的状态——面板和工具卡都会单独
 * 列出来（见 patchAdvice），只是不进「是否生效」这个判定。
 */
function landedOf(p) {
  const t = p.tally || {}
  return Number(t.applied) || 0
}

/**
 * 已知未生效补丁的人工说明。键是补丁表里的 id。
 * 只写查清楚的——查不清的走 patchReason 的通用解释，别瞎猜。
 */
const PATCH_NOTES = {
  56: '目标包对上了（dsh-client-ui-conversation），但里面没有 sourceEventSeqs 那段代码——这条针对的是桌面 Web 端的回退行为，手机端的实现不一样。',
  77: '手机上不触发。这条改的是桌面端「回退标记到达时立刻撤掉已发送消息」的行为，手机 App 的对话界面是 Flutter 原生实现，不走那条代码路径——不打包也能正常用。',
}

/** 补丁层是不是被覆盖了（注入层关着不算——那是用户自己关的）。 */
function patchesBroken(snap) {
  const p = snap.patches || {}
  if (!p.ok || !snap.enabled) return false
  return landedOf(p) < PATCH_BROKEN_THRESHOLD
}

/** 异常块：只在补丁层被覆盖时出现，正常时一个字都不多。 */
function brokenLines(snap) {
  const p = snap.patches || {}
  // 和 isBroken 用同一个口径：这里报的「已生效」必须跟判据一致，
  // 否则会出现「只有 8/86 条生效」却因为 partial 够多而没判 broken 的矛盾。
  const applied = landedOf(p)
  // 分母用「手机适用」：和面板、和正常状态那句保持一致。
  const total = Number(p.applicable) || Number(p.total) || 0
  return [
    '⚠️ 破甲异常：补丁层没生效',
    `  当前只有 ${applied}/${total} 条生效（低于 ${PATCH_BROKEN_THRESHOLD} 条就判定为被覆盖）`,
    '  两种可能：①从市场装的，还没打过补丁（补丁改的是引擎源码，装插件时打不了）；',
    '            ②打过了，但 App 更新重装引擎包时被冲掉了。',
    '  修复：说一句「重打补丁」，或调 purge_patch_apply（打完要重启引擎）',
    `  手动：cd ${PKG_ROOT} && node patches/purge-patch.mjs apply`,
    '',
  ]
}

/**
 * 把 no_pkg 的那些补丁按「为什么手机上没这个包」归类。
 *
 * 补丁表是照桌面版整理的，里面有一批包手机引擎根本不装：
 * 预设变体、Electron 外壳、Claude/Codex 钩子、别的模型后端。
 * 它们不打不影响破甲——改的都是手机上没有的代码路径。
 */
const MISSING_BUCKETS = [
  { key: ['LIANGSHEN'], label: 'liangshen 预设', why: '第三方自定义预设，本机没装' },
  { key: ['PRESET_'], label: '预设变体', why: '手机只跑 web 预设，其余 preset（standard/ptc/cordis/minimal/unrestricted）没装' },
  { key: ['DESKTOP_'], label: '桌面外壳', why: 'Electron 主进程那一套，手机不是这个运行形态' },
  { key: ['HOOKS_'], label: 'Claude Code / Codex 钩子', why: '给别的命令行工具用的钩子，手机没装那两个工具' },
  { key: ['ANTHROPIC_', 'DEEPSEEK_SYSTEM_ROLE'], label: '其它模型后端', why: '手机只用 DeepSeek 的官方通道，没装 Anthropic / completions 适配层' },
  { key: ['ESCALATION_', 'SANDBOX_HINT_'], label: '权限升级包', why: '手机版的审批逻辑在 dsh-user-approval 里，没有独立 escalation 包' },
  { key: ['OFFICIAL_RUN_CODE_', 'OFFICIAL_TOOL_ASK_'], label: 'PTC 工具执行器', why: '手机版没启用 PTC（program-to-call）那套工具链' },
]

function missingGroups(p) {
  const rows = (p?.rows || []).filter((r) => r.status === 'no_pkg')
  if (!rows.length) return []
  const out = []
  const used = new Set()
  for (const b of MISSING_BUCKETS) {
    const name = (r) => String(r.name || '').toUpperCase()
    const hit = rows.filter((r) => !used.has(r.id) && b.key.some((k) => name(r).includes(k)))
    if (!hit.length) continue
    hit.forEach((r) => used.add(r.id))
    out.push({ label: b.label, count: hit.length, why: b.why })
  }
  const rest = rows.filter((r) => !used.has(r.id))
  if (rest.length) out.push({ label: '其它', count: rest.length, why: '目标包本机没有安装' })
  return out
}

/** 一句话结论，固定措辞，不给模型自由发挥的空间。 */
function patchVerdict(patches) {
  const tally = patches?.tally || {}
  const applicable = Number(patches?.applicable) || 0
  // 用 landedOf（applied + partial），和面板、异常块同一个口径。
  // 以前这里只数 applied，于是同一份 tally 会出现「工具卡说没生效、面板不红」的矛盾：
  // 实测 applied 9 + partial 5 时，verdict 说「只有 9 条生效」，而异常块因为 landed=14 不出现。
  const applied = landedOf(patches)
  if (!applicable) return '补丁层未扫描到引擎目录，无法判断。'
  // 补丁被 App 更新冲掉时 applied 会掉到个位数，这时不能还说「完全正常」——
  // 模型转述时多半只抄这一句，抄错比不抄更糟。
  if (applied < PATCH_BROKEN_THRESHOLD) {
    return (
      `破甲补丁层没生效：手机上适用 ${applicable} 条，当前只有 ${applied} 条生效。` +
      'App 更新会重装引擎包把它们冲掉，说一句「重打补丁」或调 purge_patch_apply 即可，打完要重启引擎。'
    )
  }
  const pct = ((applied / applicable) * 100).toFixed(1)
  return (
    `破甲能力正常：手机上适用 ${applicable} 条、已生效 ${applied} 条（${pct}%）。` +
    '这个百分比只是补丁条目的计数，不是破甲强度的折扣；没打上的要么手机不需要，要么只影响桌面端。'
  )
}

/**
 * 把「没打上的补丁 + 原因」拼成一段给人看的文本。
 * statusText（工具卡）和 purge_status 的返回值（模型读）共用这一份，
 * 免得模型自己猜——它拿到结构化 JSON 时经常只念数字、不解释原因。
 */
function pendingSummary(patches) {
  const list = Array.isArray(patches?.pending) ? patches.pending : []
  const missing = Array.isArray(patches?.missing) ? patches.missing : []
  const tally = patches?.tally || {}
  const noPkg = Number(tally.no_pkg) || 0
  if (!list.length && !missing.length) return ''

  const label = {
    applied: '已生效', partial: '部分命中', hit: '待应用', drifted: '被覆盖',
    miss: '未命中', no_needle: '无目标句', no_file: '文件缺失', no_pkg: '包不存在',
  }
  const out = []
  // 结论放最前面：模型转述长文本时经常只抄开头、把结尾丢掉，
  // 而这句话是用户最先想知道的东西，不能排到最后。
  const applicable0 = Number(patches?.applicable) || 0
  const applied0 = Number(tally.applied) || 0
  if (applicable0) {
    // 和 patchVerdict 同一口径：低于阈值时必须说「没生效」，不能一律「完全正常」
    const broken0 = applied0 < PATCH_BROKEN_THRESHOLD
    out.push(
      broken0
        ? `【结论】破甲补丁层没生效。手机上适用 ${applicable0} 条，当前只有 ${applied0} 条生效` +
            `（低于 ${PATCH_BROKEN_THRESHOLD} 条即判定被覆盖）。App 更新会重装引擎包把它们冲掉，` +
            '说一句「重打补丁」或调 purge_patch_apply 即可，打完要重启引擎。'
        : `【结论】破甲能力完全正常。手机上适用 ${applicable0} 条，已生效 ${applied0} 条` +
            `（${((applied0 / applicable0) * 100).toFixed(1)}%）——这个百分比只是「补丁条目打没打上」的计数，` +
            '不是破甲强度的折扣。没打上的几条要么手机上本来就不需要，要么只影响桌面端行为，' +
            '手机端的注入层和补丁层都是满的。',
    )
    // 补丁层是「一次性」的：App 一更新就被冲掉。用户多半是让模型装的，
    // 模型转述什么用户就看到什么，所以这句必须出现在它读得到的地方。
    if (Number(tally.applied) > 0) {
      out.push('')
      out.push(
        '⚠️ **补丁层不是永久的**：更新 dsh-go App 会重装引擎包、把它整个冲掉。' +
          '到时候重跑一次 apply 就行，插件和配置都不用重新装。',
      )
    }
    const partialN = Number(tally.partial) || 0
    if (partialN) {
      out.push(
        `另有 ${partialN} 条「部分命中」——意思是只改了一部分，需要人看一眼。` +
          '常见原因是引擎版本换了写法（剩下那几处本来就不在这台机器上，不影响），' +
          '但也可能是目标里有一段本机确实存在、只是写法不同，那就没改到。' +
          '拿不准就看面板明细里那几条的说明，或者重装引擎包后重打一次。',
      )
    }
    out.push('')
  }

  if (list.length) {
    out.push('以下是那几条的具体情况（每条最后一句是该拿它怎么办）：')
    for (const r of list) {
      out.push(`${r.id}.${r.name}（${label[r.status] || r.status}）：${patchReason(r)} → ${patchAdvice(r)}`)
    }
  }

  if (noPkg) {
    out.push('')
    out.push(
      `另有 ${noPkg} 条显示「包不存在」。这不是失效，也不影响破甲：补丁表是照桌面版整理的，` +
        '这批补丁的目标包手机引擎根本没有安装，改的都是手机上没有的代码路径。分类如下：',
    )
    for (const g of missing) {
      out.push(`  · ${g.label} ${g.count} 条——${g.why}`)
    }
  }

  return out.join('\n')
}

/**
 * 一条补丁为什么没打上。先看补丁表里的 note（人工标注），
 * 没有就按状态给通用解释——这样新出现的失败也能说清是哪一类。
 */
function patchReason(row) {
  const note = PATCH_NOTES[row.id]
  if (note) return note
  switch (row.status) {
    case 'no_pkg':
      return '目标包不存在——多是桌面版专属（Electron 外壳、Web 客户端），手机上本来就没有，不用管。'
    case 'no_needle':
      return '补丁表里这条的查找串是空的，执行器无从上手（上游导出时 RegExp 退化成了空对象）。'
    case 'no_file':
      return `目标文件不存在：${row.pkg || '未知包'}，手机上可能没这个路径。`
    case 'miss':
      return `目标文件在（${row.pkg || '?'}），但里面找不到要替换的那段文本——引擎版本对不上，或这条本来就只适用于别的形态。`
    case 'drifted':
      return '以前打过，被引擎升级或 App 更新冲掉了，重跑 apply 即可。'
    case 'partial':
      return '**只改了一部分，需要人看一眼。** 补丁表里每条写了几套不同引擎版本的写法，你的引擎只有其中一套——剩下那几处要是在本机也不存在，就是正常；要是在本机存在但写法不同，那就是真没改到。看这行前面的命中数（命中/总数）判断。'
    default:
      return '状态未知。'
  }
}

/**
 * 一条补丁该拿它怎么办。
 * 
 * 原来只给「为什么没打上」，读者还得自己想下一步。实际看状态的人常分三种：
 * 能自己动手的、不用管的、得人来判断的——所以直接给结论，不要让人从状态码反推。
 */
export function patchAdvice(row) {
  const hasNote = Boolean(PATCH_NOTES[row.id])
  switch (row.status) {
    case 'applied':
      return '已生效，不用管'
    case 'partial':
      // 「改了一部分」多半就是没改全，不是正常态——让人看一眼 diff 再决定，
      // 别在这里说「不用管」，那会把它从待办里排除掉、面板显示一切正常。
      return '只改了一部分，需要人看一眼：可能是引擎版本换了写法，也可能是目标里有一段本机没有。'
    case 'no_pkg':
      return '不用管（手机上没有这个包）'
    case 'no_needle':
      return hasNote ? '不用管' : '不用管（只影响这一条）'
    case 'hit':
      return '可以再打一次'
    case 'drifted':
      return '可以再打一次（被升级冲掉了）'
    case 'miss':
      return hasNote ? '不用管' : '暂时没法打，需要人看一眼'
    default:
      return '需要你自己确认'
  }
}

/**
 * 补丁按「管什么」分组，只影响展示顺序，不参与任何判定。
 * 
 * 86 条平铺时读者看到的是一串编号，看不出「审批还拦不拦」「沙箱还挡不挡写」。
 * 分组依据只用补丁自己的名字和它要改的包，不写死 id —— 那样子每次加补丁都要回来改表。
 * 认不出来的落进「其他」，不猜。
 */
const LAYER_RULES = [
  // 桌面专属单列一组：这些在手机上本来就打不上，混进其他组会让「其他」看着像有问题。
  { key: 'desktop', label: '桌面专属', re: /desktop|electron|asar|wscript|windows/i },
  { key: 'approval', label: '审批', re: /approval|permission|auto_?review|tool_?ask|ask_?before|escalation/i },
  // 词边界很重要：不用 \bfs 的话，offset / selfsigned 这类词也会被算进沙箱。
  { key: 'sandbox', label: '沙箱', re: /sandbox|\bfs[_-]|filesystem|file_?write|confine|\bdeny/i },
  { key: 'identity', label: '身份', re: /identity|persona|surface|intro|context|prompt|instruction|workspace/i },
  { key: 'tools', label: '工具', re: /tool|hook|subagent|bash|shell|repeat|prune|skill|todo/i },
  { key: 'ui', label: '界面', re: /client|ui_|composer|chat|rewind|session|badge|connection|boot/i },
]

function patchLayer(row) {
  const hay = `${row.name || ''} ${row.pkg || ''}`
  for (const rule of LAYER_RULES) if (rule.re.test(hay)) return rule
  return { key: 'other', label: '其他' }
}

/**
 * 按用途汇总。patchInfo（工具路径）和 statusText（面板路径）都要用，
 * 所以抽出来一处算——两边各算一遍迟早会算出两个数。
 */
function layerSummary(rows) {
  const out = []
  const index = new Map()
  for (const r of rows || []) {
    const layer = patchLayer(r)
    if (!index.has(layer.key)) {
      // partial 从一开始就给 0：字段稳定出现，schema 声明才有意义，
      // 调用方也不用区别「没有 partial」和「这一层不存在」
      const g = { key: layer.key, label: layer.label, total: 0, ok: 0, need: 0, skip: 0, partial: 0 }
      index.set(layer.key, g)
      out.push(g)
    }
    const g = index.get(layer.key)
    g.total += 1
    // 分层小计按「这次真改完了」算，partial 单列——它和面板四档用的是同一套分法，
    // 不然会出现「这一层 2/2 生效」而面板说「1 条只改了一部分」。
    if (r.status === 'applied') g.ok += 1
    else if (r.status === 'partial') g.partial = (g.partial || 0) + 1
    else if (r.status === 'no_pkg' || r.status === 'no_needle') g.skip += 1
    else g.need += 1
  }
  return out
}
function statusText(snap) {
  const lines = []
  if (patchesBroken(snap)) lines.push(...brokenLines(snap))
  lines.push(
    '【注入层】',
    `  开关：${snap.enabled ? '开' : '关'}`,
    `  正文：${snap.bytes} 字节 / ${snap.chars} 字 · 来源 ${snap.sourceLabel}`,
    `  变体：${snap.variant}${snap.last?.model ? ` · 模型 ${snap.last.model}` : ''}`,
    `  主文件：${snap.injectPath}${snap.injectExists ? '' : '（缺失，将用包内默认正文）'}`,
    `  其它变体：${snap.variants.length ? snap.variants.map((v) => v.name).join(', ') : '无'}`,
  )
  const byModel = Object.entries(snap.byModel || {})
  if (byModel.length) lines.push(`  按模型指定：${byModel.map(([m, v]) => `${m}→${v}`).join(', ')}`)
  const dropped = snap.last?.dropped || []
  if (dropped.length) lines.push(`  上次组装压掉的官方段：${dropped.join(', ')}`)
  if (snap.truncated) lines.push('  注意：正文超过配置上限，已截断。')

  lines.push('')
  const p = snap.patches || {}
  lines.push('【补丁层】')
  if (p.ok) {
    const t = p.tally || {}
    const order = ['applied', 'partial', 'hit', 'drifted', 'miss', 'no_needle', 'no_file', 'no_pkg']
    const label = {
      applied: '已生效', partial: '部分命中', hit: '待应用', drifted: '被覆盖',
      miss: '未命中', no_needle: '无目标句', no_file: '文件缺失', no_pkg: '包不存在',
    }
    // patchSnapshot() 只给 rows/tally/total，没有 applicable——这里现算，
    // 免得面板走 view.js 那条路径时因为缺字段把「手机适用 86」报错。
    const noPkg = Number(t.no_pkg) || 0
    const applicable = Number(p.applicable) || Math.max(0, (Number(p.total) || 0) - noPkg)
    lines.push(`  引擎：${p.root || '未知'}`)
    // 分母用「手机适用」而不是全部补丁：面板显示的就是这个口径（58/58）。
    // 写成 58/84 会让读的人以为有 26 条没打上，其实那 26 条是桌面专属包，手机上根本没有。
    lines.push(
      `  合计：${t.applied || 0}/${applicable} 已生效` +
        (noPkg ? `（另有 ${noPkg} 条是桌面专属包，手机不适用）` : ''),
    )
    const parts = order.filter((k) => t[k]).map((k) => `${label[k]} ${t[k]}`)
    if (parts.length) lines.push(`  分布：${parts.join(' · ')}`)

    // 部分命中单独说清楚——它不在「未生效明细」里（不算问题），但如果一字不提，
    // 读者只看到分布里的「部分命中 2」，会自己去猜原因，猜出来的往往像出了故障。
    const partials = Array.isArray(p.partials)
      ? p.partials
      : (p.rows || [])
          .filter((r) => r.status === 'partial')
          .sort((a, b) => a.id - b.id)
          .map((r) => ({ id: r.id, name: r.name, hits: Number(r.hits) || 0, total: Number(r.total) || 0 }))
    if (partials.length) {
      lines.push('')
      lines.push(
        `  另有 ${partials.length} 条「只改了一部分」，需要人看一眼。`,
      )
      lines.push('      补丁表里每条写了几套不同引擎版本的写法，你的引擎只有其中一套；')
      lines.push('      剩下那几处要是在本机也不存在，就是正常；要是在本机存在但写法不同，那就是真没改到。')
      for (const r of partials) {
        // hits 的语义是「还剩几处没改到位」，不是「命中几处」（见 core.mjs 的 probe）。
        // 以前这里写成「hits/total 套写法命中」，和 CLI 的 (total-hits)/total 正好相反。
        lines.push(`      ${String(r.id).padStart(2)}.${r.name}  （还剩 ${Number(r.hits)} 处没改到位，共 ${r.total} 处写法）`)
      }
    }

    // 为什么没打上——逐条给原因，没有未生效项就不出现这一段
    // 同理，pending 也可能没被外层算好（view.js 的 patchSnapshot 只给 rows）。
    const pending = Array.isArray(p.pending)
      ? p.pending
      : (p.rows || [])
          .filter((r) => ['miss', 'no_needle', 'no_file', 'drifted'].includes(r.status))
          .sort((a, b) => a.id - b.id)
          .map((r) => ({ id: r.id, name: r.name, status: r.status, pkg: String(r.pkg || '') }))
    if (pending.length) {
      lines.push('')
      lines.push('  未生效明细：')
      for (const r of pending) {
        lines.push(`    ${String(r.id).padStart(2)}.${r.name}  [${label[r.status] || r.status}]`)
        lines.push(`        ${patchReason(r)}`)
        lines.push(`        → ${patchAdvice(r)}`)
      }
    }

    // 按「管什么」给个概览：86 条平铺时看不出哪块有问题，分组后一眼能扫。
    // 只统计、不重复列条目——明细已经在上面给过了。
    // 两条路径拿到的字段不一样：面板直接给 rows，工具路径给预先算好的 layers。
    // 谁有就用谁，都没有就不显示这一段。
    const layers = Array.isArray(p.layers) && p.layers.length ? p.layers : layerSummary(p.rows)
    if (layers.length > 1) {
      lines.push('')
      lines.push('  按用途分：')
      for (const g of layers) {
        // 整组都打不上、又都是「手机没这个包」时，直接说结论，别写成 0/N 生效——
        // 那个写法看着像出事，其实是这台机器上用不到。
        if (!g.ok && !g.need && g.skip === g.total) {
          lines.push(`    ${g.label}  ${g.total} 条，手机不适用`)
          continue
        }
        const bits = []
        if (g.need) bits.push(`${g.need} 条要处理`)
        if (g.partial) bits.push(`${g.partial} 条只改了一部分`)
        if (g.skip) bits.push(`${g.skip} 条不用管`)
        lines.push(`    ${g.label}  ${g.ok}/${g.total} 生效${bits.length ? '（' + bits.join('，') + '）' : ''}`)
      }
    }
  } else {
    lines.push(`  读不到：${p.error || '未扫描'}`)
  }
  return lines.join('\n')
}

/**
 * @param {any} ctx 已经 inject(['tools']) 的 ctx
 * @param {{ home: string, config: any, warn: (message: string) => void }} deps
 */
export function registerTools(ctx, deps) {
  const tools = ctx.tools
  if (!tools || typeof tools.register !== 'function') return 0
  const { home, config, warn } = deps
  const snap = () => snapshot(home, config)
  let count = 0

  const register = (definition) => {
    try {
      tools.register(definition)
      count += 1
    } catch (error) {
      // 同名工具（同机装了桌面版 dsh-purge）只警告，不拖垮整插件加载
      warn(`工具 ${definition.name} 注册失败：${error?.message || error}`)
    }
  }

  register({
    name: 'purge_status',
    description: '查看破甲两层状态。注入层：开关、正文来源与体积、变体、按模型指定、上次组装压掉哪些官方段。补丁层：引擎路径、补丁总数的生效数与状态分布（已生效/部分命中/待应用/未命中/无目标句/文件缺失/包不存在），以及没生效的那几条分别为什么。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => text(statusText({ ...snapshot(home, config), patches: value?.patches })),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute() {
      const current = snap()
      const patches = patchInfo()
      return {
        enabled: current.enabled,
        bytes: current.bytes,
        chars: current.chars,
        source: current.sourceLabel,
        variant: current.variant,
        model: current.last?.model || '',
        variants: current.variants.length,
        injectPath: current.injectPath,
        injectExists: current.injectExists,
        dropped: current.last?.dropped || [],
        home: current.home,
        patches,
        // 现成的一段话：模型拿到结构化 JSON 时常常只念数字、不解释原因，
        // 这里把「哪条、什么状态、为什么」直接写成文本，让它有东西可抄。
        summary: pendingSummary(patches),
        // 历史清洗的两个前提：补丁在（scrubPatch）、钩子挂上（scrubHook）。
        // 只报一句「开着」没法排障——0.7.4 里这两件事分别可能被 App 更新和插件加载失败破坏。
        scrubHook: typeof globalThis.__dshPurgeScrub === 'function',
        scrubPatch: (() => {
          try {
            const src = readFileSync(join(patches?.root || '', 'dsh-session', 'lib', 'index.js'), 'utf8')
            return src.includes('[dsh-purge] history scrub hook')
          } catch { return false }
        })(),
        // 单独拎出来的一句话，模型最不容易漏——它转述结构化 JSON 时经常漏掉细节
        verdict: patchVerdict(patches),
      }
    },
  })

  register({
    name: 'purge_apply',
    description: '开启破甲（提示词注入）并确保 $DSH_HOME/prompt-inject.md 有正文（缺失时落盘包内默认正文；force=true 覆盖重写）。**不涉及补丁层**——要打补丁请在仓库目录跑 `node patches/purge-patch.mjs apply`，或点输入框上方的胶囊看补丁状态。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { force: { type: 'boolean', description: '覆盖已有的 prompt-inject.md' } },
    },
    output: {
      schema: APPLY_SCHEMA,
      render: (_args, value) => text(value.message),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute(args) {
      const seeded = seed(home, { force: args?.force === true })
      setEnabled(home, true)
      const current = snap()
      return {
        ok: true,
        enabled: true,
        written: seeded.written,
        bytes: current.bytes,
        message: `破甲已开启。${seeded.written ? '已写入默认正文' : '沿用现有正文'}：${current.bytes} 字节。`,
      }
    },
  })

  register({
    name: 'purge_revert',
    description: '关闭破甲（提示词注入），并把当前 $DSH_HOME/prompt-inject.md 备份到 dsh-purge/backups/（正文本身保留）。**不涉及补丁层**——要还原补丁请在仓库目录跑 `node patches/purge-patch.mjs restore`。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: APPLY_SCHEMA,
      render: (_args, value) => text(value.message),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute() {
      const result = revert(home)
      return {
        ok: true,
        enabled: false,
        written: false,
        bytes: snapshot(home, config).bytes,
        message: result.backup ? `破甲已关闭，正文已备份到 ${result.backup}。` : '破甲已关闭（当前没有正文可备份）。',
      }
    },
  })

  register({
    name: 'purge_prompt',
    description: `读取/写入注入正文与变体。action：show（看正文与来源）、set（写 prompt-inject.md，≤${MAX_PROMPT_CHARS} 字）、reset（重写包内默认正文）、use（切换变体）、default（回默认变体）、map（按模型指定变体）。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['show', 'set', 'reset', 'use', 'default', 'map'] },
        text: { type: 'string', description: 'action=set 时的正文' },
        name: { type: 'string', description: '变体名（不带 .md）；action=map 时为空表示取消该模型的指定' },
        model: { type: 'string', description: 'action=map 时的模型名' },
      },
      required: ['action'],
    },
    output: {
      schema: PROMPT_SCHEMA,
      render: (_args, value) => text(value.preview ? `${value.message}\n\n${value.preview}` : value.message),
      presentationMeta: toolCard(() => promptCard(snap()), { onError: warn }),
    },
    async execute(args) {
      const action = String(args?.action || 'show')
      const current = () => snap()
      if (action === 'set') {
        const written = setPrompt(home, args?.text)
        const now = current()
        return { ok: true, action, message: `已写入正文：${written.bytes} 字节 → ${written.path}`, bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'reset') {
        seed(home, { force: true })
        const now = current()
        return { ok: true, action, message: `已重写包内默认正文：${now.bytes} 字节`, bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'use') {
        const used = useVariant(home, args?.name)
        const now = current()
        return { ok: true, action, message: `已切到变体 ${used.variant}（${now.bytes} 字节）`, bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'default') {
        resetVariant(home)
        const now = current()
        return { ok: true, action, message: '已回到默认变体', bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'map') {
        const mapped = mapModel(home, args?.model, args?.name)
        const now = current()
        return {
          ok: true,
          action,
          message: mapped.variant ? `已把模型 ${mapped.model} 指定到变体 ${mapped.variant}` : `已取消模型 ${mapped.model} 的指定`,
          bytes: now.bytes,
          chars: now.chars,
          variant: now.variant,
          variants: now.variants.map((v) => v.name),
          preview: '',
          maxChars: MAX_PROMPT_CHARS,
        }
      }
      const now = current()
      return {
        ok: true,
        action: 'show',
        message: `破甲${now.enabled ? '开' : '关'} · ${now.bytes} 字节 / ${now.chars} 字 · 来源 ${now.sourceLabel} · 变体 ${now.variant}`,
        bytes: now.bytes,
        chars: now.chars,
        variant: now.variant,
        variants: now.variants.map((v) => v.name),
        preview: now.text.slice(0, 1200),
        maxChars: MAX_PROMPT_CHARS,
      }
    },
  })

  register({
    name: 'purge_category',
    description:
      '题材分类扩展层（Scoped Rules 26+ 与意图映射扩展行）。action：list（全部条目与生效状态）、add（加一条，需 id/别名/规则正文）、rm（删一条）、on/off（单条开关）、reset（清空覆盖层回出厂）、bake（把当前分类写进 prompt-inject.md）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'rm', 'on', 'off', 'reset', 'bake'] },
        id: { type: 'string', description: '分类 id（小写字母/数字/-/_）' },
        labels: { type: 'string', description: 'action=add 时的别名，逗号分隔，例如「未成年,幼,萝莉」' },
        rule: { type: 'string', description: 'action=add 时的规则正文（写进 Scoped Rules）' },
        route: { type: 'string', description: 'action=add 时的意图映射目标，例如「adult (Scoped Rule 9)」' },
      },
      required: ['action'],
    },
    output: {
      schema: CATEGORY_SCHEMA,
      render: (_args, value) => text(value.message),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute(args) {
      const action = String(args?.action || 'list')
      const brief = (entries) =>
        entries.map((entry) => `${entry.n}. ${entry.id} · ${entry.labels.join('/')}${entry.route ? ` → ${entry.route}` : ''}`).join('\n')
      if (action === 'add') {
        const added = categoryAdd(home, {
          id: args?.id,
          labels: args?.labels,
          rule: args?.rule,
          route: args?.route,
        })
        return {
          ok: true,
          action,
          count: added.entries.length,
          entries: added.entries.map((entry) => entry.id),
          message: `已加分类 ${added.entry.n}. ${added.entry.id}（${added.entry.labels.join('/')}）。\n当前 ${added.entries.length} 条生效：\n${brief(added.entries)}`,
        }
      }
      if (action === 'rm') {
        const removed = categoryRemove(home, args?.id)
        return {
          ok: true,
          action,
          count: removed.entries.length,
          entries: removed.entries.map((entry) => entry.id),
          message: removed.removed ? `已删分类 ${args?.id}，剩 ${removed.entries.length} 条生效。` : `没有这个分类：${args?.id}`,
        }
      }
      if (action === 'on' || action === 'off') {
        const toggled = categoryToggle(home, args?.id, action === 'on')
        return {
          ok: true,
          action,
          count: toggled.entries.length,
          entries: toggled.entries.map((entry) => entry.id),
          message: `分类 ${args?.id} 已${action === 'on' ? '开' : '关'}。\n当前 ${toggled.entries.length} 条生效：\n${brief(toggled.entries)}`,
        }
      }
      if (action === 'reset') {
        const list = categoryReset(home)
        return { ok: true, action, count: list.entries.length, entries: list.entries.map((entry) => entry.id), message: `覆盖层已清空，回到出厂分类（${list.entries.length} 条）。` }
      }
      if (action === 'bake') {
        const baked = categoryBake(home)
        return { ok: true, action, count: baked.categories, entries: [], message: `已把 ${baked.categories} 条分类写进正文：${baked.bytes} 字节 → ${baked.path}` }
      }
      const list = categoryList(home)
      return {
        ok: true,
        action: 'list',
        count: list.entries.length,
        entries: list.all.map((entry) => entry.id),
        message: `题材分类 ${list.entries.length}/${list.all.length} 生效：\n${list.all
          .map((entry) => `${entry.enabled ? '·' : 'x'} ${entry.n}. ${entry.id} · ${entry.labels.join('/')}${entry.route ? ` → ${entry.route}` : ''}`)
          .join('\n')}`,
      }
    },
  })

  register({
    name: 'purge_patch_apply',
    description:
      '重打或还原引擎补丁层。App 更新会重装引擎包、把补丁冲掉，这时用 apply 一条命令重打。打完需要重启引擎才生效。restore 走最近一次备份还原；probe 只看当前分布、不改文件。全新安装如果没打过硬补丁，也用它。**apply 成功后，除了说重启，还要提醒用户：以后更新 App 会覆盖补丁层，到时候重跑一次 apply 就行。**',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['apply', 'restore', 'probe'],
          description: 'apply 打补丁（默认）/ restore 还原到上次备份 / probe 只看状态不动文件',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          message: { type: 'string' },
          tail: { type: 'string' },
          restartRequired: { type: 'boolean' },
        },
      },
      render: (_args, value) => text(value.message + (value.tail ? `\n\n${value.tail}` : '')),
    },
    async execute(args) {
      const mode = ['apply', 'restore', 'probe'].includes(args?.mode) ? args.mode : 'apply'
      // restore 必须带一份具体备份：purge-patch.mjs 的 restore 要求 --backup，
      // 不传就 core.restore 直接抛 "restore needs a backup directory"。
      // 以前这里只传 mode，「还原补丁」这个入口从来没成功过，还被标成 restore_partial。
      let backupArgs = []
      if (mode === 'restore') {
        const got = (() => {
          try {
            const root = detectRoot()
            return findReusableBackup(dshHome(), engineVersion(root))
          } catch { return null }
        })()
        if (!got || !got.dir) {
          return {
            ok: false, mode, restartRequired: false,
            message: '没有可还原的补丁备份。\n'
              + '备份只在「一键注入」或 install.sh 打补丁时创建；如果你是从市场装的、或者从没打过补丁，'
              + '就没有备份可还原。要撤销补丁请重装引擎包（README 第 6 章）。',
            tail: '',
          }
        }
        backupArgs = ['--backup', got.dir]
      }
      const { code, stdout, stderr } = await runPatchScript(mode, backupArgs)
      const ok = code === 0
      const lines = stdout.trim().split('\n').filter(Boolean)
      const tail = lines.slice(-4).join('\n')
      const head =
        mode === 'apply'
          ? ok ? '补丁已重打' : '打补丁失败'
          : mode === 'restore'
            ? ok ? '补丁已还原' : '还原失败'
            : ok ? '补丁分布（未改动）' : '扫描失败'
      const hint = mode === 'probe' ? '' : ok ? '\n重启引擎才生效：从最近任务里把 App 划掉再打开' : `\n${stderr.slice(0, 300)}`
      // 打完必须让用户知道补丁不是永久的——更新 App 会重装引擎包，把改过的源码盖回去。
      // 这句写进返回值而不是只写文档，因为用户是让模型装的，模型转述什么用户就看到什么。
      const warn =
        ok && mode === 'apply'
          ? '\n\n**把下面这句原话告诉用户**：以后更新 dsh-go App 会重装引擎包、把补丁层整个冲掉，' +
            '到时候重跑一次 apply 就行，插件和配置都不用重新装。'
          : ''
      invalidatePatches()
      return { ok, mode, message: `${head}${hint}${warn}`, tail, restartRequired: mode !== 'probe' && ok }
    },
  })

  return count
}





