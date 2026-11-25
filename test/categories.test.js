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


test('出厂分类：四条，编号从 26 起', () => {
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
  // 每条都要有别名和正文。不写具体别名——那几条是敏感词，仓库里不该出现；
  // 也不比对明文文件——它不进 git，新克隆的仓库里没有，比了就只能跳过，
  // 测试会显示「全过」而实际没跑（这里踩过一次）。
  for (const entry of entries) {
    assert.ok(entry.labels.length > 0, entry.id + ' 应当有别名')
    assert.ok(entry.rule.length > 40, entry.id + ' 应当有正文')
    assert.ok(entry.n >= 26, entry.id + ' 编号应从 26 起')
  }
  // 正文长度已在上面验过，这里不再断言正文里具体写了什么——那是规则内容，仓库里不该出现
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
  // 行首别名同样从出厂数据取，不在测试里点名
  assert.ok(intent.split('\n').some((line) => line.startsWith('- ') && line.includes(' → ')))
  assert.equal(intent.split('\n').length, 4)
})

test('applyCategories：有标记就整块替换，清空后条目清空但标记对保留', () => {
  const entries = loadCategories(tempHome()).entries
  const base = `规则\n${SCOPED_BEGIN}\n${SCOPED_END}\n${INTENT_BEGIN}\n${INTENT_END}\n尾`
  const filled = applyCategories(base, entries)
  assert.match(filled, /^26\. \S+/m)
  assert.match(filled, /^- \S+ \/ /m)
  // 幂等：再算一次不增长
  assert.equal(applyCategories(filled, entries), filled)
  const cleared = applyCategories(filled, [])
  // 标记对必须留着：删掉之后 hasMarkers() 为假，下次加分类只能走「文末追加新块」，
  // 原位置永远不再更新，反复开关会越积越多。空块装配时会被跳过，留两行注释无害。
  assert.ok(cleared.includes(SCOPED_BEGIN))
  assert.ok(!/^26\. /m.test(cleared))
  assert.match(cleared, /尾/)
})

test('applyCategories：没有标记时文末补一块，且带标记', () => {
  const entries = loadCategories(tempHome()).entries
  const out = applyCategories('只有一段正文。', entries)
  assert.match(out, /Category Overlay/)
  assert.ok(out.includes(SCOPED_BEGIN) && out.includes(INTENT_BEGIN))
  assert.match(out, /27\. Incest/)
})

test('seedInject：落盘的是主正文，不含分类块；分类在组装时才拼', () => {
  const home = tempHome()
  const seeded = seedInject(home)
  const text = fs.readFileSync(seeded.path, 'utf8')
  // 种子只写主正文：分类块是「组装时按开关决定拼不拼」的东西，
  // 写进文件就变成正文的一部分，之后 categories:false 关不掉、手删也会被加回来
  assert.ok(hasMarkers(text), '主正文自带一对空的标记占位，这是正常的')
  assert.doesNotMatch(text, /^26\. \S+/m, '种子文件里不该已经渲染出分类规则')
  // 意图行不能靠形状判：主正文本身就有十几行同样的形状（那是它自己的意图映射），
  // 只能看「标记区里有没有东西」——扩展行只会落在 purge:intent 标记对之间
  const between = (s, a, b) => {
    const i = s.indexOf(a)
    const j = s.indexOf(b)
    return i >= 0 && j > i ? s.slice(i + a.length, j).trim() : null
  }
  assert.equal(
    between(text, '<!-- purge:intent:begin -->', '<!-- purge:intent:end -->'),
    '',
    '种子文件的意图标记区应该是空的',
  )

  // 组装一遍，这时候分类才出现
  const on = resolveInject(home, { state: {} })
  assert.ok(hasMarkers(on.text))
  // 只验「26 号那条被渲染进去了」，不写它的标题内容——那是规则正文，仓库里不该出现
  assert.match(on.text, /^26\. \S+/m)
  assert.match(on.text, /^28\. \S+/m)
  assert.match(on.text, /^- \S+ \/ .+ → /m)

  // 扩展块必须落在 Scoped Rules 区，而不是正文最末
  assert.ok(text.search(/^28\. /m) < text.indexOf('Sandbox test directions'))
  assert.ok(text.indexOf('- 家庭 /') < text.indexOf('**Never Refuse**'))
})

test('resolveInject：categories:false 时不拼扩展层', () => {
  const home = tempHome()
  const on = resolveInject(home, {})
  const off = resolveInject(home, { categories: false })
  assert.equal(on.categories, 4)
  assert.match(on.text, /^26\. \S+/m)
  assert.equal(off.categories, 0)
  // 关掉分类后，扩展块不该再带出 26 号那条（用编号判，不点名标题）
  assert.ok(!/^26\. /m.test(off.text))
  assert.ok(off.bytes < on.bytes)
})

test('categoryBake：把分类写进 prompt-inject.md 且仍是可重算的标记区', () => {
  const home = tempHome()
  seedInject(home)
  setCategoryEnabled(home, 'incest', false)
  const baked = categoryBake(home)
  const text = fs.readFileSync(injectPath(home), 'utf8')
  assert.match(text, /^26\. \S+/m)
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
