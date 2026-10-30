import assert from 'node:assert/strict'
import test from 'node:test'
import { adherence, availableChannels, buildAttempts, canFailover, injectPin, isHonored, normalizeMode, probeBody, servedBy, servedByPipeline, spell } from '../lib/pin.js'

test('1017 锁定 DeepSeek 时携带能力过滤，不影响其它渠道与自动路由', () => {
  const body = { model: 'cline-pass/deepseek-v4.1-flash-1017' }
  const locked = injectPin(body, buildAttempts({ upstreams: ['deepseek'] })[0])
  assert.deepEqual(locked.providerOptions.gateway, { only: ['deepseek'], has: ['vision', 'implicit-caching'] })
  assert.equal(injectPin(body, buildAttempts({ upstreams: ['pareto'] })[0]).providerOptions.gateway.has, undefined)
  assert.equal(injectPin(body, buildAttempts({})[0]).providerOptions, undefined)
  assert.equal(injectPin(body, buildAttempts({ upstreams: ['deepseek'] })[0], undefined, 'direct').providerOptions, undefined)
})

const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
const attempt = (pin) => buildAttempts(pin)[0]

// ── 候选 ──────────────────────────────────────────────────────────────────────

test('strict：每个渠道一个候选，互不带后备', () => {
  const attempts = buildAttempts({ upstreams: ['a', 'b'], pinMode: 'strict' })
  assert.deepEqual(attempts.map((item) => [item.upstream, item.rest, item.strict]), [['a', [], true], ['b', [], true]])
})

test('preferred：每个候选带上其余渠道作后备', () => {
  const attempts = buildAttempts({ upstreams: ['a', 'b', 'c'], pinMode: 'preferred' })
  assert.deepEqual(attempts.map((item) => [item.upstream, item.rest, item.strict]), [['a', ['b', 'c'], false], ['b', ['a', 'c'], false], ['c', ['a', 'b'], false]])
})

test('钉住模式容忍大小写和空白，并且无法识别时按 strict', () => {
  assert.equal(normalizeMode(' Preferred '), 'preferred')
  assert.equal(normalizeMode('STRICT'), 'strict')
  assert.equal(normalizeMode('nonsense'), 'strict')
  assert.equal(normalizeMode(undefined), 'strict')
  assert.equal(attempt({ upstreams: ['a'], pinMode: 'strict ' }).strict, true)
})

test('没写 upstreams：只有一个自动候选', () => {
  assert.deepEqual(buildAttempts({}), [{ strict: true, exclude: [], sort: null, upstream: null, rest: [] }])
  assert.deepEqual(buildAttempts(undefined).length, 1)
})

test('exclude 会把渠道从候选里剔掉，但保留在排除清单里', () => {
  const attempts = buildAttempts({ upstreams: ['a', 'b'], exclude: ['A'] })
  assert.deepEqual(attempts.map((item) => item.upstream), ['b'])
  assert.deepEqual(attempts[0].exclude, ['A'])
})

test('排序：空串和 none 都表示不排序', () => {
  assert.equal(attempt({ sort: '' }).sort, null)
  assert.equal(attempt({ sort: 'none' }).sort, null)
  assert.equal(attempt({ sort: 'ttft' }).sort, 'ttft')
})

// ── 注入 ──────────────────────────────────────────────────────────────────────

test('strict 钉住：两种拼法都写 only，且不改动原请求体', () => {
  const original = structuredClone(body)
  const out = injectPin(body, attempt({ upstreams: ['baseten'], pinMode: 'strict' }))
  assert.deepEqual(out.providerOptions.gateway, { only: ['baseten'] })
  assert.deepEqual(out.provider, { only: ['baseten'] })
  assert.deepEqual(body, original)
})

test('preferred 钉住：写 order，不写 only', () => {
  const out = injectPin(body, attempt({ upstreams: ['a', 'b'], pinMode: 'preferred' }))
  assert.deepEqual(out.providerOptions.gateway, { order: ['a', 'b'] })
  assert.deepEqual(out.provider, { order: ['a', 'b'] })
})

test('排序在 OpenRouter 一侧换成它自己的名字', () => {
  const sorted = (sort) => injectPin(body, attempt({ sort }))
  assert.equal(sorted('ttft').providerOptions.gateway.sort, 'ttft')
  assert.equal(sorted('ttft').provider.sort, 'latency')
  assert.equal(sorted('cost').provider.sort, 'price')
  assert.equal(sorted('tps').provider.sort, 'throughput')
})

