import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { currentEngagementId, readObjectiveCard, redteamRoot } from '../lib/objective.js'
import { redteamSummary, skillsTargetDir, syncPreset, syncSkills, presetTargetDir } from '../lib/redteam.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'purge-go-rt-'))
}

function writeEngagement(home, id, yaml) {
  const dir = path.join(home, 'redteam', 'engagements', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(home, 'redteam', 'current'), id, 'utf8')
  fs.writeFileSync(path.join(dir, 'engagement.yaml'), yaml, 'utf8')
}

test('目标卡：没有当前靶标时给空串，绝不编目标', () => {
  const home = tempHome()
  assert.equal(currentEngagementId(home), '')
  assert.equal(readObjectiveCard(home), '')
})

test('目标卡：读 target_name 与 scope_cidrs', () => {
  const home = tempHome()
  writeEngagement(
    home,
    'eng-1',
    ['target_name: "某某集团"', 'scope_cidrs: [10.0.0.0/8, 192.168.1.0/24]', 'note: 只打这个单位'].join('\n'),
  )
  const card = readObjectiveCard(home)
  assert.match(card, /^## 本次目标/)
  assert.match(card, /只打：某某集团/)
  assert.match(card, /范围：10\.0\.0\.0\/8、192\.168\.1\.0\/24/)
  assert.match(card, /不打：/)
})

test('目标卡：只有靶标名、没有网段时用兜底那句', () => {
  const home = tempHome()
  writeEngagement(home, 'eng-2', 'target_name: 某单位\n')
  assert.match(readObjectiveCard(home), /范围：只打这个单位名下的资产/)
})

test('目标卡：engagement id 不合法（带 .. 或斜杠）时不读', () => {
  const home = tempHome()
  fs.mkdirSync(path.join(home, 'redteam'), { recursive: true })
  fs.writeFileSync(path.join(home, 'redteam', 'current'), '../../etc/passwd', 'utf8')
  assert.equal(currentEngagementId(home), '')
  assert.equal(readObjectiveCard(home), '')
})

test('redteamRoot：DSH_REDTEAM_HOME 优先', () => {
  const home = tempHome()
  const before = process.env.DSH_REDTEAM_HOME
  process.env.DSH_REDTEAM_HOME = 'D:/tmp/custom-rt'
  try {
    assert.equal(redteamRoot(home), 'D:/tmp/custom-rt')
  } finally {
    if (before === undefined) delete process.env.DSH_REDTEAM_HOME
    else process.env.DSH_REDTEAM_HOME = before
  }
  assert.equal(redteamRoot(home), path.join(home, 'redteam'))
})

test('技能同步：随包 23 条全部落到 <home>/redteam/skills，重复跑不重写', () => {
  const home = tempHome()
  const first = syncSkills(home)
  assert.equal(first.total, 23)
  assert.equal(first.written, 23)
  assert.equal(fs.readdirSync(skillsTargetDir(home)).filter((n) => n.endsWith('.md')).length, 23)
  const second = syncSkills(home)
  assert.equal(second.written, 0, '内容没变就该跳过')
})

test('预设同步：第一次装，第二次保留用户那份', () => {
  const home = tempHome()
  const first = syncPreset(home)
  assert.equal(first.action, 'installed')
  assert.ok(fs.existsSync(path.join(presetTargetDir(home), 'agent.cordis.yml')))
  assert.ok(fs.existsSync(path.join(presetTargetDir(home), 'anchor-gate.mjs')))
  const second = syncPreset(home)
  assert.equal(second.action, 'kept')
  const forced = syncPreset(home, { refresh: true })
  assert.equal(forced.action, 'refreshed')
})

test('预设里不再引用桌面版的 redteam/tools 子插件（否则手机端整份预设挂载失败）', () => {
  const home = tempHome()
  syncPreset(home)
  const text = fs.readFileSync(path.join(presetTargetDir(home), 'agent.cordis.yml'), 'utf8')
  assert.equal(/^\s*-?\s*name:\s*dsh-purge\/redteam\/tools/m.test(text), false)
  assert.equal(/^\s*toolFilter:/m.test(text), false, '0.2.x 已废弃 toolFilter')
})

test('redteamSummary：技能数与预设状态', () => {
  const home = tempHome()
  syncSkills(home)
  assert.deepEqual(redteamSummary(home), { skills: 23, preset: false })
  syncPreset(home)
  assert.deepEqual(redteamSummary(home), { skills: 23, preset: true })
})
