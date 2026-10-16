import assert from 'node:assert/strict'
import test from 'node:test'
import { DONE, GatewayError, mapFinish, mapUsage, parseSSE, tapRouting, toBody, toWireMessages, translate } from '../lib/wire.js'

const text = (value) => [{ type: 'text', text: value }]
const collect = async (iterable) => {
  const items = []
  for await (const item of iterable) items.push(item)
  return items
}
async function* frames(...items) {
  for (const item of items) yield item
}
const delta = (extra, finish = null) => ({ choices: [{ index: 0, delta: extra, finish_reason: finish }] })

// ── 请求 ──────────────────────────────────────────────────────────────────────

test('系统提示：options.system 和开头的 system/developer 消息合并成第一条 system', () => {
  const wire = toWireMessages({
    system: 'S',
    messages: [
      { role: 'system', content: text('T') },
      { role: 'developer', content: text('D') },
      { role: 'user', content: text('hi') },
    ],
  })
  assert.deepEqual(wire, [{ role: 'system', content: 'S\n\nT\n\nD' }, { role: 'user', content: 'hi' }])
})

test('助手消息：思考保存在 reasoning_content，工具调用转成 tool_calls', () => {
  const wire = toWireMessages({
    messages: [
      { role: 'user', content: text('go') },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'ok' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"a":1}' }] },
      { role: 'tool', toolCallId: 'c1', content: text('done') },
    ],
  })
  assert.deepEqual(wire, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'ok', reasoning_content: 'hmm', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"a":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'done' },
  ])
})

test('一组工具调用没答完之前，插进来的通知先扣住，答完再放出', () => {
  const wire = toWireMessages({
    messages: [
      { role: 'user', content: text('go') },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'a', arguments: '{}' }, { type: 'tool-call', id: 'c2', name: 'b', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: text('r1') },
      { role: 'developer', content: text('notice') },
      { role: 'tool', toolCallId: 'c2', content: text('r2') },
      { role: 'user', content: text('next') },
    ],
  })
  // 通知是在这一组答完之前到的，所以必须排在后面的用户消息之前，而不是被甩到最后。
  assert.deepEqual(wire.map((item) => item.role), ['user', 'assistant', 'tool', 'tool', 'system', 'user'])
  assert.equal(wire[4].content, 'notice')
  assert.equal(wire[5].content, 'next')
})

test('空的工具输出用占位文字；空的用户消息直接跳过', () => {
  const wire = toWireMessages({
    messages: [
      { role: 'user', content: [] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'a', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: [] },
    ],
  })
  assert.deepEqual(wire.map((item) => item.role), ['assistant', 'tool'])
  assert.equal(wire[1].content, '(no output)')
})

test('图片消息：转成 text + image_url 内容块数组', () => {
  const images = new Map([['a1', { mediaType: 'image/png', base64: 'AQID' }]])
  const wire = toWireMessages({
    messages: [{ role: 'user', content: [{ type: 'text', text: '看这个' }, { type: 'image', attachment: { attachmentId: 'a1' } }] }],
  }, images)
  assert.deepEqual(wire, [{
    role: 'user',
    content: [
      { type: 'text', text: '看这个' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ],
  }])
})

test('图片没被解析时明确报错，不静默丢图', () => {
  assert.throws(() => toWireMessages({
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }],
  }), /没有被附件服务解析/)
})

test('请求体：带上工具和采样参数，没给的字段不出现', () => {
  const full = toBody({
    model: 'm', messages: [{ role: 'user', content: text('hi') }], temperature: 0.2, maxTokens: 100, stop: ['x'], reasoningEffort: 'high',
    tools: [{ name: 't', description: 'd', parameters: { type: 'object' }, deferLoading: true }],
  })
  assert.deepEqual(full.tools, [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }])
  assert.deepEqual([full.temperature, full.max_tokens, full.stop, full.reasoning_effort, full.stream], [0.2, 100, ['x'], 'high', true])
  const bare = toBody({ model: 'm', messages: [] })
  assert.deepEqual(Object.keys(bare).sort(), ['messages', 'model', 'stream', 'stream_options'])
})

// ── SSE ───────────────────────────────────────────────────────────────────────

