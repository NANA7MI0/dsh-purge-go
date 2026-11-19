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
    // 插件用 ctx.get('dshGo', false) 拿服务（不声明 inject 也能拿），所以挂在这里
    get: (name) => (name === 'dshGo' ? base.dshGo : undefined),
    dshGo: {
      strip: (id, producer) => record.strips.push({ id, producer }),
      panel: (id, options) => record.panels.push({ id, options }),
      on: (id, handler) => record.actions.push({ id, handler }),
      refresh: () => {},
    },
    // tools 现在由顶层 inject 保证就绪，apply 里直接 ctx.tools.register()
    tools: { register: (definition) => record.tools.push(definition) },
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
  assert.deepEqual(pluginInject, ['systemPrompt', 'tools'])
  assert.equal(typeof apply, 'function')
})

test('apply：注册三个段、三个事件、六个工具、一条命令、原生界面', () => {
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
    'agent/status',
    'system-prompt/assemble',
  ])

  assert.deepEqual(record.tools.map((tool) => tool.name).sort(), ['purge_apply', 'purge_category', 'purge_patch_apply', 'purge_prompt', 'purge_revert', 'purge_status'])
  for (const tool of record.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
  assert.equal(record.commands[0].name, 'purge')

  // 面板：view 只返回静态骨架（值全是 { $: 'data.x' } 绑定），
  // 取数在 data() 里、30 秒推一次。旧版把扫盘塞进 view，App 每次重绘都跑一遍，
  // 在手机上把整机拖死过一次。
  //
  // 状态条只做「异常告警」：补丁被 App 更新冲掉、或注入层被关掉时才现身
  // （正常时推空字符串，App 那边 text 为空就不画）。入口胶囊另走 composer.actions。
  assert.equal(record.strips.length, 1, '状态条注册一个（异常告警用）')
  assert.equal(record.strips[0].id, 'purge-alert')
  assert.equal(record.panels.length, 1, '面板注册一个')
  assert.equal(record.panels[0].id, 'status')
  assert.ok(record.panels[0].options.view, '面板要有 view')
  assert.equal(typeof record.panels[0].options.data, 'function', '面板要有 data')
  assert.equal(typeof record.panels[0].options.actions.refresh, 'function')
  // 胶囊是静态 effect:insert，App 直接执行，不需要 on() handler。
  assert.deepEqual(record.actions, [], '不再注册任何 on() handler')

  // 拒答续跑要真的挂上：pre-step 一个，status 一个。
  // （原来的地区门已删除——它与破甲的定位相反，且会全局生效、把攻击类任务的回答清空。）
  const preSteps = record.events.filter((entry) => entry.event === 'agent/pre-step')
  assert.equal(preSteps.length, 1)
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
