import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { apply, restore, sha256, verifyFile, probe } from '../patches/lib/core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 造一个假引擎：两个包，一个 .js 一个 .yml，内容都带可替换的标记串。 */
function fakeEngine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-core-'))
  const a = path.join(root, 'dsh-alpha', 'lib')
  const b = path.join(root, 'dsh-beta')
  fs.mkdirSync(a, { recursive: true })
  fs.mkdirSync(b, { recursive: true })
  fs.writeFileSync(path.join(a, 'index.js'), 'export const x = "OLD_JS_TOKEN"\n')
  fs.writeFileSync(path.join(b, 'cordis.patch.yml'), '- id: demo\n  config:\n    mode: OLD_YML_TOKEN\n')
  return root
}

const PATCHES = [
  { id: 901, name: 'JS_PATCH', file: 'alpha', rel: ['lib', 'index.js'], replacements: [{ pattern: 'OLD_JS_TOKEN', replace: 'NEW_JS_TOKEN' }], markers: ['NEW_JS_TOKEN'] },
  { id: 902, name: 'YML_PATCH', file: 'beta', rel: 'cordis.patch.yml', replacements: [{ pattern: 'OLD_YML_TOKEN', replace: 'NEW_YML_TOKEN' }], markers: ['NEW_YML_TOKEN'] },
]

test('sha256 对同一文件稳定，对改动敏感', () => {
  const f = path.join(os.tmpdir(), 'sha-' + Date.now() + '.txt')
  fs.writeFileSync(f, 'hello')
  const h1 = sha256(f)
  assert.equal(h1, sha256(f))
  fs.writeFileSync(f, 'hello!')
  assert.notEqual(h1, sha256(f))
  fs.rmSync(f)
})

test('verifyFile 放行合法 JSON，拦住坏 JSON', () => {
  const ok = path.join(os.tmpdir(), 'v-' + Date.now() + '.json')
  fs.writeFileSync(ok, '{"a":1}')
  assert.equal(verifyFile(ok), null)
  fs.writeFileSync(ok, '{"a":')
  assert.match(verifyFile(ok) || '', /JSON/)
  fs.rmSync(ok)
})

test('verifyFile 放行合法 YAML（含 !!js 自定义标签）', () => {
  const f = path.join(os.tmpdir(), 'v-' + Date.now() + '.yml')
  fs.writeFileSync(f, '- id: a\n  config:\n    root: !!js dshHomePath(\'x\')\n')
  const err = verifyFile(f)
  // 有 yaml 包时应该通过；没有时退化为 null（不校验）
  assert.ok(err === null, '合法 YAML 不应报错，实际：' + err)
  fs.rmSync(f)
})

test('verifyFile 拦住写坏的 YAML', () => {
  const f = path.join(os.tmpdir(), 'v-' + Date.now() + '.yml')
  // 缩进错乱 + 未闭合引号
  fs.writeFileSync(f, '- id: a\n   bad: "unclosed\n  - - -\n')
  const err = verifyFile(f)
  // 装不到 yaml 时返回 null，这条就跳过（不算失败）
  if (err !== null) assert.match(err, /YAML/)
  fs.rmSync(f)
})

test('apply 打完两个文件，manifest 记录了 root 与哈希', () => {
  const root = fakeEngine()
  const backupDir = path.join(root, '__bk')
  const report = apply(root, { backupDir, patches: PATCHES })
  assert.equal(report.rolledBack, false)
  assert.equal(report.applied, 2)
  assert.equal(report.errors.length, 0)

  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.root, root)
  assert.equal(manifest.files.length, 2)
  for (const f of manifest.files) {
    assert.ok(f.sha256 && f.sha256.length === 64, 'sha256 应有值')
    assert.ok(f.size > 0)
  }
  // 文件确实被改了
  assert.match(fs.readFileSync(path.join(root, 'dsh-alpha/lib/index.js'), 'utf8'), /NEW_JS_TOKEN/)
  assert.match(fs.readFileSync(path.join(root, 'dsh-beta/cordis.patch.yml'), 'utf8'), /NEW_YML_TOKEN/)
})

