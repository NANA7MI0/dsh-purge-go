import test from 'node:test'
import assert from 'node:assert/strict'

import { rewriteAssembly, isMine, isConflict, INJECT_SECTION, rememberAssembly, lastAssembly } from '../lib/assemble.js'

const section = (name, text) => ({ name, text, interpolate: false })

const assembly = () => ({
  sections: [
    section('harness:identity', 'official identity'),
    section('tools', 'tool docs'),
    section('dsh-purge', 'old body'),
    section('dshpg-capabilities', 'cap'),
    section('deployment:persona-prefix', 'persona head'),
    section('deployment:persona-suffix', 'persona tail'),
    section('agent:instructions', 'agent docs'),
  ],
  contexts: [],
  tools: [],
  variables: { model: 'm' },
})

test('isMine / isConflict 判定', () => {
  assert.equal(isMine('dsh-purge'), true)
  assert.equal(isMine('dsh-purge:post'), true)
  assert.equal(isMine('dshpg-capabilities'), false)
  assert.equal(isConflict('harness:identity'), true)
  assert.equal(isConflict('deployment:persona-prefix'), true)
  assert.equal(isConflict('tools'), false)
})

test('rewriteAssembly：自家段提到最前，冲突段丢掉，其余保序', () => {
  const out = rewriteAssembly(assembly(), { injectText: 'NEW BODY', dropConflicts: true })
  const names = out.sections.map((entry) => entry.name)

  assert.deepEqual(names, [INJECT_SECTION, 'dshpg-capabilities', 'tools', 'agent:instructions'])
  assert.equal(out.sections[0].text, 'NEW BODY')
  assert.equal(out.__dropped.includes('harness:identity'), true)
})

test('rewriteAssembly：dropConflicts=false 时保留官方身份段', () => {
  const out = rewriteAssembly(assembly(), { injectText: 'NEW BODY', dropConflicts: false })
  const names = out.sections.map((entry) => entry.name)
  assert.equal(names.includes('harness:identity'), true)
  assert.equal(names[0], INJECT_SECTION)
})

test('rewriteAssembly：没有自家段时插入到最前', () => {
  const out = rewriteAssembly({ sections: [section('tools', 'x')], variables: {} }, { injectText: 'BODY' })
  assert.equal(out.sections[0].name, INJECT_SECTION)
  assert.equal(out.sections.at(-1).name, 'tools')
})

test('rewriteAssembly：重复的注入段只留一个', () => {
  const out = rewriteAssembly({ sections: [section('dsh-purge', 'a'), section('dsh-purge', 'b')] }, { injectText: 'ONLY' })
  assert.equal(out.sections.filter((entry) => entry.name === INJECT_SECTION).length, 1)
  assert.equal(out.sections[0].text, 'ONLY')
})

test('rewriteAssembly：脏数据不炸', () => {
  assert.equal(rewriteAssembly(null), null)
  const out = rewriteAssembly({ sections: [null, undefined, 'x', section('tools', 't')] }, { injectText: 'B' })
  assert.equal(out.sections.length, 2)
})

test('rememberAssembly / lastAssembly 记录最后一次', () => {
  rememberAssembly({ enabled: true, bytes: 12, source: 'builtin' })
  const last = lastAssembly()
  assert.equal(last.bytes, 12)
  assert.equal(last.enabled, true)
  assert.ok(last.at)
})
