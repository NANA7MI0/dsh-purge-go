// 防线测试。每一条都对应一个真实踩过的坑，改回去就会变红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply, restore } from '../patches/lib/core.mjs'
import {
  missingBackupFiles, countPatchTraces, hasPatchTraces,
  findReusableBackup, pruneOtherBackups, patchRevert,
} from '../lib/ops.js'

/** 造一个最小引擎：一个包里一个可替换的文件。 */
function fakeEngine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-guard-'))
  const dir = path.join(root, 'dsh-alpha', 'lib')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const x = "OLD_JS_TOKEN"\n')
  return root
}

/** 一个假 home，里面给一个空的 patch-backup 目录。 */
function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-home-'))
  fs.mkdirSync(path.join(home, 'dsh-purge', 'patch-backup'), { recursive: true })
  return home
}

test('restore：App 版本变了不拒绝还原（只警告）', () => {
  // 守「App 更新后补丁层死锁」：restore 曾因 appMismatch 直接 return，
  // 而面板「一键注入」必经一次 restore 还原，于是补丁打不上、还原也撤不掉。
  const root = fakeEngine()
  const backupDir = path.join(root, 'bk')
  apply(root, {
    backupDir,
    patches: [{
      id: 940, name: 'X', file: 'alpha', rel: ['lib', 'index.js'],
      replacements: [{ pattern: 'OLD_JS_TOKEN', replace: 'NEW' }],
      markers: ['NEW'],
    }],
  })
  const mp = path.join(backupDir, 'manifest.json')
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'))
  m.engine = { ...(m.engine || {}), app: '0.0.1-old' }
  fs.writeFileSync(mp, JSON.stringify(m))

  const r = restore(backupDir, { root })
  assert.equal(r.errors.length, 0, 'App 版本不同不该算错误——引擎包没换，还原没有风险')
  assert.ok(r.restored > 0, '文件要真的写回去')
})

test('missingBackupFiles：按 {rel,hash} 对象读，缺一个就报一个', () => {
  const root = fakeEngine()
  const backupDir = path.join(root, 'bk2')
  apply(root, {
    backupDir,
    patches: [{
      id: 941, name: 'Y', file: 'alpha', rel: ['lib', 'index.js'],
      replacements: [{ pattern: 'OLD_JS_TOKEN', replace: 'NEW' }],
      markers: ['NEW'],
    }],
  })
  assert.deepEqual(missingBackupFiles(backupDir), [], '完整备份不该报缺')

  const rels = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')).files
  const first = typeof rels[0] === 'string' ? rels[0] : (rels[0] && rels[0].rel)
  assert.ok(first, 'manifest 必须记了文件路径，否则下面的断言是空转')
  fs.rmSync(path.join(backupDir, 'files', first), { force: true })
  const miss = missingBackupFiles(backupDir)
  assert.equal(miss.length, 1, '缺一个就报一个')
  assert.equal(miss[0], first)
})

test('countPatchTraces：干净时为 0，打完大于 0', () => {
  const root = fakeEngine()
  assert.equal(countPatchTraces(root), 0, '原始引擎一个标记都没有')
  apply(root, {
    backupDir: path.join(root, 'bk3'),
    patches: [{
      id: 942, name: 'Z', file: 'alpha', rel: ['lib', 'index.js'],
      replacements: [{ pattern: 'OLD_JS_TOKEN', replace: 'NEW // [dsh-purge] z' }],
      markers: ['[dsh-purge] z'],
    }],
  })
  assert.ok(countPatchTraces(root) > 0, '打完至少有一个文件带标记')
})

test('countPatchTraces 能扫到 presets 子目录（旧版盲区）', () => {
  // 旧实现 looks = [lib, '', dist, src]，扫不到 dsh-web-app/presets/*.patch.yml。
  // 后果：把「还有补丁」的引擎判成干净 → 存出脏备份 → 之后补丁层锁死。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-presets-'))
  const dir = path.join(root, 'dsh-web-app', 'presets')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'standard.patch.yml'), 'prefix: "" # [dsh-purge] mark')
  assert.equal(countPatchTraces(root), 1, 'presets 下的标记必须数得到')
  assert.equal(hasPatchTraces(root), true)
})

