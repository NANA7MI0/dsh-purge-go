// 红队技能与预设：把随包的 skills/redteam/*.md 与 presets/redteam/ 落到用户目录，
// 让手机端（PRoot）也能用同一套「技能库 + 红队模式」。
//
// 只做文件同步，不做注册：预设目录 `<DSH_HOME>/.agent-presets/redteam/` 是宿主自己会扫的
// 位置，写进去就等于注册；这也避开了 registry.register() 那套需要解析 YAML 的接口。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const packagedSkillsDir = () => join(PKG_ROOT, 'skills', 'redteam')
export const packagedPresetDir = () => join(PKG_ROOT, 'presets', 'redteam')
export const skillsTargetDir = (home) => join(home, 'redteam', 'skills')
export const presetTargetDir = (home) => join(home, '.agent-presets', 'redteam')

function listFiles(dir, ext) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(ext)).sort()
  } catch {
    return []
  }
}

function writeIfChanged(target, text) {
  try {
    if (existsSync(target) && readFileSync(target, 'utf8') === text) return false
  } catch {
    /* 读不到就按需要写 */
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
  return true
}

/** 随包技能 → `<home>/redteam/skills/`。内容不同才写，返回写了几个。 */
export function syncSkills(home) {
  const from = packagedSkillsDir()
  const files = listFiles(from, '.md')
  const to = skillsTargetDir(home)
  let written = 0
  for (const name of files) {
    let text
    try {
      text = readFileSync(join(from, name), 'utf8')
    } catch {
      continue
    }
    if (writeIfChanged(join(to, name), text)) written += 1
  }
  return { total: files.length, written, dir: to }
}

/**
 * 随包预设 → `<home>/.agent-presets/redteam/`。
 * 用户已经有一份时默认不动（自己改过的东西不该被覆盖）；`refresh: true` 或
 * 环境变量 `REDTEAM_PRESET_REFRESH=1` 才重写。
 */
export function syncPreset(home, { refresh = false } = {}) {
  const from = packagedPresetDir()
  const to = presetTargetDir(home)
  const files = listPresetFiles(from)
  const exists = existsSync(join(to, 'agent.cordis.yml'))
  const force = refresh || String(process.env.REDTEAM_PRESET_REFRESH || '') === '1'
  if (exists && !force) {
    return { action: 'kept', dir: to, files: files.length }
  }
  let written = 0
  for (const name of files) {
    let text
    try {
      text = readFileSync(join(from, name), 'utf8')
    } catch {
      continue
    }
    if (writeIfChanged(join(to, name), text)) written += 1
  }
  return { action: exists ? 'refreshed' : 'installed', dir: to, files: files.length, written }
}

function listPresetFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => /\.(yml|mjs|md)$/i.test(name))
      .sort()
  } catch {
    return []
  }
}

/** 面板/状态行要的那点信息：技能几个、预设装没装。 */
export function redteamSummary(home) {
  let skills = 0
  try {
    skills = listFiles(skillsTargetDir(home), '.md').length
  } catch {
    skills = 0
  }
  let preset = false
  try {
    preset = statSync(join(presetTargetDir(home), 'agent.cordis.yml')).isFile()
  } catch {
    preset = false
  }
  return { skills, preset }
}