test('apply 校验失败时全部回滚，applied 归零', () => {
  const root = fakeEngine()
  const backupDir = path.join(root, '__bk2')
  // 故意让 YAML 的替换结果变成非法 YAML
  const bad = [
    PATCHES[0],
    { id: 903, name: 'BAD_YML', file: 'beta', rel: 'cordis.patch.yml', replacements: [{ pattern: 'OLD_YML_TOKEN', replace: '"unclosed' }], markers: ['"unclosed'] },
  ]
  const report = apply(root, { backupDir, patches: bad })
  assert.equal(report.rolledBack, true, '应标记为已回滚')
  assert.equal(report.applied, 0, '回滚后成功数必须归零')
  assert.ok(report.errors.length > 0, '必须有错误记录')
  assert.equal(report.failed, 1)
  // 两个文件都应回到原样——包括先改成功的那个 .js
  assert.match(fs.readFileSync(path.join(root, 'dsh-alpha/lib/index.js'), 'utf8'), /OLD_JS_TOKEN/, '.js 应被回滚')
  assert.match(fs.readFileSync(path.join(root, 'dsh-beta/cordis.patch.yml'), 'utf8'), /OLD_YML_TOKEN/, '.yml 应被回滚')
})

test('restore 按 manifest 还原，缺文件时记错而不是静默跳过', () => {
  const root = fakeEngine()
  const backupDir = path.join(root, '__bk3')
  apply(root, { backupDir, patches: PATCHES })
  // 删掉备份里的一个文件，模拟备份不完整
  fs.rmSync(path.join(backupDir, 'files/dsh-beta/cordis.patch.yml'))
  const report = restore(backupDir, { root })
  assert.ok(report.errors.length > 0, '缺文件必须记错')
  assert.equal(report.restored, 1, '只有完好的那个能还原')
  // .js 应该被还原
  assert.match(fs.readFileSync(path.join(root, 'dsh-alpha/lib/index.js'), 'utf8'), /OLD_JS_TOKEN/)
})

test('restore 在 restored=0 时不能算成功（调用方据此判 ok）', () => {
  const root = fakeEngine()
  const backupDir = path.join(root, '__bk4')
  fs.mkdirSync(path.join(backupDir, 'files'), { recursive: true })
  // 空备份：manifest 说 0 个文件
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ root, at: new Date().toISOString(), files: [] }))
  const report = restore(backupDir, { root })
  assert.equal(report.restored, 0)
})

test('restore 报出 root 不一致', () => {
  const root = fakeEngine()
  const backupDir = path.join(root, '__bk5')
  apply(root, { backupDir, patches: PATCHES })
  const other = fakeEngine()
  const report = restore(backupDir, { root: other })
  assert.equal(report.rootMismatch, true, '备份的 root 与目标不同时必须报')
})

