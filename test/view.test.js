import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { snapshot, panelView, promptView, statusCard, promptCard, stripData } from '../lib/view.js'
import { writeState, setModelVariant } from '../lib/state.js'
import { writeVariant } from '../lib/prompt.js'
import { jsonBytes } from '../lib/card.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'purge-go-view-'))
}

/** 访问所有子节点（含 actions/options 这类无 type 的条目），供读取 .action 用。 */
function visitAll(node, visit) {
  if (!node || typeof node !== 'object') return
  if (!Array.isArray(node)) visit(node)
  const children = Array.isArray(node) ? node : node.children
  if (Array.isArray(children)) for (const child of children) visitAll(child, visit)
  if (Array.isArray(node.items)) for (const item of node.items) if (item && typeof item === 'object') visitAll(item, visit)
}

/** 组件计数只算带 type 的节点与它们真正的子节点（动作条目不是组件）。 */
function collect(node) {
  const nodes = []
  let depth = 0
  const walkNode = (current, level) => {
    if (!current || typeof current !== 'object') return
    nodes.push(current)
    depth = Math.max(depth, level)
    if (Array.isArray(current.children)) for (const child of current.children) walkNode(child, level + 1)
    if (Array.isArray(current.items)) for (const item of current.items) if (item && typeof item === 'object' && item.type) walkNode(item, level + 1)
  }
  walkNode(node, 0)
  return { nodes, depth }
}

function actionsOf(view) {
  const actions = new Set()
  visitAll(view, (node) => {
    if (node.action) actions.add(typeof node.action === 'string' ? node.action : node.action.id)
  })
  return actions
}

test('stripData：≤24 字，开关映射到色调', () => {
  const home = tempHome()
  writeState(home, { enabled: true })
  const on = stripData(snapshot(home), 'zh')
  assert.ok(on.text.length <= 24, on.text)
  assert.equal(on.tone, 'good')

  writeState(home, { enabled: false })
  const off = stripData(snapshot(home), 'zh')
  assert.equal(off.tone, 'muted')
})

test('panelView：预算内、动作全部有 handler、根是 stack', () => {
  const home = tempHome()
  writeState(home, { enabled: true })
  writeVariant(home, 'tight', 'TIGHT')
  setModelVariant(home, 'vendor_model', 'tight')

  const view = panelView(snapshot(home), { locale: 'zh' })
  assert.equal(view.type, 'stack')
  assert.ok(jsonBytes(view) < 32 * 1024, `视图 ${jsonBytes(view)} 字节`)

  const { nodes, depth } = collect(view)
  assert.ok(nodes.length <= 120, `节点 ${nodes.length}`)
  assert.ok(depth <= 8, `层数 ${depth}`)

  const actions = actionsOf(view)
  visitAll(view, (node) => {
    if (node.type === 'text') assert.ok(String(node.text).length <= 2000)
  })
  // 按**面板作用域**校验：每个面板的 actions 里出现的 id，必须在该面板自己的 handler 表里。
  // 用全局白名单会让「seed 挪到正文面板但破甲面板还留着同名 handler」这种死代码照样全绿。
  const PURGE_HANDLERS = new Set(['toggle', 'reload', 'patchApply', 'patchRevert', 'use', 'unmap', 'seed', 'revert'])
  const PROMPT_HANDLERS = new Set(['copy', 'toggle', 'seed', 'revert'])
  const purgeActions = actionsOf(view)
  for (const action of purgeActions) {
    assert.ok(PURGE_HANDLERS.has(action), `破甲面板用了未注册的动作 ${action}`)
  }
  assert.ok(purgeActions.has('toggle'))
  assert.ok(purgeActions.has('patchApply'), '破甲面板必须有应用补丁入口')

  // 正文面板独立校验
  const pv = promptView(snapshot(home), { locale: 'zh' })
  const promptActions = actionsOf(pv)
  for (const action of promptActions) {
    assert.ok(PROMPT_HANDLERS.has(action), `正文面板用了未注册的动作 ${action}`)
  }
  assert.ok(promptActions.has('seed'), '正文面板要有落盘默认入口')
  assert.ok(promptActions.has('revert'), '正文面板要有关闭并备份入口')
})

test('promptView：正文预览被截断到 1800 字以内', () => {
  const home = tempHome()
  writeState(home, { enabled: true })
  const view = promptView(snapshot(home), { locale: 'zh' })
  const texts = []
  visitAll(view, (node) => {
    if (node.type === 'text') texts.push(node.text)
  })
  assert.equal(texts.length, 1)
  assert.ok(texts[0].length <= 1801)
  assert.ok(jsonBytes(view) < 32 * 1024)
})

test('statusCard / promptCard：工具卡预算 8 KiB、节点 ≤40', () => {
  const home = tempHome()
  writeState(home, { enabled: true })
  for (const card of [statusCard(snapshot(home), 'zh'), promptCard(snapshot(home), 'zh')]) {
    assert.ok(jsonBytes(card) <= 8 * 1024, `卡片 ${jsonBytes(card)} 字节`)
    const { nodes, depth } = collect(card)
    assert.ok(nodes.length <= 40, `节点 ${nodes.length}`)
    assert.ok(depth <= 6, `层数 ${depth}`)
    // 工具卡不能点：不允许出现动作
    assert.equal(actionsOf(card).size, 0)
  }
})

test('snapshot：缺文件时给出 builtin 来源而不是空正文', () => {
  const home = tempHome()
  const snap = snapshot(home)
  assert.equal(snap.injectExists, false)
  assert.equal(snap.source, 'builtin')
  assert.ok(snap.bytes > 0)
})
