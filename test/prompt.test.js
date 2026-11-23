import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { normalizeText, sanitizeName, escapeInterpolation, seedInject, resolveInject, listVariants, writeVariant } from '../lib/prompt.js'
import { readState, writeState, setEnabled, setModelVariant } from '../lib/state.js'
import { injectPath, purgeDir } from '../lib/home.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'purge-go-'))
}

test('normalizeText：去 BOM、CRLF 归一、去尾部空行', () => {
  const raw = '\uFEFFhello\r\nworld\r\n\r\n\r\n'
  assert.equal(normalizeText(raw), 'hello\nworld')
})

test('sanitizeName：模型名里的斜杠与冒号变成下划线', () => {
  assert.equal(sanitizeName('Vendor/Model:free'), 'vendor_model_free')
  assert.equal(sanitizeName('   '), 'default')
  assert.equal(sanitizeName('../../etc/passwd'), 'etc_passwd')
})

test('escapeInterpolation：只保留 cwd/model/provider，其余拆开', () => {
  assert.equal(escapeInterpolation('{{cwd}} and {{model}}'), '{{cwd}} and {{model}}')
  assert.equal(escapeInterpolation('{{secret}}'), '{ {secret}}')
  assert.equal(escapeInterpolation('no tokens'), 'no tokens')
})

test('seedInject：缺失时落盘，已有则不覆盖', () => {
  const home = tempHome()
  const first = seedInject(home)
  assert.equal(first.written, true)
  assert.ok(first.bytes > 10_000, '内置正文应当是一份完整提示词')

  const second = seedInject(home)
  assert.equal(second.written, false)

  const forced = seedInject(home, { force: true })
  assert.equal(forced.written, true)
})

test('readState：缺省开、默认变体；setEnabled 持久化', () => {
  const home = tempHome()
  const initial = readState(home)
  assert.equal(initial.enabled, true)
  assert.equal(initial.variant, 'default')

  setEnabled(home, false)
  assert.equal(readState(home).enabled, false)
  assert.ok(fs.existsSync(path.join(purgeDir(home), 'state.json')))
})

test('resolveInject：优先级 byModel > 变体 > prompt-inject.md > 内置', () => {
  const home = tempHome()
  writeState(home, { enabled: true })

  // 只有内置
  assert.equal(resolveInject(home, { state: readState(home) }).source, 'builtin')

  // prompt-inject.md 优先于内置
  fs.mkdirSync(path.dirname(injectPath(home)), { recursive: true })
  fs.writeFileSync(injectPath(home), 'FILE BODY\n', 'utf8')
  assert.deepEqual(
    { source: resolveInject(home, { state: readState(home) }).source, text: resolveInject(home, { state: readState(home) }).text },
    { source: 'prompt-inject.md', text: 'FILE BODY' },
  )

  // 变体优先于文件
  writeVariant(home, 'tight', 'VARIANT BODY')
  writeState(home, { variant: 'tight' })
  assert.equal(resolveInject(home, { state: readState(home) }).text, 'VARIANT BODY')

  // byModel 优先于当前变体
  setModelVariant(home, 'vendor_model_free', 'perModel')
  writeVariant(home, 'perModel', 'PER MODEL BODY')
  const resolved = resolveInject(home, { state: readState(home), model: 'vendor/model:free' })
  assert.equal(resolved.text, 'PER MODEL BODY')
  assert.equal(resolved.source, 'variant:model')
  assert.equal(resolved.variant, 'perModel')
})

test('resolveInject：maxBytes 截断', () => {
  const home = tempHome()
  fs.mkdirSync(path.dirname(injectPath(home)), { recursive: true })
  fs.writeFileSync(injectPath(home), 'x'.repeat(200), 'utf8')
  const resolved = resolveInject(home, { state: readState(home), maxBytes: 50 })
  assert.equal(resolved.truncated, true)
  assert.equal(resolved.bytes, 50)
})

test('listVariants：只收 .md，按名字排序', () => {
  const home = tempHome()
  writeVariant(home, 'b', 'B')
  writeVariant(home, 'a', 'A')
  fs.writeFileSync(path.join(purgeDir(home), 'prompts', 'ignore.txt'), 'x', 'utf8')
  assert.deepEqual(listVariants(home).map((variant) => variant.name), ['a', 'b'])
})
