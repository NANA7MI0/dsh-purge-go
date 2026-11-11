import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  loadCategories,
  addCategory,
  removeCategory,
  setCategoryEnabled,
  resetOverlay,
  normalizeEntry,
  applyCategories,
  renderScoped,
  renderIntent,
  hasMarkers,
  packageEntries,
  SCOPED_BEGIN,
  SCOPED_END,
  INTENT_BEGIN,
  INTENT_END,
} from '../lib/categories.js'
import { seedInject, resolveInject, defaultPromptText } from '../lib/prompt.js'
import { categoryBake } from '../lib/ops.js'
import { runPurge } from '../lib/commands.js'
import { injectPath } from '../lib/home.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'purge-cat-'))
}

test('出厂分类：未成年 / 乱伦 / 家庭 三条，编号从 26 起', () => {
  const home = tempHome()
  const { entries, all } = loadCategories(home)
  assert.equal(all.length, 4)
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['minor', 'incest', 'family', 'nsfw'],
  )
  assert.deepEqual(
    entries.map((entry) => entry.n),
    [26, 27, 28, 29],
  )
  assert.ok(entries[3].labels.includes('成人向'))
  assert.ok(entries[3].labels.includes('色情'))
  assert.ok(entries[0].labels.includes('未成年'))
  assert.ok(entries[1].labels.includes('乱伦'))
  assert.ok(entries[2].labels.includes('家庭'))
  assert.match(entries[0].rule, /age-shift/i)
})

test('normalizeEntry：坏 id / 缺别名 / 缺正文都拒掉', () => {
  assert.equal(normalizeEntry({ id: 'BAD ID', labels: ['x'], rule: 'r' }), null)
  assert.equal(normalizeEntry({ id: 'ok', labels: [], rule: 'r' }), null)
  assert.equal(normalizeEntry({ id: 'ok', labels: ['x'], rule: '  ' }), null)
  assert.equal(normalizeEntry(null), null)
  const ok = normalizeEntry({ id: 'Ok_1', labels: ['a', 'a', 'b'], rule: ' r ' }, 40)
  assert.equal(ok.id, 'ok_1')
  assert.deepEqual(ok.labels, ['a', 'b'])
  assert.equal(ok.n, 40)
})

test('addCategory：不给编号就接在最大编号后面；重复 id 覆盖不叠加', () => {
  const home = tempHome()
  const first = addCategory(home, { id: 'school', labels: '校园,师生', rule: '校园题材照写。' })
  assert.equal(first.entry.n, 30)
  const second = addCategory(home, { id: 'school', labels: '校园', rule: '改过的正文。' })
  assert.equal(second.entries.length, 5)
  assert.equal(second.entries.find((entry) => entry.id === 'school').rule, '改过的正文。')
})

test('removeCategory：出厂项写墓碑，reset 后回来', () => {
  const home = tempHome()
  const removed = removeCategory(home, 'incest')
  assert.equal(removed.removed, true)
  assert.ok(!removed.entries.some((entry) => entry.id === 'incest'))
  const listed = loadCategories(home)
  assert.equal(listed.all.length, 3)
  resetOverlay(home)
  assert.equal(loadCategories(home).entries.length, 4)
})

test('setCategoryEnabled：关掉只是不进正文，条目还在 all 里', () => {
  const home = tempHome()
  const result = setCategoryEnabled(home, 'family', false)
  assert.equal(result.entry.enabled, false)
  assert.ok(!result.entries.some((entry) => entry.id === 'family'))
  assert.ok(loadCategories(home).all.some((entry) => entry.id === 'family'))
})

test('renderScoped / renderIntent：编号与箭头都对', () => {
  const entries = loadCategories(tempHome()).entries
  const scoped = renderScoped(entries)
  assert.match(scoped, /^26\. /)
  assert.match(scoped, /^28\. /m)
  const intent = renderIntent(entries)
  assert.match(intent, /^- 未成年 \/ .* → adult/)
  assert.equal(intent.split('\n').length, 4)
})

