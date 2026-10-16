/**
 * Cline Pass 网关的"钉住上游渠道"协议。全是纯函数，没有任何 I/O。
 *
 * 网关背后有两套路由器，每次调用走哪一套由网关自己决定，所以"只准用某个渠道"
 * 要写成两种拼法。每套路由器只认自己的那份、忽略另一份，因此两份可以同时写：
 *
 *   direct  （OpenRouter）         顶层   provider.{only,order,ignore,sort}
 *   planner （Vercel AI Gateway）  嵌套   providerOptions.gateway.{only,order,sort}
 *
 * 另外，HTTP 200 并不能证明钉住生效：路由器会悄悄丢掉它认不出的 `only`，再随便
 * 挑个渠道出结果。所以必须把响应里"实际是谁服务的"读回来对一遍，见 {@link adherence}。
 *
 * @module dsh-cline-pin/pin
 */

/** 渠道名的可比较形式："Together AI" 与 "together-ai" 视为同一个。 */
export const slug = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** 两套路由器拼法不同的渠道，按 [planner, direct] 排列（Z.AI 在 Vercel 叫 zai，在 OpenRouter 叫 z-ai）。 */
const ALIASES = [['zai', 'z-ai']]

/** 网关的排序名 → OpenRouter 的排序名。 */
const DIRECT_SORT = { cost: 'price', ttft: 'latency', tps: 'throughput' }

/** 把渠道名写成指定路由器认的拼法。 */
export function spell(name, pipeline) {
  for (const [planner, direct] of ALIASES) {
    if (slug(name) === slug(planner)) return pipeline === 'direct' ? direct : planner
  }
  return name
}

const list = (value) => (Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean)

/** `strict` 或 `preferred`；其它任何值（含大小写、空白）都按 strict，宁严勿松。 */
export function normalizeMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'preferred' ? 'preferred' : 'strict'
}

/** 空串和 `none` 都表示"不排序"，必须在发请求前丢掉——网关会拒绝它们。 */
export function normalizeSort(value) {
  const sort = String(value ?? '').trim()
  return sort === '' || sort === 'none' ? null : sort
}

/**
 * 把一个模型的钉住配置展开成按序尝试的候选。
 *
 * - 写了 `upstreams`：每个渠道一个候选，前一个在首个内容块之前失败，才轮到下一个。
 * - 没写：只有一个"自动"候选（upstream 为 null），`exclude` 仍然生效。
 *
 * @param {{ upstreams?: string[], exclude?: string[], pinMode?: string, sort?: string }} [pin]
 * @returns {{ upstream: string|null, rest: string[], strict: boolean, exclude: string[], sort: string|null }[]}
 */
export function buildAttempts(pin = {}) {
  const exclude = list(pin.exclude)
  const banned = new Set(exclude.map(slug))
  const wanted = list(pin.upstreams).filter((name) => !banned.has(slug(name)))
  const strict = normalizeMode(pin.pinMode) === 'strict'
  const common = { strict, exclude, sort: normalizeSort(pin.sort) }
  if (wanted.length === 0) return [{ ...common, upstream: null, rest: [] }]
  return wanted.map((upstream, index) => ({
    ...common,
    upstream,
    rest: strict ? [] : wanted.filter((_, other) => other !== index),
  }))
}

/**
 * 把一个候选的路由约束写进请求体（两种拼法同时写）。
 *
 * - strict：`only: [该渠道]`，网关这次只能用它。
 * - preferred：`order: [该渠道, ...其余候选]`，只是"优先"，不是"限定"。
 * - exclude：Vercel 一侧没有排除字段，只能编译成"已知渠道 − 排除项"的白名单，
 *   所以需要 `channels`（见 gateway.discoverChannels）；OpenRouter 一侧另有 `ignore`。
 *
 * @param {object} body 原请求体，不会被修改。
 * @param {ReturnType<typeof buildAttempts>[number]} attempt
 * @param {{ planner?: string[]|null, direct?: string[]|null }} [channels] 各路由器已知的渠道清单。
 * @param {'planner'|'direct'} [pipeline] 只写这条路由器那一份约束；不传就两份都写。
 * @returns {object} 带约束的新请求体。
 */
export function injectPin(body, attempt, channels, pipeline) {
  const { upstream, rest, strict, exclude } = attempt
  const sort = normalizeSort(attempt.sort)
  const banned = new Set(exclude.map(slug))

  const route = (pipeline) => {
    const names = (items) => items.map((name) => spell(name, pipeline))
    const allow = banned.size === 0
      ? []
      : names((channels?.[pipeline] ?? []).filter((name) => !banned.has(slug(name))))
    const fields = {}
    if (upstream !== null && strict) {
      fields.only = names([upstream])
    } else {
      if (upstream !== null) fields.order = names([upstream, ...rest])
      if (allow.length > 0) fields.only = allow
    }
    return fields
  }

  const gateway = pipeline === 'direct' ? {} : route('planner')
  const provider = pipeline === 'planner' ? {} : route('direct')
  if (sort !== null) {
    if (pipeline !== 'direct') gateway.sort = sort
    if (pipeline !== 'planner') provider.sort = DIRECT_SORT[sort] ?? sort
  }
  // `ignore` 是 OpenRouter 自己的排除字段：白名单算不出来或已过期时，它仍然兜得住。
  if (banned.size > 0 && pipeline !== 'planner') provider.ignore = exclude.map((name) => spell(name, 'direct'))

  const next = { ...body }
  if (Object.keys(gateway).length > 0) {
    next.providerOptions = { ...body.providerOptions, gateway: { ...body.providerOptions?.gateway, ...gateway } }
  }
  if (Object.keys(provider).length > 0) next.provider = { ...body.provider, ...provider }
  return next
}

