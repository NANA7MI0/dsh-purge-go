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
  const next = { ...readState(home), ...(patch || {}), version: STATE_VERSION }
  writeJson(statePath(home), next)
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
