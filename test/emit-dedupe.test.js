import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSendOnce } from '../lib/dshgo.js'

// 这批测的是「内容没变就不发」。动机见 makeSendOnce 的注释：
// 正常状态下状态条和面板各每 30 秒重发同一份数据，App 那边什么都没变，
// 却在原生界面诊断里记「提示太频繁，已略过」。改完正常态应当完全静默。

test('同样的内容只发一次', () => {
  const send = makeSendOnce()
  const got = []
  const emit = (p) => got.push(p)

  send(emit, { text: '' })
  send(emit, { text: '' })
  send(emit, { text: '' })

  assert.equal(got.length, 1, '同一份内容连发三次，只应发出一次')
})

test('内容变了就发', () => {
  const send = makeSendOnce()
  const got = []
  const emit = (p) => got.push(p)

  send(emit, { text: '' })
  send(emit, { text: '破甲异常 · 点开处理', icon: 'warning', tone: 'warn' })
  send(emit, { text: '' })

  assert.equal(got.length, 3, '空 → 异常 → 空，三次都该发出来')
  assert.equal(got[1].text, '破甲异常 · 点开处理')
})

test('每个 emitter 各记各的', () => {
  const send = makeSendOnce()
  const a = []
  const b = []
  const ea = (p) => a.push(p)
  const eb = (p) => b.push(p)

  send(ea, { text: '' })
  // b 是另一个 emitter，即使内容相同也要发——它还没收到过
  send(eb, { text: '' })

  assert.equal(a.length, 1)
  assert.equal(b.length, 1, '新挂载的 emitter 首次必须发，否则界面是空的')
})

test('同一份内容重复发送只算一次', () => {
  const send = makeSendOnce()
  const got = []
  const emit = (p) => got.push(p)

  send(emit, { a: 1, b: 2 })
  send(emit, { a: 1, b: 2 })

  assert.equal(got.length, 1)
})

test('键顺序不同会被当成两份（多发一次，不会漏发）', () => {
  // 签名用的是 JSON.stringify，它认键顺序。所以 {a,b} 与 {b,a} 算两份。
  // 这是有意的取舍：判重的目的是「省掉没意义的重复」，不是「精确比较语义」。
  // 万一判错，代价只是多推一次（跟改之前一样），不会出现「变了却不发」。
  const send = makeSendOnce()
  const got = []
  const emit = (p) => got.push(p)

  send(emit, { a: 1, b: 2 })
  send(emit, { b: 2, a: 1 })

  assert.equal(got.length, 2, '判重宁可多发，也不能漏发')
})

test('emitter 抛错不影响后续发送', () => {
  const send = makeSendOnce()
  const bad = () => { throw new Error('已关闭') }
  const got = []
  const good = (p) => got.push(p)

  assert.doesNotThrow(() => send(bad, { text: '' }))
  send(good, { text: '' })
  assert.equal(got.length, 1, '坏掉的 emitter 不该拖累别的')
})

test('null 与空串按「没有内容」处理', () => {
  const send = makeSendOnce()
  const got = []
  const emit = (p) => got.push(p)

  send(emit, null)
  send(emit, null)

  assert.equal(got.length, 1)
})