test('SSE：帧可以被任意切开，支持 CRLF，忽略注释行，并在 [DONE] 处停下', async () => {
  const encoder = new TextEncoder()
  const parts = [': keep-alive\r\n\r\ndata: {"a"', ':1}\r\n\r\nda', 'ta: not json\n\ndata: {"b":2}\n\ndata: [DONE]\n\ndata: {"after":1}\n\n']
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
  let pulses = 0
  assert.deepEqual(await collect(parseSSE(body, () => { pulses += 1 })), [{ a: 1 }, { b: 2 }, DONE])
  assert.ok(pulses >= 1)
})

test('SSE：没有 [DONE] 时，最后一行没有换行也能读到', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"a":1}')); controller.close() } })
  assert.deepEqual(await collect(parseSSE(body)), [{ a: 1 }])
})

test('记录实际服务渠道：以最后一次读到的为准，并且原样放行', async () => {
  const seen = { provider: null, pipeline: null }
  const input = [{ choices: [], provider: 'Baseten' }, { choices: [] }, { choices: [], provider: 'Alibaba' }, DONE]
  assert.deepEqual(await collect(tapRouting(frames(...input), seen)), input)
  assert.equal(seen.provider, 'Alibaba')
  assert.equal(seen.pipeline, 'direct')
})

// ── 翻译 ──────────────────────────────────────────────────────────────────────

test('文本 + 思考 + 用量：块的顺序、内容和用量换算', async () => {
  const chunks = await collect(translate(frames(
    delta({ reasoning: 'think' }),
    delta({ content: 'Hel' }),
    delta({ content: 'lo' }),
    delta({}, 'stop'),
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } } },
    DONE,
  )))
  assert.deepEqual(chunks.map((chunk) => chunk.type), [
    'block-start', 'reasoning-delta', 'block-start', 'text-delta', 'text-delta', 'block-end', 'block-end', 'usage', 'finish',
  ])
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block), [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'Hello' }])
  assert.deepEqual(chunks.at(-2).usage, { inputTokens: 6, outputTokens: 5, totalTokens: 15, cacheReadTokens: 4 })
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('工具调用：参数分片拼接，id 和名字取最先到的，无参数时补成 {}', async () => {
  const chunks = await collect(translate(frames(
    delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'bash', arguments: '{"cmd"' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'noargs', arguments: '' } }] }),
    delta({}, 'tool_calls'),
    DONE,
  )))
  const ends = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
  assert.deepEqual(ends, [
    { type: 'tool-call', id: 'call_a', name: 'bash', arguments: '{"cmd":"ls"}' },
    { type: 'tool-call', id: 'call_b', name: 'noargs', arguments: '{}' },
  ])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('网关没给工具调用 id 时自己补一个；报 stop 但带了工具调用，按 tool-calls 算', async () => {
  const chunks = await collect(translate(frames(
    delta({ tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{}' } }] }),
    delta({}, 'stop'),
    DONE,
  )))
  const call = chunks.find((chunk) => chunk.type === 'block-end').block
  assert.match(call.id, /^call_/)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('成功但没有任何内容 → EMPTY_RESPONSE 错误，不是一条空消息', async () => {
  const chunks = await collect(translate(frames(delta({}, 'stop'), DONE)))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
})

test('错误帧 → 抛 GatewayError；流在没有结束标记时断开 → 抛错', async () => {
  await assert.rejects(collect(translate(frames({ error: { message: 'upstream exploded' } }))), (error) => error instanceof GatewayError && /exploded/.test(error.message))
  await assert.rejects(collect(translate(frames(delta({ content: 'x' })))), /without \[DONE\]/)
})

test('网关省略 [DONE] 但已经给过 finish_reason：照常结束', async () => {
  const chunks = await collect(translate(frames(delta({ content: 'x' }), delta({}, 'stop'))))
  assert.equal(chunks.at(-1).type, 'finish')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('结束原因与用量的映射', () => {
  assert.deepEqual(mapFinish('length'), { kind: 'max-tokens' })
  assert.deepEqual(mapFinish('tool_calls'), { kind: 'tool-calls' })
  assert.deepEqual(mapFinish('content_filter'), { kind: 'error', failure: { message: 'model stopped: content_filter', code: 'CONTENT_FILTER' } })
  assert.deepEqual(mapUsage({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 99 }), { inputTokens: 3, outputTokens: 2 })
  assert.deepEqual(mapUsage({ prompt_tokens: 3, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 } }), { inputTokens: 3, outputTokens: 2, totalTokens: 5, reasoningTokens: 1 })
})
