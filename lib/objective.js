/**
 * 当前靶标的目标卡（桌面版 lib/redteam/objective-card.js 的手机内核版）。
 *
 * 只读 `<DSH_HOME>/redteam/current` 与 `engagements/<id>/engagement.yaml`，
 * 不打开工具模块、不开 sqlite、不做网络请求 —— PRoot 上也能直接用。
 * 没有当前靶标时返回空串，绝不编一个目标出来。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './home.js'

export function redteamRoot(home = dshHome()) {
  const env = String(process.env.DSH_REDTEAM_HOME || '').trim()
  return env || join(home, 'redteam')
}

function safeEngagementId(id) {
  const text = String(id || '').trim()
  if (!text || text.length > 200) return ''
  if (text.includes('..') || text.includes('/') || text.includes('\\') || text.includes('\0')) return ''
  return text
}

function readMeta(path) {
  if (!existsSync(path)) return null
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const matched = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!matched) continue
    const value = matched[2].trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      out[matched[1]] = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else {
      out[matched[1]] = value.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

/** 当前靶标 id（没有就返回空串）。面板与命令都用它判断「有没有在打东西」。 */
export function currentEngagementId(home = dshHome()) {
  try {
    return safeEngagementId(readFileSync(join(redteamRoot(home), 'current'), 'utf8'))
  } catch {
    return ''
  }
}

/** 没有当前靶标时返回空串。 */
export function readObjectiveCard(home = dshHome()) {
  try {
    const root = redteamRoot(home)
    const id = currentEngagementId(home)
    if (!id) return ''
    const meta = readMeta(join(root, 'engagements', id, 'engagement.yaml'))
    const name = String(meta?.target_name || '').trim()
    if (!name) return ''
    const scope = Array.isArray(meta.scope_cidrs) ? meta.scope_cidrs.map((item) => String(item).trim()).filter(Boolean) : []
    const scopeLine = scope.length > 0 ? scope.join('、') : '只打这个单位名下的资产'
    return [
      '## 本次目标',
      `只打：${name}`,
      `范围：${scopeLine}`,
      '不打：回报里带出来的其它单位。只有用户明确说出新的单位名称，才改打新目标。',
    ].join('\n')
  } catch {
    return ''
  }
}