test('同一渠道在两套路由器里拼法不同：zai ↔ z-ai', () => {
  assert.equal(spell('z-ai', 'planner'), 'zai')
  assert.equal(spell('zai', 'direct'), 'z-ai')
  assert.equal(spell('baseten', 'direct'), 'baseten')
  for (const name of ['zai', 'z-ai']) {
    const out = injectPin(body, attempt({ upstreams: [name] }))
    assert.deepEqual(out.providerOptions.gateway.only, ['zai'])
    assert.deepEqual(out.provider.only, ['z-ai'])
  }
})

test('exclude：按各自路由器的渠道清单编译成白名单，OpenRouter 另写 ignore', () => {
  const channels = { planner: ['a', 'b', 'z'], direct: ['a', 'z'] }
  const out = injectPin(body, attempt({ exclude: ['b'] }), channels)
  assert.deepEqual(out.providerOptions.gateway.only, ['a', 'z'])
  assert.deepEqual(out.provider.only, ['a', 'z'])
  assert.deepEqual(out.provider.ignore, ['b'])
})

test('exclude 没有渠道清单时，仍然写 OpenRouter 的 ignore，但不会凭空写白名单', () => {
  const out = injectPin(body, attempt({ exclude: ['b'] }), undefined)
  assert.deepEqual(out.provider, { ignore: ['b'] })
  assert.equal(out.providerOptions, undefined)
})

test('exclude 与 preferred 同用：既有 order 又有白名单', () => {
  const out = injectPin(body, attempt({ upstreams: ['a'], pinMode: 'preferred', exclude: ['b'] }), { planner: ['a', 'b', 'c'], direct: ['a', 'b', 'c'] })
  assert.deepEqual(out.providerOptions.gateway, { order: ['a'], only: ['a', 'c'] })
  assert.deepEqual(out.provider, { order: ['a'], only: ['a', 'c'], ignore: ['b'] })
})

test('请求体里原有的 provider / providerOptions 字段会被保留', () => {
  const out = injectPin({ ...body, provider: { data_collection: 'deny' }, providerOptions: { gateway: { user: 'u' }, other: 1 } }, attempt({ upstreams: ['a'] }))
  assert.deepEqual(out.provider, { data_collection: 'deny', only: ['a'] })
  assert.deepEqual(out.providerOptions, { gateway: { user: 'u', only: ['a'] }, other: 1 })
})

test('没有钉住也没有排除：请求体原样不动', () => {
  assert.deepEqual(injectPin(body, attempt({})), body)
})

test('只钉单条路由：direct 只写 provider，planner 只写 providerOptions.gateway', () => {
  const direct = injectPin(body, attempt({ upstreams: ['baseten'], pinMode: 'strict' }), undefined, 'direct')
  assert.deepEqual(direct.provider, { only: ['baseten'] })
  assert.equal(direct.providerOptions, undefined)

  const planner = injectPin(body, attempt({ upstreams: ['baseten'], pinMode: 'strict' }), undefined, 'planner')
  assert.deepEqual(planner.providerOptions, { gateway: { only: ['baseten'] } })
  assert.equal(planner.provider, undefined)
})

// ── 核对 ──────────────────────────────────────────────────────────────────────

test('实际渠道与钉住一致 → adopted；名字的写法差异不算不一致', () => {
  assert.equal(adherence(attempt({ upstreams: ['baseten'] }), 'baseten'), 'adopted')
  assert.equal(adherence(attempt({ upstreams: ['together-ai'] }), 'Together AI'), 'adopted')
  assert.equal(adherence(attempt({ upstreams: ['zai'] }), 'Z.AI'), 'adopted')
})

test('核对的其它结果', () => {
  const preferred = attempt({ upstreams: ['a', 'b'], pinMode: 'preferred' })
  assert.equal(adherence(preferred, 'b'), 'fallback')
  assert.equal(adherence(attempt({ upstreams: ['baseten'] }), 'deepseek'), 'missed')
  assert.equal(adherence(attempt({ upstreams: ['a'], exclude: ['deepseek'] }), 'deepseek'), 'violated')
  assert.equal(adherence(attempt({ exclude: ['deepseek'] }), 'deepseek'), 'violated')
  assert.equal(adherence(attempt({}), 'anything'), 'auto')
  assert.equal(adherence(attempt({ upstreams: ['a'] }), null), 'unknown')
  assert.equal(adherence(attempt({ upstreams: ['a'] }), ''), 'unknown')
})