/** 网关有时把答案包在 `{ data: … }` 里，拆开。 */
export function unwrap(frame) {
  return frame !== null && typeof frame === 'object' && frame.data !== null && typeof frame.data === 'object' && frame.data.choices !== undefined
    ? frame.data
    : frame
}

/**
 * 从响应帧里读出实际服务的渠道和它来自哪条路由器。
 * - planner：`provider_metadata.gateway.routing.finalProvider`
 * - direct：顶层 `provider`（显示名，如 "Z.AI"）
 * @returns {{ provider: string, pipeline: 'planner'|'direct' }|null}
 */
export function servedByPipeline(frame) {
  const data = unwrap(frame)
  const choice = data?.choices?.[0]
  const routing = choice?.message?.provider_metadata?.gateway?.routing
    ?? choice?.delta?.provider_metadata?.gateway?.routing
    ?? data?.provider_metadata?.gateway?.routing
  const planner = routing?.finalProvider
  if (typeof planner === 'string' && planner !== '') return { provider: planner, pipeline: 'planner' }
  return typeof data?.provider === 'string' && data.provider !== '' ? { provider: data.provider, pipeline: 'direct' } : null
}

/** 只要渠道名，保持旧调用方式。 */
export function servedBy(frame) {
  return servedByPipeline(frame)?.provider ?? null
}

/**
 * 核对钉住是否生效。
 *
 * - `adopted`  实际渠道 = 钉住的渠道
 * - `fallback` 落在 preferred 列表里的后备渠道，算合法
 * - `missed`   网关无视了钉住，换了别家
 * - `violated` 被排除的渠道服务了请求（任何模式下都算违规）
 * - `auto`     没钉任何渠道（排除项仍会检查），无从比较
 * - `unknown`  响应没标明渠道，无法判断
 */
export function adherence(attempt, served) {
  if (served === null || served === undefined || served === '') return 'unknown'
  const got = slug(served)
  if (attempt.exclude.some((name) => slug(name) === got)) return 'violated'
  if (attempt.upstream === null) return 'auto'
  if (got === slug(attempt.upstream)) return 'adopted'
  if (attempt.rest.some((name) => slug(name) === got)) return 'fallback'
  return 'missed'
}

/** 这个核对结果能不能接受：strict 不容 missed；preferred 容许落到名单外（那是它的"后备"语义）；violated 永远不行。 */
export function isHonored(attempt, verdict) {
  if (verdict === 'violated') return false
  return attempt.strict ? verdict !== 'missed' : true
}

/** 换个渠道重试有没有意义：账号、额度、上下文类的错换渠道没用；限流、5xx、传输错误、渠道不可用的才值得换。 */
export function canFailover({ status = 0, code = '', detail = '' }) {
  if (['AUTH', 'QUOTA', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'].includes(code)) return false
  if (status === 0 || status === 408 || status === 429 || status >= 500) return true
  return /no (?:allowed|available) providers|provider.{0,40}(?:not found|unavailable|unsupported)/i.test(String(detail))
}

/** 探测用的渠道名：不可能存在，路由器会在花任何 token 之前报错，并把它能用的全部渠道列出来。 */
export const PROBE_CHANNEL = '__probe__'

/** 构造一个"钉到不存在的渠道"的探测请求体。 */
export function probeBody(model, pipeline) {
  const base = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }
  return pipeline === 'planner'
    ? { ...base, providerOptions: { gateway: { only: [PROBE_CHANNEL] } } }
    : { ...base, provider: { only: [PROBE_CHANNEL] } }
}

/**
 * 从探测请求的报错里解析出路由器自己列的渠道清单。
 * @returns {string[]|null} 报错里没有清单就是 null。
 */
export function availableChannels(message, pipeline) {
  const text = String(message ?? '')
  if (pipeline === 'planner') {
    const match = /Available providers are:\s*([^.]+)/.exec(text)
    if (match === null) return null
    const names = match[1].split(/,\s*/).map((name) => name.trim()).filter((name) => /^[a-z0-9][a-z0-9-]*$/.test(name))
    return names.length > 0 ? names : null
  }
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    const found = JSON.parse(text.slice(start))?.error?.metadata?.available_providers
    return Array.isArray(found) && found.length > 0 ? found.map(String) : null
  } catch {
    return null
  }
}
