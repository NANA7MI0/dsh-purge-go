import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RUNNING_VERSION, diskVersion, versionMismatch } from '../lib/version.js'
import { collect } from '../lib/dshgo.js'

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-go-ver-'))
  fs.mkdirSync(path.join(home, 'dsh-purge'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-purge', 'state.json'), JSON.stringify({ enabled: true }))
  return home
}

test('运行态版本与磁盘版本同步时，不误报不一致', () => {
  assert.ok(RUNNING_VERSION, 'RUNNING_VERSION 不该是空的')
  assert.equal(diskVersion(), RUNNING_VERSION, '同一份代码里两者应相等')
  assert.equal(versionMismatch(), false)
})

test('面板：更新后没重启时摘要必须最优先提示', () => {
  // 平板实测过的场景：磁盘已 0.7.5、进程里还是旧模块，
  // 界面显示新版本 → 用户以为修好了，实际行为还是旧的。
  const home = tempHome()
  const stale = collect(home, {}, { versionStale: true })
  const s = String(stale.summary)
  assert.ok(s.includes('还没重启'), '摘要里要明说没重启，实际：' + s)
  assert.ok(s.includes('磁盘是') && s.includes('当前跑的仍是'), '要把两个版本号都写出来')
  assert.ok(s.includes('别信'), '要明确告诉用户面板判断不可信')

  // 底色必须跟着变：摘要已经在喊「别信」，再来个绿灯就是自相矛盾
  // （代码注释里记过一次同类坑：摘要说正文是空的、底色却是绿的）
  assert.equal(stale.tone, 'warn', '版本不一致时底色应是黄（不是坏了，只是没重启）')
  assert.notEqual(stale.tone, 'good', '绝不能是绿的')

  const fresh = collect(home, {}, { versionStale: false })
  assert.equal(String(fresh.summary).includes('还没重启'), false, '正常时不该出现这条提示')
  assert.equal(fresh.tone, 'good', '正常时该是绿的')

  // 状态条也要跟上：以前版本不一致会落到「破甲异常 · 点开处理」，
  // 点进去却是「还没重启」，两句话对不上（平板实测过）。
  assert.equal(stale.alert, true, '未重启时状态条该出现')
  assert.ok(String(stale.alertText).includes('待重启'), '状态条文案要说是待重启，实际：' + stale.alertText)
  assert.equal(String(stale.alertText).includes('异常'), false, '不能说「异常」——它不是坏了')
  assert.ok(String(stale.alertText).length <= 24, '状态条 24 字上限，实际 ' + String(stale.alertText).length)
  assert.equal(fresh.alert, false, '正常时状态条该隐藏')
  assert.equal(fresh.alertText, '', '正常时文案必须是空串')
})

test('面板：版本不一致的提示优先于「补丁没打」「正文为空」', () => {
  // 这两种情况至少面板说的是真的；版本不一致时面板说的全是旧模块算的
  const home = tempHome()
  const view = collect(home, {}, { versionStale: true })
  assert.ok(String(view.summary).startsWith('刚更新过但还没重启'), '应是第一条分支，实际：' + view.summary)
})
