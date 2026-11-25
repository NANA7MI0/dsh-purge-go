import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { snapshot, statusCard, promptCard, stripData } from '../lib/view.js'
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
