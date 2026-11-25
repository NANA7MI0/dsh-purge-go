import test from 'node:test'
import assert from 'node:assert/strict'

import {
  looksLikeRefusal,
  scrubMessages,
  voidNoteFor,
  VOID_TEXT,
  VOID_TEXT_EN,
  MAX_LEN,
  installScrub,
  uninstallScrub,
} from '../lib/scrub.js'

/** 造一条 assistant 消息 */
function asst(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}
function user(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

test('looksLikeRefusal：该认的拒绝要认出来', () => {
  const yes = [
    "I'm sorry, but I can't help with that.",
    'I cannot assist with this request.',
    "I can't provide that information.",
    'I am unable to help with that.',
    'Sorry, I cannot do that.',
    'As an AI, I cannot provide that.',
    'I must decline this request.',
    '抱歉，我不能协助这个请求。',
    '对不起，我无法提供这些内容。',
    '我不能帮助你完成这个。',
    '作为一个AI，我不能这样做。',
    '我必须拒绝这个请求。',
    '这个问题不适合我回答。',
  ]
  for (const s of yes) assert.equal(looksLikeRefusal(s), true, '应判为拒绝：' + s)
})

test('looksLikeRefusal：真实会话里抓出来的误伤句必须全部放行', () => {
  // 这些是用 5919 条真实 assistant 消息跑出来的误伤（审查时实测 15/15 全中），
  // 全是「说明做不了 + 给下一步」或「干活前定计划」，不是拒答。
  // 把整条作废会让模型丢掉替代方案、忘掉自己刚定的计划。
  const real = [
    'Unfortunately, I cannot reproduce the bug with the snippet you gave.',
    'Sorry, I cannot confirm the exact line number without the file.',
    'I cannot help but notice that your config has a typo.',
    "I can't answer that without knowing your Node version — could you run node -v?",
    '抱歉，我无法在本地复现这个问题，需要你贴一下报错原文。',
    '这个问题不能用正则解决，需要解析 AST。下面给出方案……',
    '这个请求不适合用 GET，应该用 POST。',
    '我无法完成这个操作，因为权限不足（EACCES）。',
    '我不能帮助你复现这个问题，除非你提供完整日志。',
    '该内容不适合直接放进 system prompt，建议改成 developer 段。',
    '这个问题必须先看代码才能回答，不能凭印象。',
    '这个问题需要实际验证：我先确认 dsh-go 环境里能不能运行它。',
    '这个问题很关键：让我按 README 走一遍，看新用户能不能装上。',
    '这个问题得看代码才能回答，不能凭印象。我先查一键注入的实际流程。',
    '这个问题必须实际测试，不能只看单元测试结果。',
  ]
  for (const s of real) assert.equal(looksLikeRefusal(s), false, '不该作废：' + s)
})

test('looksLikeRefusal：正常正文绝不能误伤', () => {
  const no = [
    '好的，我来说明一下这个机制的原理。',
    '抱歉刚才理解错了，你的意思是 A 还是 B？',
    'I apologize for the confusion earlier — here is the corrected code.',
    "I can't believe this works, but it does: the patch succeeds.",
    'You cannot use the API without a token, so first obtain one.',
    'This is a list of common refusal patterns: "I cannot", "抱歉我无法".',
    '不能直接改，需要先备份。',
    '我可以帮你做这个。',
    '',
  ]
  for (const s of no) assert.equal(looksLikeRefusal(s), false, '不该判为拒绝：' + s)
})

test('looksLikeRefusal：真实拒绝形态要认出来（含 because / 中间夹修饰）', () => {
  const real = [
    "I'm sorry, but I can't help with that.",
    'I cannot assist with this request.',
    "I can't provide that information.",
    'I am unable to help with that.',
    'I must decline this request.',
    'I cannot help you because this would be harmful.',
    "I can't do that because it violates the platform rules.",
    "I can't assist with this request because it targets a third party.",
    '抱歉，我不能协助这个请求。',
    '对不起，我无法提供这些内容。',
    '我不能帮助你完成这个。',
    '作为一个AI，我不能这样做。',
    '我必须拒绝这个请求。',
    '我无法直接给出可运行的利用代码。',
  ]
  for (const s of real) assert.equal(looksLikeRefusal(s), true, '该判为拒绝：' + s)
})

test('looksLikeRefusal：已知取舍——「拒绝 + 转折」故意不作废', () => {
  // 这些确实是拒绝，但后半段是真东西（替代方案、能说的部分）。
  // 整条替换会把后半段一起删掉，模型下一轮拿不到任何可接的东西。
  // 所以选择不作废：拒绝惯性照旧，但不会让模型断片。
  // 真要处理得把消息拆成两半，切分点判错会切断正常内容，风险大于收益。
  const knownTradeoff = [
    'I cannot provide that, but you can read the official docs.',
    'I cannot comply, although you can ask the maintainers.',
    '抱歉，我不能协助你完成这个请求，但你可以在官方文档里找到答案。',
    '我无法提供具体步骤，不过你可以参考公开资料。',
    '抱歉，我不能直接帮你写这个，建议你咨询专业人士。',
  ]
  for (const s of knownTradeoff) assert.equal(looksLikeRefusal(s), false, '当前实现按取舍放行：' + s)
})

test('looksLikeRefusal：超长回复不碰（正文里的客套不算拒绝）', () => {
  const long = "I'm sorry, but I can't help with that. " + '后续正文'.repeat(MAX_LEN)
  assert.equal(long.length > MAX_LEN, true)
  assert.equal(looksLikeRefusal(long), false)
})

test('looksLikeRefusal：拒绝句式出现在正文中段不算', () => {
  const s = '先说结论：这个方案可行。'.repeat(20) + ' 抱歉，我不能提供更多细节。'
  assert.equal(looksLikeRefusal(s), false)
})

test('scrubMessages：只改 assistant 的拒绝，别的一概不动', () => {
  const messages = [
    user('帮我写一段代码'),
    asst("I'm sorry, but I can't help with that."),
    user('换个说法，就写个排序'),
    asst('好的，这是一个快速排序的实现。'),
  ]
  const out = scrubMessages(messages)
  assert.notEqual(out, messages, '有改动应返回新数组')
  assert.equal(out[0], messages[0], 'user 消息必须是同一个对象')
  assert.equal(out[2], messages[2], 'user 消息必须是同一个对象')
  assert.equal(out[3], messages[3], '正常回复必须是同一个对象')
  assert.equal(out[1].content[0].text, VOID_TEXT_EN, '英文拒绝拿英文文案')
  assert.equal(messages[1].content[0].text, "I'm sorry, but I can't help with that.", '原对象不能被改（deep-frozen）')
})

test('scrubMessages：没有可改的就原样返回同一个数组', () => {
  const messages = [user('问题'), asst('正常回答')]
  assert.equal(scrubMessages(messages), messages)
})

test('scrubMessages：enabled:false 时直接返回原数组', () => {
  const messages = [asst("I'm sorry, but I can't help.")]
  assert.equal(scrubMessages(messages, { enabled: false }), messages)
})

test('scrubMessages：非 text 块必须保住（tool_use 丢了会让上游报错）', () => {
  const toolUse = { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }
  const m = {
    role: 'assistant',
    content: [
      { type: 'text', text: "I'm sorry, but I can't help with that." },
      toolUse,
    ],
  }
  const out = scrubMessages([m])
  assert.equal(out[0].content.length, 2, 'tool_use + 作废文案，多一个少一个都不行')
  assert.equal(out[0].content[0].text, VOID_TEXT_EN, 'text 在最前（原来 text 就在最前）')
  assert.equal(out[0].content[1], toolUse, 'tool_use 块必须是同一个对象、原样保留')
})

test('scrubMessages：text 不在第一条时，作废文案追加到末尾', () => {
  const toolUse = { type: 'tool_use', id: 'tu_2', name: 'read', input: {} }
  const m = {
    role: 'assistant',
    content: [toolUse, { type: 'text', text: '抱歉，我不能协助这个请求。' }],
  }
  const out = scrubMessages([m])
  assert.equal(out[0].content.length, 2)
  assert.equal(out[0].content[0], toolUse, 'tool_use 保持原位置')
  assert.equal(out[0].content[1].text, VOID_TEXT, '中文拒绝拿中文文案')
})

test('voidNoteFor：英文会话用英文文案，中文会话用中文', () => {
  assert.equal(voidNoteFor('I cannot assist with that request.'), VOID_TEXT_EN)
  assert.equal(voidNoteFor('抱歉，我不能协助。'), VOID_TEXT)
  // 既没汉字也没字母（纯代码/纯数字）不算英文会话
  assert.equal(voidNoteFor('const x = 1;'), VOID_TEXT)
  assert.equal(voidNoteFor('12345'), VOID_TEXT)
  // 判「是不是英文会话」用比例，不用「有没有汉字」——
  // 英文会话里夹一句中文报错，不该因此退回中文文案
  assert.equal(voidNoteFor('ABC DEF GHI JKL 你好'), VOID_TEXT_EN, '字母远多于汉字 → 英文')
  assert.equal(voidNoteFor('I cannot do that. Error: 无法找到文件 ENOENT.'), VOID_TEXT_EN, '英文夹中文报错 → 英文')
  // 反过来，中文里夹英文术语不该判成英文
  assert.equal(voidNoteFor('抱歉，我不能直接改 DSH 的 index.js，那属于工作区文件。'), VOID_TEXT, '中文夹英文术语 → 中文')
})

test('scrubMessages：英文拒绝拿到英文作废文案', () => {
  const m = { role: 'assistant', content: [{ type: 'text', text: "I'm sorry, but I can't help with that." }] }
  const out = scrubMessages([m])
  assert.equal(out[0].content[0].text, VOID_TEXT_EN)
})

test('scrubMessages：seen 集合让 fresh 只算第一次', () => {
  const seen = new Set()
  const logs = []
  const mk = () => [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'text', text: '抱歉，我不能协助。' }] },
  ]
  scrubMessages(mk(), { onScrub: (i) => logs.push(i), seen })
  scrubMessages(mk(), { onScrub: (i) => logs.push(i), seen })
  scrubMessages(mk(), { onScrub: (i) => logs.push(i), seen })
  assert.deepEqual(logs.map((l) => l.fresh), [1, 0, 0], '只有第一次算新改的')
  assert.equal(logs[0].changed, 1, '每次都要如实说改了几条')
})