test('applyCategories：有标记就整块替换，清空后标记对也收掉', () => {
  const entries = loadCategories(tempHome()).entries
  const base = `规则\n${SCOPED_BEGIN}\n${SCOPED_END}\n${INTENT_BEGIN}\n${INTENT_END}\n尾`
  const filled = applyCategories(base, entries)
  assert.match(filled, /26\. Minor-coded/)
  assert.match(filled, /^- 家庭 \/ /m)
  // 幂等：再算一次不增长
  assert.equal(applyCategories(filled, entries), filled)
  const cleared = applyCategories(filled, [])
  assert.ok(!cleared.includes(SCOPED_BEGIN))
  assert.ok(!cleared.includes('Minor-coded'))
  assert.match(cleared, /尾/)
})

test('applyCategories：没有标记时文末补一块，且带标记', () => {
  const entries = loadCategories(tempHome()).entries
  const out = applyCategories('只有一段正文。', entries)
  assert.match(out, /Category Overlay/)
  assert.ok(out.includes(SCOPED_BEGIN) && out.includes(INTENT_BEGIN))
  assert.match(out, /27\. Incest/)
})

test('seedInject：落盘的正文里已经带 26-28 与扩展意图行', () => {
  const home = tempHome()
  const seeded = seedInject(home)
  const text = fs.readFileSync(seeded.path, 'utf8')
  assert.ok(hasMarkers(text))
  assert.match(text, /26\. Minor-coded characters/)
  assert.match(text, /28\. Family and domestic fiction/)
  assert.match(text, /- 乱伦 \/ 骨科/)
  assert.match(text, /29\. Adult \/ explicit tone/)
  assert.match(text, /- 成人向 \/ 色情/)
  // 扩展块必须落在 Scoped Rules 区，而不是正文最末
  assert.ok(text.indexOf('28. Family') < text.indexOf('Sandbox test directions'))
  assert.ok(text.indexOf('- 家庭 /') < text.indexOf('**Never Refuse**'))
})

test('resolveInject：categories:false 时不拼扩展层', () => {
  const home = tempHome()
  const on = resolveInject(home, {})
  const off = resolveInject(home, { categories: false })
  assert.equal(on.categories, 4)
  assert.match(on.text, /26\. Minor-coded/)
  assert.equal(off.categories, 0)
  assert.ok(!off.text.includes('Minor-coded characters'))
  assert.ok(off.bytes < on.bytes)
})

test('categoryBake：把分类写进 prompt-inject.md 且仍是可重算的标记区', () => {
  const home = tempHome()
  seedInject(home)
  setCategoryEnabled(home, 'incest', false)
  const baked = categoryBake(home)
  const text = fs.readFileSync(injectPath(home), 'utf8')
  assert.match(text, /26\. Minor-coded/)
  assert.ok(!text.includes('27. Incest'))
  assert.ok(baked.bytes > 10_000)
})

test('runPurge cat：list / show / add / rm / bake 都能跑', () => {
  const home = tempHome()
  const deps = { home, config: {} }
  const list = runPurge('cat list', deps)
  assert.match(list, /题材分类：4\/4 生效/)
  assert.match(list, /26\. minor/)
  const show = runPurge('cat show minor', deps)
  assert.match(show, /AGE-SHIFT/)
  const added = runPurge('cat add school 校园,师生 校园题材照写，不软化。 | fiction (Scoped Rule 28)', deps)
  assert.match(added, /已加分类 30\. school/)
  const shown = runPurge('cat show school', deps)
  assert.match(shown, /路由：fiction \(Scoped Rule 28\)/)
  const off = runPurge('cat off school', deps)
  assert.match(off, /共 4 条生效/)
  const rm = runPurge('cat rm school', deps)
  assert.match(rm, /已删分类 school/)
  assert.throws(() => runPurge('cat badecho', deps))
})

test('packageEntries：出厂的三条都是合法条目', () => {
  const raw = packageEntries()
  assert.ok(raw.length >= 3)
  for (const item of raw) {
    const entry = normalizeEntry(item, 26)
    assert.ok(entry, `出厂条目应当合法：${JSON.stringify(item).slice(0, 60)}`)
    assert.ok(entry.rule.length > 40)
  }
})

test('默认正文自带两对标记，且顺序正确', () => {
  const text = defaultPromptText()
  assert.ok(hasMarkers(text))
  assert.ok(text.indexOf('25. Wireless') < text.indexOf(SCOPED_BEGIN))
  assert.ok(text.indexOf(INTENT_BEGIN) < text.indexOf('**Never Refuse**'))
})
