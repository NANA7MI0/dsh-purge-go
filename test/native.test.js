// dsh-go 原生界面：清单里声明的东西，代码里必须真注册；视图必须在预算内；
// 视图里出现的每个动作 id 都必须有 handler（点下去不能是死的）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.js'
import { readState, setEnabled } from '../lib/state.js'
import { injectPath } from '../lib/home.js'
import { stripData } from '../lib/view.js'

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'purge-go-native-'))
}

/** 最小 dsh-go 桥接：把注册记下来，refresh 记次数。 */
function fakeBridge() {
  const record = { strips: new Map(), panels: new Map(), handlers: new Map(), refreshes: 0 }
  const dshGo = {
    bridge: '0.4.0',
    refresh: () => {
      record.refreshes += 1
    },
    strip: (id, producer) => record.strips.set(id, producer),
    panel: (id, options) => record.panels.set(id, options),
    on: (id, handler) => record.handlers.set(id, handler),
  }
  return { record, dshGo }
}

function host(home) {
  const { record, dshGo } = fakeBridge()
  const base = {
    systemPrompt: { section: () => {} },
    on: () => {},
    inject: (names, callback) => {
      const scoped = {}
      for (const name of names) {
        scoped[name] =
          name === 'dshGo'
            ? dshGo
            : name === 'tools'
              ? { register: () => {} }
              : { register: () => {} }
      }
      callback({ ...base, ...scoped })
      return () => {}
    },
  }
  apply(base, { home })
  return record
}

/** 只统计真正的组件节点（带 type），并给出深度。 */
function budget(node) {
  let nodes = 0
  let depth = 0
  const walk = (current, level) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return
    if (typeof current.type === 'string') {
      nodes += 1
      depth = Math.max(depth, level)
    }
    if (Array.isArray(current.children)) for (const child of current.children) walk(child, level + 1)
    if (Array.isArray(current.items)) for (const item of current.items) walk(item, level + 1)
  }
  walk(node, 0)
  return { nodes, depth, bytes: Buffer.byteLength(JSON.stringify(node), 'utf8') }
}

function actionIds(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) actionIds(item, out)
    return out
  }
  if (node.action) out.add(typeof node.action === 'string' ? node.action : node.action.id)
  if (typeof node.id === 'string' && node.type === 'confirm') out.add(node.id)
  for (const key of ['children', 'items']) actionIds(node[key], out)
  return out
}

test('清单与注册一致：胶囊 / 状态条 / 面板 / 加号工具 / 会话动作都真的注册了', () => {
  const record = host(tempHome())
  const contributes = pkg.dshGo.contributes

  assert.equal(contributes['composer.actions'].length, 2)
  assert.equal(contributes['composer.strip'].length, 1)
  assert.equal(contributes.panels.length, 4)
  assert.equal(contributes['composer.tools'].length, 2)
  assert.equal(contributes['session.actions'].length, 1)

  // 状态条：清单里声明的那一条要有数据源
  for (const item of contributes['composer.strip']) assert.ok(record.strips.has(item.id), `状态条 ${item.id} 没有数据源`)

  // 面板：清单里每一个都要有 view + actions
  for (const item of contributes.panels) {
    const panel = record.panels.get(item.id)
    assert.ok(panel, `面板 ${item.id} 没有注册`)
    assert.equal(typeof panel.view, 'function')
  }

  // 没有静态 effect 的按钮，必须有 on(id) handler，否则点下去是死的
  const handlers = new Set(record.handlers.keys())
  for (const surface of ['composer.actions', 'composer.tools', 'session.actions']) {
    for (const item of contributes[surface]) {
      if (item.effect || item.panel) continue
      assert.ok(handlers.has(item.id), `${surface} 的 ${item.id} 没有 handler`)
    }
  }
})

test('id 全插件唯一、标签不超各自上限', () => {
  const ids = []
  const labelLimit = { 'composer.actions': 10, 'composer.tools': 8, 'session.actions': 12 }
  for (const [surface, items] of Object.entries(pkg.dshGo.contributes)) {
    for (const item of items) {
      ids.push(item.id)
      if (labelLimit[surface]) {
        const label = typeof item.label === 'string' ? item.label : item.label.zh
        assert.ok(label.length <= labelLimit[surface], `${item.id} 的标签超过 ${labelLimit[surface]} 字：${label}`)
      }
      if (surface === 'panels') {
        const title = typeof item.title === 'string' ? item.title : item.title.zh
        assert.ok(title.length <= 16, `${item.id} 的标题超过 16 字`)
      }
      if (surface === 'composer.strip') {
        const text = typeof item.text === 'string' ? item.text : item.text.zh
        assert.ok(text.length <= 24, `${item.id} 的静态文字超过 24 字`)
      }
    }
  }
  assert.equal(new Set(ids).size, ids.length, `id 重复：${ids.join(', ')}`)
})

