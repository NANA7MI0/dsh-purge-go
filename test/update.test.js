// 更新检测的版本比较与提示文案——纯函数，不碰网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersion } from '../lib/update.js'

test('compareVersion：三段数字逐位比较', () => {
  assert.ok(compareVersion('0.6.2', '0.6.1') > 0)
  assert.ok(compareVersion('0.6.1', '0.6.2') < 0)
  assert.equal(compareVersion('0.6.1', '0.6.1'), 0)
})

test('compareVersion：忽略前导 v', () => {
  assert.equal(compareVersion('v0.6.1', '0.6.1'), 0)
  assert.ok(compareVersion('v0.7.0', '0.6.9') > 0)
})

test('compareVersion：位数不同按缺失补 0', () => {
  assert.equal(compareVersion('0.6', '0.6.0'), 0)
  assert.ok(compareVersion('0.6.1', '0.6') > 0)
  assert.ok(compareVersion('1.0.0', '0.9.9') > 0)
})

test('compareVersion：非法输入当 0', () => {
  assert.equal(compareVersion('', ''), 0)
  assert.equal(compareVersion('abc', '0.0.0'), 0)
})