test('什么结果可以接受', () => {
  const strict = attempt({ upstreams: ['a'] })
  const soft = attempt({ upstreams: ['a'], pinMode: 'preferred' })
  assert.equal(isHonored(strict, 'adopted'), true)
  assert.equal(isHonored(strict, 'unknown'), true)
  assert.equal(isHonored(strict, 'missed'), false)
  assert.equal(isHonored(soft, 'missed'), true)
  assert.equal(isHonored(soft, 'violated'), false)
  assert.equal(isHonored(strict, 'violated'), false)
})

test('读出实际服务渠道：planner、direct、整包响应、包了一层 data 的响应', () => {
  const planner = { choices: [{ delta: {}, finish_reason: 'stop' }], provider_metadata: { gateway: { routing: { finalProvider: 'baseten' } } } }
  const message = { choices: [{ message: { content: 'x', provider_metadata: { gateway: { routing: { finalProvider: 'alibaba' } } } } }] }
  const direct = { choices: [{ delta: { content: 'x' } }], provider: 'Baseten' }
  assert.equal(servedBy(planner), 'baseten')
  assert.equal(servedBy(message), 'alibaba')
  assert.equal(servedBy(direct), 'Baseten')
  assert.equal(servedBy({ data: { choices: [{ message: { content: 'x' } }], provider: 'Z.AI' } }), 'Z.AI')
  assert.equal(servedBy({ choices: [{ delta: { content: 'x' } }] }), null)
  assert.equal(servedBy(null), null)
  assert.deepEqual(servedByPipeline(planner), { provider: 'baseten', pipeline: 'planner' })
  assert.deepEqual(servedByPipeline(direct), { provider: 'Baseten', pipeline: 'direct' })
  assert.equal(servedByPipeline({ choices: [] }), null)
})

// ── 渠道清单与失败判断 ─────────────────────────────────────────────────────────

test('从探测报错里解析渠道清单', () => {
  assert.deepEqual(availableChannels('No providers matched. Available providers are: baseten, alibaba, deepseek-ai.', 'planner'), ['baseten', 'alibaba', 'deepseek-ai'])
  assert.equal(availableChannels('nothing useful', 'planner'), null)
  const inner = JSON.stringify({ error: { metadata: { available_providers: ['baseten', 'z-ai'] } } })
  assert.deepEqual(availableChannels(`Provider returned error ${inner}`, 'direct'), ['baseten', 'z-ai'])
  assert.equal(availableChannels('no json here', 'direct'), null)
  assert.equal(availableChannels(`oops {broken`, 'direct'), null)
})

test('探测请求体：只写对应路由器的那份', () => {
  assert.deepEqual(probeBody('m', 'planner').providerOptions, { gateway: { only: ['__probe__'] } })
  assert.equal(probeBody('m', 'planner').provider, undefined)
  assert.deepEqual(probeBody('m', 'direct').provider, { only: ['__probe__'] })
  assert.equal(probeBody('m', 'direct').providerOptions, undefined)
})

test('什么错误值得换渠道重试', () => {
  assert.equal(canFailover({ status: 503, code: 'SERVER' }), true)
  assert.equal(canFailover({ status: 429, code: 'RATE_LIMIT' }), true)
  assert.equal(canFailover({ status: 0, code: 'TRANSPORT' }), true)
  assert.equal(canFailover({ status: 401, code: 'AUTH' }), false)
  assert.equal(canFailover({ status: 429, code: 'QUOTA' }), false)
  assert.equal(canFailover({ status: 400, code: 'CONTEXT_WINDOW_EXCEEDED' }), false)
  assert.equal(canFailover({ status: 400, code: 'INVALID_REQUEST', detail: 'bad param' }), false)
  assert.equal(canFailover({ status: 400, code: 'INVALID_REQUEST', detail: 'No allowed providers are available' }), true)
  assert.equal(canFailover({ status: 0, code: 'ABORTED' }), false)
})
