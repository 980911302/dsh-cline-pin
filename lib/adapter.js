/**
 * dsh 的 LLM 适配器：往 Cline Pass 网关发流式请求，带上游渠道钉住、首个内容块之前的
 * 故障转移，以及响应后的渠道核对。
 *
 * 故障转移的约定：一个候选只有在"还没有任何内容交给 dsh"时才会被放弃——非 2xx、
 * 传输错误、空回答、错误帧、（开启 enforce 时）钉住没被遵守，都会换下一个候选。
 * 内容一旦开始输出，这条流就是答案，之后的失败如实上报，不再重试。
 *
 * @module dsh-cline-pin/adapter
 */
import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  errorChain,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import { chatURL } from './gateway.js'
import { contentHasImage, prepareRequestImages } from './image.js'
import { modalitiesFor } from './models.js'
import { adherence, buildAttempts, canFailover, injectPin, isHonored, slug } from './pin.js'
import { errorText, GatewayError, parseSSE, tapRouting, toBody, translate } from './wire.js'

/** Cline 订阅额度窗口用尽的措辞：周/月/日/5 小时/套餐 + 用尽。 */
const SPENT_WINDOW = /\b(?:weekly|monthly|daily|(?:five|5)\s*hour|plan)\b[\s\S]{0,80}?\b(?:exceed\w*|exhaust\w*|reach\w*|used\s+up|out\s+of|deplet\w*|spent)\b/i

