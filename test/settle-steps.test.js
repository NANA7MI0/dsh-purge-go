// 收尾六步的行为契约。
//
// 这套步骤原本在 settle.mjs 与 update-worker.mjs 里各写一遍，只有后者带 topUp，
// 于是「点按钮能补备份、跑 install.sh 不能」。抽成共用后要保证：
//   ① 每一步失败都记进 problems，不静默吞掉；
//   ② 没有 prepare 时不做 topUp（settle 路径不该多跑一次网络）；
//   ③ 有 prepare 时在还原之前补备份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runSettleSteps } from '../patches/lib/settle-steps.mjs'

function fakeCtx(overrides = {}) {
  const calls = []
  const ctx = {
    home: '/tmp/fake-home',
    root: '/tmp/fake-root',
    wasOn: true,
    ops: {
      patchRevert: () => { calls.push('revert'); return { ok: true, restored: 47 } },
      patchApply: () => { calls.push('apply'); return { ok: true, applied: 60 } },
    },
    sync: { syncNative: () => { calls.push('sync'); return { copied: 12 } } },
    state: { setEnabled: (_h, on) => { calls.push(on ? 'inject-on' : 'inject-off') } },
    log: () => {},
    calls,
    ...overrides,
  }
  return ctx
}

test('全成功时按固定顺序走完，problems 为空', async () => {
  const ctx = fakeCtx()
  const { problems } = await runSettleSteps(ctx)
  assert.deepEqual(problems, [])
  assert.deepEqual(ctx.calls, ['inject-off', 'revert', 'apply', 'sync', 'inject-on'])
})

test('没给 prepare 时不做 topUp', async () => {
  let called = false
  const ctx = fakeCtx({ prepare: { prepareBackup: async () => { called = true; return { filled: [], failed: [] } } } })
  // 显式不给 prepare
  delete ctx.prepare
  await runSettleSteps(ctx)
  assert.equal(called, false)
})

test('给了 prepare 时在还原之前补备份', async () => {
  const order = []
  const ctx = fakeCtx({
    prepare: {
      prepareBackup: async () => { order.push('topup'); return { filled: ['a'], failed: [] } },
    },
  })
  const origRevert = ctx.ops.patchRevert
  ctx.ops.patchRevert = () => { order.push('revert'); return origRevert() }
  await runSettleSteps(ctx)
  assert.deepEqual(order, ['topup', 'revert'])
})

test('还原抛异常 → problems 有记录，后续步骤继续跑', async () => {
  const ctx = fakeCtx()
  // 只替换 revert，apply 仍用 fakeCtx 里那个会记 calls 的版本
  ctx.ops.patchRevert = () => { throw new Error('boom') }
  const { problems } = await runSettleSteps(ctx)
  assert.ok(problems.includes('还原补丁失败'))
  assert.ok(ctx.calls.includes('apply'), '还原失败不该中断后面的重打')
})

test('还原返回 ok:false → 记「补丁没还原全」', async () => {
  const ctx = fakeCtx()
  ctx.ops.patchRevert = () => ({ ok: false, reason: 'manifest 缺文件' })
  const { problems } = await runSettleSteps(ctx)
  assert.ok(problems.includes('补丁没还原全'))
})

test('wasOn=false 时不碰注入开关', async () => {
  const ctx = fakeCtx({ wasOn: false })
  await runSettleSteps(ctx)
  assert.deepEqual(ctx.calls, ['revert', 'apply', 'sync'])
})

test('prepare 抛异常不算失败（只是没补上），problems 仍为空', async () => {
  const ctx = fakeCtx({
    prepare: { prepareBackup: async () => { throw new Error('npm 挂了') } },
  })
  const { problems } = await runSettleSteps(ctx)
  assert.deepEqual(problems, [])
})

test('apply 返回 ok:false → 记「补丁没打全」，仍继续同步与恢复注入', async () => {
  const ctx = fakeCtx()
  ctx.ops.patchApply = () => { ctx.calls.push('apply'); return { ok: false, applied: 40, errors: [{ error: 'x' }] } }
  const { problems } = await runSettleSteps(ctx)
  assert.ok(problems.includes('补丁没打全'))
  assert.ok(ctx.calls.includes('sync'), 'apply 失败不该中断同步')
  assert.ok(ctx.calls.includes('inject-on'), 'apply 失败不该把注入留在关闭状态')
})

test('apply 抛异常 → 记「重打补丁失败」', async () => {
  const ctx = fakeCtx()
  ctx.ops.patchApply = () => { throw new Error('boom') }
  const { problems } = await runSettleSteps(ctx)
  assert.ok(problems.includes('重打补丁失败'))
})

test('syncNative 抛异常 → 记「原生目录没同步」', async () => {
  const ctx = fakeCtx()
  ctx.sync.syncNative = () => { throw new Error('boom') }
  const { problems } = await runSettleSteps(ctx)
  assert.ok(problems.includes('原生目录没同步'))
  assert.ok(ctx.calls.includes('inject-on'), '同步失败也该把注入恢复回去')
})

test('inject-on 抛异常 → 记「恢复注入失败」', async () => {
  const ctx = fakeCtx()
  let n = 0
  ctx.state.setEnabled = (_h, on) => { ctx.calls.push(on ? 'inject-on' : 'inject-off'); if (on) n++ ; if (on && n) throw new Error('boom') }
  const { problems } = await runSettleSteps(ctx)
  assert.ok(problems.includes('恢复注入失败'))
})

test('topUp 的日志字段与原来一致（filled/failed）', async () => {
  const seen = []
  const ctx = fakeCtx({
    prepare: { prepareBackup: async () => ({ filled: ['a', 'b'], failed: [] }) },
    log: (step, detail, extra) => { if (step === 'topup') seen.push([detail, extra]) },
  })
  await runSettleSteps(ctx)
  assert.deepEqual(seen, [['ok', { filled: 2, failed: 0 }]])
})