test('四个面板：预算内（≤32 KiB / ≤120 节点 / ≤8 层）、动作全部有 handler', () => {
  const home = tempHome()
  const record = host(home)
  for (const [id, panel] of record.panels) {
    const view = panel.view({}, { protocol: 1, app: '0.4.0', locale: 'zh-CN', surfaces: [], components: [] })
    const size = budget(view)
    assert.ok(size.bytes <= 32 * 1024, `${id} 视图 ${size.bytes} 字节`)
    assert.ok(size.nodes <= 120, `${id} 视图 ${size.nodes} 个节点`)
    assert.ok(size.depth <= 8, `${id} 视图 ${size.depth} 层`)
    for (const action of actionIds(view)) {
      assert.ok(panel.actions[action], `${id} 的动作 ${action} 没有 handler`)
    }
  }
})

test('状态条：≤24 字、带色调、能停', () => {
  const home = tempHome()
  const record = host(home)
  const producer = record.strips.get('purge-strip')
  const emitted = []
  const stop = producer({}, (value) => emitted.push(value), { protocol: 1, locale: 'zh-CN' })
  assert.equal(emitted.length, 1)
  assert.ok(emitted[0].text.length <= 24, emitted[0].text)
  assert.equal(emitted[0].tone, 'good')
  assert.equal(typeof stop, 'function')
  stop()
})

test('stripData：补丁摘要拼进来也不超 24 字，旧签名兼容', () => {
  const snap = { enabled: true, bytes: 40 * 1024, chars: 100 }
  const withPatch = stripData(snap, { applied: 40, total: 87 }, 'zh')
  assert.ok(withPatch.text.length <= 24, withPatch.text)
  const legacy = stripData(snap, 'en')
  assert.equal(legacy.text.startsWith('on'), true)
})

test('胶囊「注入」：翻转注入层并把状态条叫醒', async () => {
  const home = tempHome()
  const record = host(home)
  setEnabled(home, true)
  const before = record.refreshes
  const handler = record.handlers.get('purge-toggle')

  await handler({}, { surface: 'composer.actions', id: 'purge-toggle', locale: 'zh' })
  assert.equal(readState(home).enabled, false)
  assert.ok(record.refreshes > before, '状态条要重新取数据')

  await handler({}, { surface: 'composer.actions', id: 'purge-toggle', locale: 'zh' })
  assert.equal(readState(home).enabled, true)
})

test('会话动作「破甲报告」：复制的是真的正文摘要，不是模板', async () => {
  const home = tempHome()
  const record = host(home)
  const handler = record.handlers.get('purge-report')
  const effects = await handler({ sessionId: 's1' }, { surface: 'session.actions', id: 'purge-report', locale: 'zh' })
  assert.equal(typeof effects.copy, 'string')
  assert.match(effects.copy, /破甲报告/)
  assert.match(effects.copy, /注入：开/)
  assert.ok(effects.copy.length < 8000)
})

test('补丁面板：取消不执行；确认后按真实结果回话（假引擎目录，绝不碰本机引擎）', async () => {
  const home = tempHome()
  const fakeRoot = tempHome() // 空目录：没有任何 @deepseek-ai 包，写不到本机引擎
  const record = host(home)
  const panel = record.panels.get('purge-patches')

  const cancelled = await panel.actions.patchApply({}, { value: { confirmed: false }, locale: 'zh' })
  assert.equal(cancelled.toast, '已取消')

  const before = process.env.DSH_AI_ROOT
  process.env.DSH_AI_ROOT = fakeRoot
  try {
    const applied = await panel.actions.patchApply({}, { value: { confirmed: true }, locale: 'zh' })
    assert.equal(typeof applied.toast, 'string')
    assert.ok(applied.toast.length <= 40, applied.toast)
    assert.equal(applied.refresh, true)
    // 空引擎目录里一条都打不上，必须说实话，不能报「成功」
    assert.match(applied.toast, /没有新补丁|失败/)

    const reverted = await panel.actions.patchRevert({}, { value: { confirmed: true }, locale: 'zh' })
    assert.match(reverted.toast, /失败|没有/)
    assert.equal(reverted.refresh, true)
  } finally {
    if (before === undefined) delete process.env.DSH_AI_ROOT
    else process.env.DSH_AI_ROOT = before
  }
})

test('正文面板：复制正文截断到 8000 字以内；开关真的改状态', async () => {
  const home = tempHome()
  const record = host(home)
  const panel = record.panels.get('purge-prompt')
  fs.writeFileSync(injectPath(home), 'X'.repeat(20_000), 'utf8')

  const copied = await panel.actions.copy({}, { locale: 'zh' })
  assert.ok(copied.copy.length <= 8000, String(copied.copy.length))

  const before = readState(home).enabled
  await panel.actions.toggle({}, { locale: 'zh' })
  assert.equal(readState(home).enabled, !before)
})

test('题材分类面板：逐条开关 + 写进正文', async () => {
  const home = tempHome()
  const record = host(home)
  const panel = record.panels.get('purge-cats')
  const list = await panel.view({}, { locale: 'zh' })
  const size = budget(list)
  assert.ok(size.nodes <= 120)

  const baked = await panel.actions.catBake({}, { locale: 'zh' })
  assert.equal(baked.refresh, true)
  assert.match(baked.toast, /分类/)
})