/** 网关的状态码/错误文本 → dsh 的稳定错误码（上层按错误码处理，从不解析文案）。 */
export function failureCode(status, detail) {
  const text = String(detail ?? '')
  if (status === 402 || isQuotaExceededError(text) || SPENT_WINDOW.test(text.replace(/[_-]/g, ' '))) return QUOTA_EXCEEDED_CODE
  if (status === 401 || status === 403 || /unauthorized|invalid\s*(?:api\s*key|token)|re-?authenticate/i.test(text)) return 'AUTH'
  if (status === 429 || /rate.?limit/i.test(text)) return 'RATE_LIMIT'
  if (isContextWindowExceededError(text)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  if (status >= 400) return `HTTP_${status}`
  return 'UPSTREAM'
}

/** 给错误挂上"换个候选重试有没有意义"的标记。 */
const retryable = (error, retry) => Object.assign(error, { retry })

const shortName = (id) => id.replace(/^cline-pass\//, '')

/**
 * @param deps.settings  `() => 配置`
 * @param deps.apiKey    `async () => 密钥`（每次请求现取，密钥改了立刻生效）
 * @param deps.channels  `async (model, apiKey, signal) => { planner, direct }`，用于把 exclude 编译成白名单
 * @param deps.plan      `(model) => { source, pin, bypass, learn }`，这次请求怎么钉，见 state.planFor
 * @param deps.modelIds  `() => string[]`，对外展示的模型清单
 * @param deps.served    `({ model, plan, attempt, served, verdict }) => void`，请求成功后报告"实际是谁响应的"，用于自动记住渠道
 * @param deps.record    `(entry) => void`，每个请求（以及每次失败转移）记一条，见 log.js
 * @param deps.log       dsh 的 logger（可选），只用于配置层面的一次性提醒
 */
export class ClinePinAdapter extends LlmAdapter {
  constructor(deps) {
    super()
    this.deps = deps
    this.warned = new Set()
  }

  providerInfo(provider) {
    return { id: provider, name: this.deps.settings().displayName }
  }

  listModels(provider) {
    const cfg = this.deps.settings()
    return Promise.resolve(this.deps.modelIds().map((id) => ({
      provider,
      id,
      name: cfg.models[id]?.name || shortName(id),
      inputModalities: modalitiesFor(id),
    })))
  }

  resolveModel(provider, model) {
    const cfg = this.deps.settings()
    const override = cfg.models[model] ?? {}
    const positive = (value) => (Number.isFinite(value) && value >= 1 ? Math.trunc(value) : undefined)
    return Promise.resolve({
      provider,
      id: model,
      name: override.name || shortName(model),
      inputModalities: modalitiesFor(model),
      context: { contextWindow: positive(override.contextWindow) ?? cfg.windows[model] ?? cfg.defaultContextWindow },
      defaultMaxTokens: positive(override.maxTokens) ?? cfg.defaultMaxTokens,
    })
  }

  stream(options) {
    return this.run(options)
  }

  /** 按候选顺序逐个尝试，第一个吐出内容的候选就是答案。 */
  async *run(options) {
    const cfg = this.deps.settings()
    const apiKey = await this.deps.apiKey()
    // 这次请求怎么钉：配置文件 > 设置页手动选的 > 自动记住的 > 不钉（并在响应后学习），见 state.planFor。
    const plan = this.deps.plan(options.model)
    // 自动记住的渠道只是便利，不是承诺：它下线了也不该让请求失败，所以最后再补一次不钉的尝试。
    const attempts = [...buildAttempts(plan.pin), ...(plan.bypass ? buildAttempts({}) : [])]
    const [first] = attempts
    const channels = first.exclude.length > 0 ? await this.deps.channels(options.model, apiKey, options.signal) : undefined
    this.audit(options.model, first, channels)

    const messages = options.messages ?? []
    const hasImage = messages.some((message) => contentHasImage(message.content ?? []))
    let images
    if (hasImage) {
      try {
        images = await prepareRequestImages(messages, this.deps.attachments?.(), options.signal)
      } catch (error) {
        throw error instanceof LlmError ? error : new LlmError(error?.message ?? String(error), error?.code ?? 'UNSUPPORTED_CONTENT')
      }
    }
    const body = toBody(options, images)
    const started = Date.now()
    const failed = []
    for (const [index, attempt] of attempts.entries()) {
      const label = attempt.upstream ?? '(自动)'
      const seen = { provider: null, pipeline: null }
      let delivered = false
      try {
        for await (const chunk of this.once(cfg, apiKey, injectPin(body, attempt, channels, plan.pipeline), options.signal, attempt, seen)) {
          delivered = true
          yield chunk
        }
        const verdict = adherence(attempt, seen.provider)
        this.deps.record?.({ model: options.model, pin: plan.source, want: attempt.upstream, got: seen.provider, verdict, ms: Date.now() - started, failed })
        this.deps.served?.({ model: options.model, plan, attempt, served: seen.provider, pipeline: seen.pipeline, verdict })
        return
      } catch (error) {
        const next = !delivered && index < attempts.length - 1 && error?.retry === true ? attempts[index + 1] : undefined
        this.deps.record?.({
          model: options.model,
          pin: plan.source,
          want: attempt.upstream,
          code: error?.code,
          error: error?.message ?? String(error),
          next: next === undefined ? undefined : (next.upstream ?? 'auto'),
          failed,
        })
        if (next === undefined) throw error
        failed.push(label)
      }
    }
  }

  /** 一个候选的一次请求。所有失败都会被整理成带 `retry` 标记的 LlmError。 */
  async *once(cfg, apiKey, body, signal, attempt, seen) {
    const idle = new AbortController()
    let timer
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(new LlmError(`Cline Pass 流式响应 ${cfg.streamIdleTimeoutMs}ms 内没有任何数据`, 'TIMEOUT')), cfg.streamIdleTimeoutMs)
    }
    const halt = signal === undefined ? idle.signal : AbortSignal.any([signal, idle.signal])
    arm()
    try {
      let response
      try {
        response = await fetch(chatURL(cfg.baseURL), {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream', ...attributionHeaders() },
          body: JSON.stringify(body),
          signal: halt,
        })
      } catch (error) {
        throw this.fail(error, signal, idle.signal)
      }
      if (!response.ok) throw await this.httpFailure(response)
      if (response.body === null) throw retryable(new LlmError('网关没有返回响应体', 'EMPTY_RESPONSE'), true)
      // 流式请求却收到 200 + JSON：多半是个错误体，把真正的错误文本带出来，别让它变成"流意外结束"。
      if ((response.headers.get('content-type') ?? '').includes('application/json')) {
        const raw = await response.text().catch(() => '')
        let detail = raw.slice(0, 400)
        try {
          detail = errorText(JSON.parse(raw)?.error) || detail
        } catch { /* 保留原文 */ }
        const code = failureCode(undefined, detail)
        throw retryable(new LlmError(detail || '网关对流式请求返回了非流式的 JSON 响应', code), canFailover({ code, detail }))
      }

      let content = false
      let first = true
      let usage // 还没有内容时先扣住用量：它排在 finish 前面，一旦交出去，这次尝试就再也无法换渠道了
      try {
        for await (const chunk of translate(tapRouting(parseSSE(response.body, arm), seen))) {
          if (first) {
            first = false
            // 第一块出来时，同一帧里的渠道标记已经读到了：这是唯一能在"交出任何内容之前"拦住错渠道的时机。
            if (cfg.enforce) this.enforce(attempt, seen)
          }
          if (chunk.type === 'usage' && !content) {
            usage = chunk
            continue
          }
          const failure = chunk.type === 'finish' && chunk.reason.kind === 'error' ? chunk.reason.failure : undefined
          if (failure?.code === 'EMPTY_RESPONSE' && !content) throw retryable(new LlmError(failure.message, 'EMPTY_RESPONSE'), true)
          if (chunk.type !== 'finish') content = true
          if (usage !== undefined) {
            yield usage
            usage = undefined
          }
          yield chunk
        }
      } catch (error) {
        throw this.fail(error, signal, idle.signal)
      }
    } finally {
      clearTimeout(timer)
      idle.abort()
    }
  }

  /** 任何异常 → 带 `retry` 标记的 LlmError。已经整理过的原样放行。 */
  fail(error, signal, idleSignal) {
    if (error instanceof LlmError && Object.hasOwn(error, 'retry')) return error
    if (signal?.aborted) return retryable(new LlmError('Cline Pass 请求被调用方取消', 'ABORTED', { cause: error }), false)
    if (idleSignal.aborted && idleSignal.reason instanceof LlmError) return retryable(idleSignal.reason, true)
    if (error instanceof GatewayError) {
      const code = failureCode(error.status, error.message)
      return retryable(new LlmError(error.message, code, error.status === undefined ? undefined : { status: error.status }), canFailover({ code, detail: error.message }))
    }
    return retryable(new LlmError(errorChain(error), 'TRANSPORT', { cause: error }), true)
  }

  /** 非 2xx 的响应 → LlmError，并带上 Retry-After。 */
  async httpFailure(response) {
    const raw = await response.text().catch(() => '')
    let detail = raw.slice(0, 400)
    try {
      const parsed = JSON.parse(raw)
      detail = errorText(parsed?.error ?? parsed?.data?.error) || detail
    } catch { /* 不是 JSON，保留原文 */ }
    const code = failureCode(response.status, detail)
    const wait = Number(response.headers.get('retry-after')) * 1000
    return retryable(
      new LlmError(detail || `HTTP ${response.status}`, code, {
        status: response.status,
        ...(Number.isFinite(wait) && wait > 0 ? { providerRetryAfterMs: wait } : {}),
      }),
      canFailover({ status: response.status, code, detail }),
    )
  }

  /** enforce：钉住没被遵守，就在交出任何内容之前放弃这个候选。 */
  enforce(attempt, seen) {
    const verdict = adherence(attempt, seen.provider)
    if (isHonored(attempt, verdict)) return
    throw retryable(new LlmError(`网关没有遵守钉住：要求 ${attempt.upstream ?? '(自动)'}，实际由 ${seen.provider} 响应（${verdict}）`, 'PIN_NOT_HONORED'), true)
  }

  /** exclude 的体检：没有渠道清单就提醒一次；已知渠道被排除光了就直接报错，别让请求带着空约束出去。 */
  audit(model, attempt, channels) {
    if (attempt.exclude.length === 0) return
    const banned = new Set(attempt.exclude.map(slug))
    for (const pipeline of ['planner', 'direct']) {
      const known = channels?.[pipeline]
      if (attempt.upstream === null && Array.isArray(known) && known.length > 0 && known.every((name) => banned.has(slug(name)))) {
        throw new LlmError(`cline-pin: ${model} 的已知渠道（${known.join(', ')}）全部被 exclude 排除了，没有可用渠道`, 'INVALID_REQUEST')
      }
    }
    if (!(channels?.planner?.length > 0) && !this.warned.has(model)) {
      this.warned.add(model)
      this.deps.log?.warn('[cline-pin] %s: 取不到 Vercel 一侧的渠道清单，exclude 在该路由器上无法生效（OpenRouter 一侧不受影响）；可运行 cline-pin probe %s 检查', model, model)
    }
  }
}
