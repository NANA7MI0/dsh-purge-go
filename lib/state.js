// 插件状态：<DSH_HOME>/dsh-purge/state.json。
// 桌面版把「应用/回滚」做成改引擎文件；这里没有引擎补丁，开关与计数就落在这个文件里。
import { readJson, statePath, writeJson, dshHome } from './home.js'

export const STATE_VERSION = 1

/** @returns {{version:number,enabled:boolean,variant:string,byModel:Record<string,string>,seededAt:string,lastApplyAt:string,lastBytes:number,lastSource:string,lastModel:string,lastAt:string}} */
export function readState(home = dshHome()) {
  const raw = readJson(statePath(home), {}) || {}
  const byModel = {}
  if (raw.byModel && typeof raw.byModel === 'object') {
    for (const [key, value] of Object.entries(raw.byModel)) {
      if (typeof value === 'string' && value.trim()) byModel[key] = value.trim()
    }
  }
  return {
    version: STATE_VERSION,
    enabled: raw.enabled !== false,
    variant: typeof raw.variant === 'string' && raw.variant.trim() ? raw.variant.trim() : 'default',
    byModel,
    seededAt: typeof raw.seededAt === 'string' ? raw.seededAt : '',
    lastApplyAt: typeof raw.lastApplyAt === 'string' ? raw.lastApplyAt : '',
    lastBytes: Number.isFinite(raw.lastBytes) ? raw.lastBytes : 0,
    lastSource: typeof raw.lastSource === 'string' ? raw.lastSource : '',
    lastModel: typeof raw.lastModel === 'string' ? raw.lastModel : '',
    lastAt: typeof raw.lastAt === 'string' ? raw.lastAt : '',
  }
}

export function writeState(home, patch) {
  // 读-改-写之间别人也可能在写：更新收尾是独立子进程（settle），
  // 而引擎内的 toggle / 一键注入在同一时刻也会改 state.json。
  // 两边各自 read 再 write，后写的那次会把先写的字段整个盖掉——
  // 典型表现是「更新完 enabled 恢复了，但用户刚设的变体没了」。
  //
  // 没有跨进程锁可用（proot 里没有 flock 命令），用「写完回读、发现自己的 patch
  // 没生效就重来」这种乐观重试包住绝大多数情况。窗口是毫秒级，重试 3 次足够。
  const target = statePath(home)
  let next = null
  for (let i = 0; i < 3; i++) {
    next = { ...readState(home), ...(patch || {}), version: STATE_VERSION }
    writeJson(target, next)
    // 回读确认自己的改动还在
    let back = null
    try { back = readState(home) } catch { back = null }
    if (!back) return next
    const ok = Object.entries(patch || {}).every(([k, v]) => {
      const got = back[k]
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return got && typeof got === 'object'
          && Object.entries(v).every(([k2, v2]) => JSON.stringify(got[k2]) === JSON.stringify(v2))
      }
      return JSON.stringify(got) === JSON.stringify(v)
    })
    if (ok) return next
    // 没生效说明被别人的写覆盖了，重来一次（这次会读到对方刚写的值）
  }
  return next
}

export function setEnabled(home, enabled) {
  return writeState(home, { enabled: Boolean(enabled), lastApplyAt: new Date().toISOString() })
}

export function setVariant(home, variant) {
  return writeState(home, { variant: String(variant || 'default') })
}

export function setModelVariant(home, modelKey, variant) {
  const state = readState(home)
  const byModel = { ...state.byModel }
  if (variant && variant !== 'default') byModel[modelKey] = variant
  else delete byModel[modelKey]
  return writeState(home, { byModel })
}

/** 记录一次真实注入（只留最后一次，够面板显示就行）。 */
export function noteInject(home, { bytes, source, model }) {
  return writeState(home, {
    lastBytes: Number.isFinite(bytes) ? bytes : 0,
    lastSource: String(source || ''),
    lastModel: String(model || ''),
    lastAt: new Date().toISOString(),
  })
}