test('findReusableBackup：备份缺一个当前目标文件就不复用', () => {
  // 守「旧备份覆盖不全把引擎打残」：只要求「文件数 >= 20」时，
  // 一份 41 文件的旧备份看着像样，但目标涨到 47 个，缺的 6 个不会被还原，
  // 引擎停在「一半原始一半补丁」的混合态。
  const home = fakeHome()
  const version = '9.9.9-test'
  const dir = path.join(home, 'dsh-purge', 'patch-backup', 'x1')
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  // manifest 只记 24 条（跨得过「至少 20」那道门槛），但当前目标有 25 个。
  // 注意区分两件事：
  //   · requiredRels 管的是「manifest 里压根没记这个文件」——它还原时会跳过，留在补丁态；
  //   · missingBackupFiles 管的是「manifest 记了但 files/ 里没有」——那是备份本身坏了。
  // 这条测的是前者，所以磁盘上 24 个文件全都要在。
  const files = []
  for (let i = 0; i < 24; i++) {
    const rel = 'pkg/f' + i + '.js'
    files.push({ rel, hash: 'h' })
    fs.mkdirSync(path.dirname(path.join(dir, 'files', rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, 'files', rel), 'ok')
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    root: '/x', at: '2026-11-20T00:00:00.000Z', engine: { version }, files,
  }))
  const required = new Set([...files.map((f) => f.rel), 'pkg/f24.js'])   // 25 个都要，第 25 个备份里没有
  assert.equal(findReusableBackup(home, version, { requiredRels: required }), null,
    '缺一个目标文件就不能复用')

  // 不传 requiredRels 时按老行为仍可选（向后兼容）
  assert.ok(findReusableBackup(home, version), '不传 requiredRels 时不该硬拦')
})

test('pruneOtherBackups：keepDir 不在备份根下时一份都不删', () => {
  // 守「跨目录 --backup 把 home 旧备份全清光」。
  const home = fakeHome()
  const base = path.join(home, 'dsh-purge', 'patch-backup')
  fs.mkdirSync(path.join(base, 'old1'), { recursive: true })
  fs.mkdirSync(path.join(base, 'old2'), { recursive: true })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-outside-'))
  pruneOtherBackups(home, outside)
  assert.deepEqual(fs.readdirSync(base).sort(), ['old1', 'old2'],
    'keepDir 在备份根之外时不该动这里的东西')

  // 同根时正常清理，只留 keep 的那份
  pruneOtherBackups(home, path.join(base, 'old1'))
  assert.deepEqual(fs.readdirSync(base), ['old1'], '同根时只留 keepDir')
})

test('patchRevert：还原后引擎还有残留时不能报成功', () => {
  // 守「覆盖不全的备份还原完还留着补丁、却弹已还原 N 个文件」。
  // 做法：先在一个临时引擎上打两个文件，只备份其中一个，然后调 patchRevert。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purge-residue-"))
  fs.mkdirSync(path.join(root, "dsh-alpha", "lib"), { recursive: true })
  fs.mkdirSync(path.join(root, "dsh-beta", "lib"), { recursive: true })
  fs.writeFileSync(path.join(root, "dsh-alpha", "lib", "index.js"), "A_OLD" + String.fromCharCode(10))
  fs.writeFileSync(path.join(root, "dsh-beta", "lib", "index.js"), "B_OLD" + String.fromCharCode(10))
  const patches = [{
    id: 950, name: "TWO", targets: [
      { pkg: "dsh-alpha", rel: ["lib", "index.js"] },
      { pkg: "dsh-beta", rel: ["lib", "index.js"] },
    ],
    replacements: [
      { pattern: "A_OLD", replace: "A_NEW // [dsh-purge] a" },
      { pattern: "B_OLD", replace: "B_NEW // [dsh-purge] b" },
    ],
    markers: ["[dsh-purge] a", "[dsh-purge] b"],
  }]
  // 备份只覆盖 alpha 一个文件：manifest 里也只记一个，绕过 requiredRels
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge-residue-home-"))
  const bk = path.join(home, "dsh-purge", "patch-backup", "only-alpha")
  fs.mkdirSync(path.join(bk, "files", "dsh-alpha", "lib"), { recursive: true })
  fs.writeFileSync(path.join(bk, "files", "dsh-alpha", "lib", "index.js"), "A_OLD" + String.fromCharCode(10))
  apply(root, { backupDir: path.join(root, "tmpbk"), patches })
  fs.writeFileSync(path.join(bk, "manifest.json"), JSON.stringify({
    root, at: "2026-11-20T00:00:00.000Z",
    engine: { version: "0.2.2-rc.1" },
    files: [{ rel: "dsh-alpha/lib/index.js", hash: "h" }],
  }))
  const r = patchRevert(home, { root })
  // 不管它最后选的是哪份，只要引擎还带痕迹就不能 ok
  if (r.ok) {
    assert.equal(countPatchTraces(root), 0, "报了 ok 就必须真的撤干净")
  } else {
    assert.ok(String(r.reason || "").length > 0, "失败要给出原因")
  }
})