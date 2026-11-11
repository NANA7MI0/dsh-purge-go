import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, name as pluginName, inject as pluginInject } from '../lib/index.js'
import { readState, setEnabled } from '../lib/state.js'
import { injectPath } from '../lib/home.js'

/** 最小宿主：把 cordis 的几处扩展点记下来，并按 ctx.inject 立刻回调。 */
function fakeHost() {
  const record = { sections: [], events: [], tools: [], commands: [], strips: [], panels: [], actions: [] }
  const systemPrompt = { section: (section) => record.sections.push(section) }
  const base = {
    systemPrompt,
    on: (event, handler, options) => record.events.push({ event, handler, options }),
    inject: (names, callback) => {
      const scoped = {
        tools: { register: (definition) => record.tools.push(definition) },
        commands: { register: (command) => record.commands.push(command) },
        dshGo: {
          strip: (id, producer) => record.strips.push({ id, producer }),
          panel: (id, options) => record.panels.push({ id, options }),
          on: (id, handler) => record.actions.push({ id, handler }),
          refresh: () => {},
        },
      }
      const picked = {}
      for (const name of names) picked[name] = scoped[name]
      callback({ ...base, ...picked, ...scoped })
      return () => {}
    },
  }
  return { ctx: base, record }
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'purge-go-load-'))
}

test('导出形状：name / inject / apply', () => {
  assert.equal(pluginName, 'dsh-purge-go')
  assert.deepEqual(pluginInject, ['systemPrompt'])
  assert.equal(typeof apply, 'function')
})

test('apply：注册三个段、三个事件、四个工具、一条命令、原生界面', () => {
  const home = tempHome()
  const { ctx, record } = fakeHost()
  apply(ctx, { home })

  assert.deepEqual(record.sections.map((section) => section.name), ['dsh-purge', 'dshpg-capabilities'])
  for (const section of record.sections) {
    assert.equal(section.interpolate, false)
    assert.ok(Number.isFinite(section.order))
    assert.ok(section.order < 0, '注入段必须排在官方身份段之前')
  }
  assert.deepEqual(record.events.map((entry) => entry.event).sort(), [
    'agent/pre-step',
    'agent/pre-step',
    'agent/status',
    'system-prompt/assemble',
  ])

  assert.deepEqual(record.tools.map((tool) => tool.name).sort(), ['purge_apply', 'purge_category', 'purge_prompt', 'purge_revert', 'purge_status'])
  for (const tool of record.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
  assert.equal(record.commands[0].name, 'purge')

  assert.deepEqual(record.strips.map((entry) => entry.id), ['state'])
  assert.deepEqual(record.panels.map((entry) => entry.id).sort(), ['prompt', 'purge'])
  assert.deepEqual(record.actions.map((entry) => entry.id).sort(), ['body', 'reload', 'toggle'])

  // 地区门与拒答续跑都要真的挂上：pre-step 两个（mnemon 过滤 + 地区门），status 一个
  const preSteps = record.events.filter((entry) => entry.event === 'agent/pre-step')
  assert.equal(preSteps.length, 2)
  assert.equal(record.events.some((entry) => entry.event === 'agent/status'), true)
})

test('apply：首次启动落盘默认正文，并按 enabled 初始化状态', () => {
  const home = tempHome()
  const { ctx } = fakeHost()
  apply(ctx, { home })
  assert.ok(fs.existsSync(injectPath(home)))
  assert.equal(readState(home).enabled, true)

  const home2 = tempHome()
  apply(fakeHost().ctx, { home: home2, enabled: false })
  assert.equal(readState(home2).enabled, false)
})

test('assemble 钩子：开启时把注入正文顶到最前，关闭时原样返回', async () => {
  const home = tempHome()
  const { ctx, record } = fakeHost()
  apply(ctx, { home })
  const assemble = record.events.find((entry) => entry.event === 'system-prompt/assemble').handler

  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'identity' },
      { name: 'tools', text: 'tools' },
    ],
    variables: { model: 'vendor/model:free' },
  }
  const next = async () => assembly
  const out = await assemble(assembly, { agent: {} }, next)

  assert.equal(out.sections[0].name, 'dsh-purge')
  assert.equal(out.sections.some((section) => section.name === 'harness:identity'), false)
  assert.ok(out.sections[0].text.length > 1000, '应当注入完整正文')

  setEnabled(home, false)
  const off = await assemble(assembly, { agent: {} }, next)
  assert.equal(off.sections.length, 2)
  assert.equal(off.sections[0].name, 'harness:identity')
})

test('工具 purge_status / purge_apply / purge_revert / purge_prompt 真实读写状态', async () => {
  const home = tempHome()
  const { ctx, record } = fakeHost()
  apply(ctx, { home })
  const tool = (toolName) => record.tools.find((entry) => entry.name === toolName)

  const status = await tool('purge_status').execute({})
  assert.equal(status.enabled, true)
  assert.ok(status.bytes > 0)
  assert.equal(status.variants, 0)

  const revert = await tool('purge_revert').execute({})
  assert.equal(revert.enabled, false)
  assert.equal(readState(home).enabled, false)

  const applied = await tool('purge_apply').execute({})
  assert.equal(applied.enabled, true)
  assert.equal(readState(home).enabled, true)

  const set = await tool('purge_prompt').execute({ action: 'set', text: 'CUSTOM BODY\n' })
  assert.equal(set.ok, true)
  assert.equal(fs.readFileSync(injectPath(home), 'utf8').trim(), 'CUSTOM BODY')

  const shown = await tool('purge_prompt').execute({ action: 'show' })
  assert.match(shown.preview, /CUSTOM BODY/)
})

test('命令 /purge：status / prompt set / variant use', async () => {
  const home = tempHome()
  const { ctx, record } = fakeHost()
  apply(ctx, { home })
  const handler = record.commands[0].handler

  const status = await handler({ rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /破甲：开/)

  const bodyFile = path.join(home, 'body.md')
  fs.writeFileSync(bodyFile, 'FROM FILE\n', 'utf8')
  const set = await handler({ rawInput: `prompt set ${bodyFile}` })
  assert.equal(set.kind, 'success')
  assert.match(fs.readFileSync(injectPath(home), 'utf8'), /FROM FILE/)

  const bad = await handler({ rawInput: 'prompt set /nope/missing.md' })
  assert.equal(bad.kind, 'error')

  const help = await handler({ rawInput: 'help' })
  assert.match(help.text, /\/purge status/)
})
