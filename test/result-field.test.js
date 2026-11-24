// install.sh 里 result_field() 的解析契约。
//
// 这个函数是「不再 grep 中文文案」的关键：它从 __RESULT__ 那一行里取字段。
// 取错了会静默走错分支（比报错更糟），所以要把边界情况钉死。
//
// 实现是 shell 里的 sed，这里用 node 起 sh 去跑同一段函数，保证测的就是真代码。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 从 install.sh 里把 result_field 函数原文抠出来，避免测试和实现各写一份。 */
function extractFn() {
  const src = fs.readFileSync(path.join(repo, 'install.sh'), 'utf8')
  const start = src.indexOf('result_field() {')
  assert.ok(start >= 0, 'install.sh 里找不到 result_field 函数')
  const end = src.indexOf('\n}', start)
  assert.ok(end > start, 'result_field 函数没有正常结束')
  return src.slice(start, end + 2)
}

function callFn(out, field) {
  const script = extractFn() + '\nresult_field "$1" "$2"\n'
  return execFileSync('sh', ['-c', script, 'sh', out, field], { encoding: 'utf8' }).trim()
}

test('从正常结果行里取 kind', () => {
  const out = 'say something\n__RESULT__ {"ok":true,"kind":"ok"}\n'
  assert.equal(callFn(out, 'kind'), 'ok')
})

test('取布尔与数字字段', () => {
  const out = '__RESULT__ {"ok":false,"applied":60,"rolledBack":true}\n'
  assert.equal(callFn(out, 'applied'), '60')
  assert.equal(callFn(out, 'rolledBack'), 'true')
})

test('方法名里含 kind 字样不会干扰取值', () => {
  // message 里出现 "kind" 是中文报错的常见情况（比如「kind 不匹配」）
  const out = '__RESULT__ {"ok":false,"kind":"dirty_engine","message":"kind 不对，先重装"}\n'
  assert.equal(callFn(out, 'kind'), 'dirty_engine')
})

test('没有结果行时返回空串（调用方据此走兜底分支，不能崩）', () => {
  assert.equal(callFn('nothing here\n', 'kind'), '')
})

test('多行结果行时取最后一行（一次运行只该有一行，多行说明中途重入）', () => {
  const out = '__RESULT__ {"kind":"first"}\n__RESULT__ {"kind":"second"}\n'
  assert.equal(callFn(out, 'kind'), 'second')
})

test('结果行里字段顺序不同也能取对', () => {
  const out = '__RESULT__ {"kind":"incomplete_backup","ok":false,"applied":0}\n'
  assert.equal(callFn(out, 'kind'), 'incomplete_backup')
  assert.equal(callFn(out, 'ok'), 'false')
})

test('install.sh 的分支只引用这些提取出来的字段（不再 grep 中文）', () => {
  const src = fs.readFileSync(path.join(repo, 'install.sh'), 'utf8')
  // 允许的例外：在给人看的说明文字里提到中文没问题，这里只查「用于判分支的 grep」
  const bad = src.split('\n').filter((l) => /grep\s+-q/.test(l))
  assert.deepEqual(bad, [], '还有按中文文案判分支的 grep：\n' + bad.join('\n'))
})
