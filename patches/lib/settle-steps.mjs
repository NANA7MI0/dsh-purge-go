// 更新收尾的六步 —— 只此一处实现。
//
// 为什么抽出来：这套步骤原本在 settle.mjs 和 update-worker.mjs 里各写了一遍，
// 几乎逐行相同，但只有 update-worker 那份带 topUp（补备份）。两边分叉的直接后果是：
// 面板点更新能补备份、命令行不能，于是同一台机器「点按钮能打上补丁、跑 install.sh 打不上」。
//
// 调用方负责准备 ctx：
//   home      DSH_HOME
//   root      引擎包根目录（@deepseek-ai 的上一层）
//   wasOn     更新前注入开没开
//   ops       { patchRevert, patchApply }
//   sync      { syncNative }
//   state     { setEnabled }
//   prepare   { prepareBackup }   可选；给了就在还原前补备份
//   log       (step, detail, extra) => void
//
// 返回 { problems: string[] }：空数组表示六步全干净。
export async function runSettleSteps(ctx) {
  const { home, root, wasOn, ops, sync, state, prepare, log } = ctx
  const { patchRevert, patchApply } = ops
  const { syncNative } = sync
  const { setEnabled } = state
  const problems = []

  // 1. 先关注入：旧正文配新代码容易打架，重打完再按原状态打回去
  try {
    if (wasOn) setEnabled(home, false)
    log('inject-off', 'ok')
  } catch (error) {
    problems.push('关注入失败')
    log('inject-off', 'failed', { error: String(error && error.message) })
  }

  // 2. 补齐备份（只在给了 prepare 时做）
  // 补丁目标会长大，老备份覆盖不全，不补就会「47 个目标只还原 41 个」，
  // 剩下几个永远带着补丁标记。
  if (prepare) {
    try {
      const prep = await prepare.prepareBackup(home, { root })
      if (prep.filled.length) log('topup', 'ok', { filled: prep.filled.length, failed: prep.failed.length })
      else if (prep.failed.length) log('topup', 'failed', { failed: prep.failed.slice(0, 3) })
    } catch (error) {
      log('topup', 'threw', { error: String(error && error.message) })
    }
  }

  // 3. 还原补丁。失败要留下原因——以前在引擎里被 catch 吞掉，用户只看到「N 条待处理」。
  try {
    const rv = patchRevert(home, { root })
    if (rv && rv.ok === false) {
      problems.push('补丁没还原全')
      log('revert', 'incomplete', { reason: String(rv.reason || '').slice(0, 120) })
    } else {
      log('revert', 'ok', { restored: rv && rv.restored })
    }
  } catch (error) {
    problems.push('还原补丁失败')
    log('revert', 'failed', { error: String(error && error.message) })
  }

  // 4. 按新版本的规则重打
  try {
    const ap = patchApply(home, { root })
    if (ap && ap.ok === false) {
      problems.push('补丁没打全')
      log('apply', 'incomplete', { applied: ap.applied, errors: (ap.errors || []).length })
    } else {
      log('apply', 'ok', { applied: ap && ap.applied })
    }
  } catch (error) {
    problems.push('重打补丁失败')
    log('apply', 'failed', { error: String(error && error.message) })
  }

  // 5. 同步原生目录——不同步的话插件跑的还是旧代码，面板也是旧样子
  try {
    const r = syncNative(root)
    log('sync-native', 'ok', { copied: r && r.copied })
  } catch (error) {
    problems.push('原生目录没同步')
    log('sync-native', 'failed', { error: String(error && error.message) })
  }

  // 6. 按更新前的状态恢复注入
  try {
    if (wasOn) setEnabled(home, true)
    log('inject-on', 'ok')
  } catch (error) {
    problems.push('恢复注入失败')
    log('inject-on', 'failed', { error: String(error && error.message) })
  }

  return { problems }
}
