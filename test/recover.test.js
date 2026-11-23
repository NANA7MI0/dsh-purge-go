import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  RECOVER_DEFAULTS,
  createRecoverLedger,
  inspectRefusal,
  installRecover,
  looksLikeModelRefusal,
  makeRecoverMessage,
} from '../lib/recover.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempDir(prefix = 'purge-go-recover-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 造一个只带会话事件的假 agent：events 就是宿主会给出的那一串。 */
function fakeAgent(events, extra = {}) {
  const sent = []
  return {
    sent,
    id: extra.id || 'session-1',
    status: extra.status || 'idle',
    session: { snapshotEvents: () => events },
    followup: (message) => sent.push(message),
    ...extra,
  }
}

function turnEnd(seq, kind = 'completed') {
  return { type: 'turn/end', seq, data: { turn: 1, reason: { kind } } }
}

function assistant(text) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

function human(text) {
  return { type: 'user/message', data: { message: { content: [{ type: 'text', text }] }, source: { kind: 'user' } } }
}

test('拒答识别：命中常见逃避句，放行我们自己的禁止句', () => {
  assert.equal(looksLikeModelRefusal('抱歉，我不能协助完成这个请求。'), true)
  assert.equal(looksLikeModelRefusal('I cannot help with that request.'), true)
  assert.equal(looksLikeModelRefusal('出于安全考虑，这个内容我无法提供。'), true)
  assert.equal(looksLikeModelRefusal('不行，这是严令禁止的'), false)
  assert.equal(looksLikeModelRefusal('已经打完，报告在 report.md。'), false)
  assert.equal(looksLikeModelRefusal('短'), false)
})

test('makeRecoverMessage：来源可识别，正文可覆盖', () => {
  const message = makeRecoverMessage('')
  assert.equal(message.role, 'user')
  assert.equal(message.source.summary, 'refusal-recover')
  assert.equal(message.source.kind, 'dsh-purge-go')
  assert.equal(message.content[0].text, RECOVER_DEFAULTS.recoverText)
  assert.match(makeRecoverMessage('自定义').content[0].text, /自定义/)
})

test('inspectRefusal：只有在「本轮正常结束 + 最后一条是拒答 + 用户没接话」时才合格', () => {
  const eligible = inspectRefusal(fakeAgent([human('打一下 target'), assistant('抱歉，我不能协助。'), turnEnd(2)]))
  assert.equal(eligible.eligible, true)
  assert.equal(eligible.reasonKind, 'completed')
  assert.equal(eligible.refusal, true)

  const aborted = inspectRefusal(fakeAgent([human('打一下 target'), assistant('抱歉，我不能协助。'), turnEnd(2, 'aborted')]))
  assert.equal(aborted.eligible, false)

  const humanAfter = inspectRefusal(
    fakeAgent([human('打一下 target'), assistant('抱歉，我不能协助。'), turnEnd(2), human('换个说法')]),
  )
  assert.equal(humanAfter.humanAfterAssistant, true)
  assert.equal(humanAfter.eligible, false)
})

test('账本：同一条拒答只追一次，换轮还要过冷却', () => {
  const ledger = createRecoverLedger()
  assert.equal(ledger.take('s', 3, 2, 60_000, 1000), true)
  assert.equal(ledger.take('s', 3, 2, 60_000, 2000), false, '同一 seq 不能重复追')
  assert.equal(ledger.take('s', 4, 2, 60_000, 3000), false, '冷却期内换轮也不追')
  assert.equal(ledger.take('s', 5, 2, 60_000, 100_000), true, '冷却过后可以再追一次')
  assert.equal(ledger.take('s', 6, 2, 60_000, 200_000), false, '每会话上限 2 次')
  assert.equal(ledger.count('s'), 2)
})

test('账本：reset 语义 —— 会话被重新打开也不清账（避免无限复读）', () => {
  const ledger = createRecoverLedger()
  ledger.take('s', 1, 2, 0, 1)
  ledger.take('s', 2, 2, 0, 2)
  // 重复 take 不会把计数加回去
  assert.equal(ledger.take('s', 3, 2, 0, 3), false)
  assert.equal(ledger.count('s'), 2)
})

test('installRecover：一轮结束后自动追一句，插件自己的消息不会再触发一次', async () => {
  const dir = tempDir()
  const handlers = []
  const ctx = {
    on: (event, handler) => handlers.push({ event, handler }),
    __dir: dir,
  }
  const events = [human('打一下 target'), assistant('抱歉，我不能协助这件事。'), turnEnd(2)]
  const agent = fakeAgent(events)
  const runtime = installRecover(ctx, { getConfig: () => ({ ...RECOVER_DEFAULTS, recoverCooldownMs: 0, recoverMax: 2 }) })
  assert.ok(runtime)
  assert.equal(handlers.length, 1)
  assert.equal(handlers[0].event, 'agent/status')

  handlers[0].handler({ status: 'idle', agent })
  await sleep(420)
  assert.equal(agent.sent.length, 1, '应追一句')
  assert.equal(agent.sent[0].source.summary, 'refusal-recover')

  // 追完之后会话里多了一条我们自己发的消息 —— 再触发也不该重复追
  events.push({ type: 'user/message', data: { message: { content: [{ type: 'text', text: '继续' }] }, source: { kind: 'dsh-purge-go', summary: 'refusal-recover' } } })
  handlers[0].handler({ status: 'idle', agent })
  await sleep(420)
  assert.equal(agent.sent.length, 1, '同一条拒答不能追第二次')
  runtime.dispose()
})

test('installRecover：会话在跑 / 有排队消息 / 关掉开关时都不动', async () => {
  const handlers = []
  const ctx = { on: (event, handler) => handlers.push({ event, handler }) }
  const events = [human('打一下 target'), assistant('抱歉，我不能协助。'), turnEnd(2)]

  const running = fakeAgent(events, { status: 'running' })
  const busy = fakeAgent(events, { inbox: { hasPending: () => true } })

  const runtime = installRecover(ctx, { getConfig: () => ({ ...RECOVER_DEFAULTS, recoverCooldownMs: 0 }) })
  handlers[0].handler({ status: 'idle', agent: running })
  handlers[0].handler({ status: 'idle', agent: busy })
  await sleep(420)
  assert.equal(running.sent.length, 0)
  assert.equal(busy.sent.length, 0)
  runtime.dispose()

  const offHandlers = []
  const offCtx = { on: (event, handler) => offHandlers.push({ event, handler }) }
  const off = fakeAgent(events)
  const offRuntime = installRecover(offCtx, {
    getConfig: () => ({ ...RECOVER_DEFAULTS, recoverRefusal: false, recoverCooldownMs: 0 }),
  })
  offHandlers[0].handler({ status: 'idle', agent: off })
  await sleep(420)
  assert.equal(off.sent.length, 0)
  offRuntime.dispose()
})