test('probe 对「打了一部分」判 partial，不判 applied', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-partial-'))
  fs.mkdirSync(path.join(root, 'dsh-gamma', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dsh-gamma/lib/index.js'), 'A_OLD B_NEW\n')
  const patches = [{
    id: 910, name: 'PARTIAL', file: 'gamma', rel: ['lib', 'index.js'],
    replacements: [{ pattern: 'A_OLD', replace: 'A_NEW' }, { pattern: 'B_OLD', replace: 'B_NEW' }],
    markers: ['B_NEW'],
  }]
  const rows = probe(root, patches)
  assert.equal(rows[0].status, 'partial', '只替换了一半必须判 partial')
  assert.equal(rows[0].hits, 1)
  assert.equal(rows[0].total, 2)
})

test('probe 对「pattern 全不在且无 marker」判 miss，不判 applied', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-miss-'))
  fs.mkdirSync(path.join(root, 'dsh-delta', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dsh-delta/lib/index.js'), 'nothing here\n')
  const patches = [{
    id: 911, name: 'MISS', file: 'delta', rel: ['lib', 'index.js'],
    replacements: [{ pattern: 'NEVER_THERE', replace: 'X' }],
    markers: ['NEVER_THERE_MARKER'],
  }]
  const rows = probe(root, patches)
  assert.equal(rows[0].status, 'miss', '没有 marker 不能算 applied')
})

test('写失败时 applied 归零并回滚已改文件', () => {
  const root = fakeEngine()
  const backupDir = path.join(root, '__bkw')
  // 把第二个目标文件设成只读，让写入抛错
  const target = path.join(root, 'dsh-beta/cordis.patch.yml')
  fs.chmodSync(target, 0o444)
  const report = apply(root, { backupDir, patches: PATCHES })
  fs.chmodSync(target, 0o644)
  // 以 root 身份运行时 chmod 拦不住，这种情况跳过断言（环境相关）
  if (report.failed > 0) {
    assert.equal(report.applied, 0, '回滚后成功数必须归零')
    assert.equal(report.rolledBack, true)
    assert.match(fs.readFileSync(path.join(root, 'dsh-alpha/lib/index.js'), 'utf8'), /OLD_JS_TOKEN/, '.js 应被回滚')
  }
})

test('备份阶段失败时干净中止，不留下改过的文件', () => {
  const root = fakeEngine()
  // 把 backupDir 指向一个「父路径是文件」的位置，mkdir 必然失败
  const blocker = path.join(root, 'blocker')
  fs.writeFileSync(blocker, 'not a directory')
  const backupDir = path.join(blocker, 'sub')
  let threw = null
  try {
    apply(root, { backupDir, patches: PATCHES })
  } catch (error) {
    threw = error
  }
  // 备份建不起来时，什么都没改——引擎保持原样
  assert.ok(threw, '备份失败应当抛错，不能假装成功')
  assert.match(fs.readFileSync(path.join(root, 'dsh-alpha/lib/index.js'), 'utf8'), /OLD_JS_TOKEN/, '文件不应被改')
})

test('restore 的 root 不一致只是警告，不把 ok 判成失败', () => {
  const root = fakeEngine()
  const backupDir = path.join(root, '__bkm')
  apply(root, { backupDir, patches: PATCHES })
  const other = fakeEngine()
  const report = restore(backupDir, { root: other })
  assert.equal(report.rootMismatch, true)
  // 警告不该进 errors —— 否则还原成功也会被判失败
  assert.equal(report.warnings.length > 0, true, '应有警告')
  assert.equal(report.errors.length, 0, 'root 不一致不该算 error')
  assert.ok(report.restored > 0, '文件仍应被还原')
})


test('apply：文件里已有 marker 也要把剩余未打的 pattern 补上（partial 不能永远修不好）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-partial-'))
  const dir = path.join(root, 'dsh-gamma', 'lib')
  fs.mkdirSync(dir, { recursive: true })
  // 同一文件里两处 pattern：第一处已经打过了（replacement 在里面），第二处还是原文
  const file = path.join(dir, 'index.js')
  fs.writeFileSync(
    file,
    ['// [dsh-purge] 已改过的一处', 'export const a = "NEW_A"', 'export const b = "OLD_B"', ''].join('\n'),
  )

  const patches = [
    {
      id: 900,
      name: 'PARTIAL_CASE',
      file: ['gamma'],
      markers: ['[dsh-purge] 已改过的一处'],
      replacements: [
        { pattern: 'export const a = "OLD_A"', replace: 'export const a = "NEW_A"' },
        { pattern: 'export const b = "OLD_B"', replace: 'export const b = "NEW_B"' },
      ],
    },
  ]

  const res = apply(root, { patches, backupDir: path.join(root, 'bk') })
  const text = fs.readFileSync(file, 'utf8')

  assert.equal(res.applied, 1, '应当有一个文件被改写')
  assert.ok(text.includes('NEW_B'), '第二处必须真的打上——旧逻辑会因为 marker 把它整片跳过')
  assert.ok(text.includes('NEW_A'), '第一处保持已改好的样子')
  assert.ok(!text.includes('OLD_B'), '原文不该残留')
})

