// missingTargets 的两种缺失都要认。
//
// 这个函数的两个副本曾经分叉（prepare.js 一份、topup.js 一份，逻辑还不一样），
// 直接后果是「算出来缺 3 个、却一个也没补」，用户卡在「备份不完整」被要求重装引擎。
// 现在只有 lib/backup-files.js 一份，测试也盯这一份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { missingTargets } from '../lib/backup-files.js'

function makeBackup(files, manifestRels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-bf-'))
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  for (const rel of files) {
    const p = path.join(dir, 'files', rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'original')
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ files: manifestRels.map((rel) => ({ rel, size: 8, sha256: 'x' })) })
  )
  return dir
}

test('目标里有、manifest 里没有 → 算缺（补丁目标长大了）', () => {
  const dir = makeBackup(['a/x.js'], ['a/x.js'])
  assert.deepEqual(missingTargets(dir, ['a/x.js', 'b/new.js']), ['b/new.js'])
})

test('manifest 里记了、磁盘上没有 → 也算缺（备份被截断）', () => {
  const dir = makeBackup([], ['a/gone.js'])
  assert.deepEqual(missingTargets(dir, ['a/gone.js']), ['a/gone.js'])
})

test('两种都齐 → 一个都不缺', () => {
  const dir = makeBackup(['a/x.js'], ['a/x.js'])
  assert.deepEqual(missingTargets(dir, ['a/x.js']), [])
})

test('manifest 读不出来（损坏/缺失）→ 返回空，不瞎补', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-bf-'))
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  assert.deepEqual(missingTargets(dir, ['a/x.js']), [])
})

test('同一路径重复出现在 targets 里 → 结果里也重复（去重由调用方做）', () => {
  const dir = makeBackup([], ['a/x.js'])
  assert.deepEqual(missingTargets(dir, ['a/x.js', 'a/x.js']), ['a/x.js', 'a/x.js'])
})