test('scrubMessages：seen 超过 500 条会清空（防长会话无限涨）', () => {
  const seen = new Set()
  for (let i = 0; i < 501; i++) seen.add('x' + i)
  const m = { role: 'assistant', content: [{ type: 'text', text: '抱歉，我不能协助。' }] }
  scrubMessages([m], { seen })
  assert.equal(seen.size <= 501, true, '清空后重新开始涨，不会无限大')
})

test('scrubMessages：连跑两轮结果文本完全一致（上游前缀缓存的前提）', () => {
  const mk = () => [
    { role: 'user', content: [{ type: 'text', text: '问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '抱歉，我不能协助。' }] },
    { role: 'user', content: [{ type: 'text', text: '换个问法' }] },
  ]
  const a = scrubMessages(mk())
  const b = scrubMessages(mk())
  const textA = JSON.stringify(a.map((m) => m.content))
  const textB = JSON.stringify(b.map((m) => m.content))
  assert.equal(textA, textB, '同样的输入必须产出同样的文本，否则每轮都让缓存失效')
})

test('scrubMessages：跨消息的 tool_use / tool_result 配对不被破坏', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '跑一下' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '抱歉，我不能协助。' },
        { type: 'tool_use', id: 'tu_9', name: 'bash', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: 'ok' }] },
  ]
  const out = scrubMessages(messages)
  const calls = out.filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content.filter((b) => b.type === 'tool_use').map((b) => b.id))
  const results = out.filter((m) => m.role === 'user')
    .flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id))
  assert.deepEqual(calls, ['tu_9'], 'tool_use 必须还在（丢了上游会 400）')
  assert.deepEqual(results, ['tu_9'], 'tool_result 本来就不该动')
  assert.equal(out[2], messages[2], 'tool_result 那条消息保持同一引用')
})

test('installScrub：两个实例不会互相删（热重载会碰到）', () => {
  uninstallScrub()
  const dA = installScrub({ getEnabled: () => true })
  const dB = installScrub({ getEnabled: () => true })
  assert.equal(typeof globalThis.__dshPurgeScrub, 'function')

  // A 卸的时候槽位里是 B —— 不能把 B 删掉，否则功能静默失效且无告警
  dA()
  assert.equal(typeof globalThis.__dshPurgeScrub, 'function', 'A 卸不能影响 B')

  // B 卸：槽位里就是自己，该删
  dB()
  assert.equal(globalThis.__dshPurgeScrub, undefined, 'B 卸才清空槽位')
})

test('installScrub：槽位可塞可摘', () => {
  assert.equal(typeof globalThis.__dshPurgeScrub, 'undefined')
  const dispose = installScrub({ getEnabled: () => true })
  assert.equal(typeof globalThis.__dshPurgeScrub, 'function')
  const out = globalThis.__dshPurgeScrub([asst("I'm sorry, but I can't help.")])
  assert.equal(out[0].content[0].text, VOID_TEXT_EN)
  dispose()
  assert.equal(globalThis.__dshPurgeScrub, undefined)
  uninstallScrub()
})
