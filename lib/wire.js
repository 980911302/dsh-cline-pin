/**
 * OpenAI 兼容的网关协议 ⇄ dsh 的流式协议。纯函数/纯生成器，不依赖 dsh 的任何包，
 * 所以可以脱离宿主单独测试。
 *
 * @module dsh-cline-pin/wire
 */
import { servedByPipeline, unwrap } from './pin.js'

/** SSE 流的结束哨兵。 */
export const DONE = '[DONE]'

/** 网关在响应里报告的错误（错误帧、流意外结束）。适配器会把它换成带稳定错误码的 LlmError。 */
export class GatewayError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
  }
}

/** 把各种形状的 error 值转成可显示的文本。 */
export function errorText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value.message === 'string') return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ── 请求：dsh 的消息 → OpenAI 的 messages ───────────────────────────────────────

const textOf = (blocks) => (blocks ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('')

function fromAssistant(message) {
  const blocks = message.content ?? []
  const reasoning = blocks.filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
  const calls = blocks.filter((block) => block.type === 'tool-call')
  return {
    role: 'assistant',
    content: textOf(blocks),
    ...(reasoning === '' ? {} : { reasoning_content: reasoning }),
    ...(calls.length === 0
      ? {}
      : { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }),
  }
}

/**
 * 把 dsh 的对话转成 OpenAI 的 messages。
 *
 * - 系统提示（`options.system` 加开头的 system/developer 消息）合并成第一条 system。
 * - 工具结果是 `tool` 角色消息（带 `toolCallId`），转成 `{ role: 'tool', tool_call_id }`。
 * - 带 tool_calls 的助手消息后面必须紧跟每个 id 的 tool 回答，否则网关会拒绝整个请求
 *   （"insufficient tool messages following tool_calls message"）。所以中途插进来的
 *   通知/用户消息先扣住，等这一组答完再放出。
 * - 图片：声明了 image 模态的模型，用户消息会转成 OpenAI 的 text + image_url 内容块数组。
 */

/** 把一条 image block 转成 OpenAI 的 image_url 内容块。 */
function imagePart(block, images) {
  const version = images?.get(block?.attachment?.attachmentId)
  if (version === undefined) {
    const error = new Error('cline-pin: 图片没有被附件服务解析，无法发送')
    error.code = 'UNSUPPORTED_CONTENT'
    throw error
  }
  return { type: 'image_url', image_url: { url: 'data:' + version.mediaType + ';base64,' + version.base64 } }
}

/** 递归收集图片内容块，包括 tool-result 里的图。 */
function collectImageParts(blocks, images, target = []) {
  for (const block of blocks ?? []) {
    if (block?.type === 'image') target.push(imagePart(block, images))
    else if (block?.type === 'tool-result') collectImageParts(block.content, images, target)
  }
  return target
}

export function toWireMessages({ system, messages }, images) {
  const lead = system ? [system] : []
  const wire = []
  let started = false
  let open = new Set()
  let held = []
  const emit = (message) => (open.size > 0 ? held.push(message) : wire.push(message))
  const release = () => {
    wire.push(...held)
    held = []
  }

  for (const message of messages ?? []) {
    const text = textOf(message.content)
    if (message.role === 'system' || message.role === 'developer') {
      if (text === '') continue
      if (started) emit({ role: 'system', content: text })
      else lead.push(text)
    } else if (message.role === 'assistant') {
      release()
      started = true
      wire.push(fromAssistant(message))
      open = new Set((message.content ?? []).filter((block) => block.type === 'tool-call').map((block) => block.id))
    } else if (message.role === 'tool') {
      started = true
      wire.push({ role: 'tool', tool_call_id: message.toolCallId, content: text || '(no output)' })
      open.delete(message.toolCallId)
      if (open.size === 0) release()
    } else {
      const parts = collectImageParts(message.content, images)
      if (parts.length > 0) {
        started = true
        const content = []
        if (text !== '') content.push({ type: 'text', text })
        content.push(...parts)
        emit({ role: 'user', content })
      } else if (text !== '') {
        started = true
        emit({ role: 'user', content: text })
      }
    }
  }
  release()
  return lead.length === 0 ? wire : [{ role: 'system', content: lead.join('\n\n') }, ...wire]
}

/** 一次 dsh 调用 → 网关的流式请求体（钉住约束稍后由 injectPin 加）。 */
export function toBody(options, images) {
  const tools = (options.tools ?? []).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model: options.model,
    messages: toWireMessages(options, images),
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length === 0 ? {} : { tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...((() => {
      const effort = options.reasoningEffort
      if (!effort || effort === 'off' || effort === 'none') return {}
      const wireEffort = effort === 'max' || effort === 'xhigh' ? 'high' : effort === 'minimal' ? 'low' : effort
      return { reasoning_effort: wireEffort }
    })()),
  }
}

// ── 响应：SSE → dsh 的流式块 ────────────────────────────────────────────────────

function parseLine(line) {
  if (!line.startsWith('data:')) return undefined
  const payload = line.slice(5).trim()
  if (payload === DONE) return DONE
  if (payload === '') return undefined
  try {
    return JSON.parse(payload)
  } catch {
    return undefined
  }
}

/**
 * 把响应体解析成一帧一帧的 JSON（最后可能是 `[DONE]`）。
 * @param body fetch 的 ReadableStream。
 * @param onChunk 每收到一段字节就调用一次（适配器用来重置空闲计时器）。
 */
export async function* parseSSE(body, onChunk = () => {}) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of body) {
    onChunk()
    buffer += decoder.decode(bytes, { stream: true })
    let at = buffer.indexOf('\n')
    while (at >= 0) {
      const frame = parseLine(buffer.slice(0, at).replace(/\r$/, ''))
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf('\n')
      if (frame === undefined) continue
      yield frame
      if (frame === DONE) return
    }
  }
  const tail = parseLine(buffer.trim())
  if (tail !== undefined) yield tail
}

/** 原样放行每一帧，同时把"实际服务渠道"和它来自哪条路由器记进 `seen`（最后一次读到的为准）。 */
export async function* tapRouting(frames, seen) {
  for await (const frame of frames) {
    if (frame !== DONE) {
      const routing = servedByPipeline(frame)
      if (routing !== null) {
        seen.provider = routing.provider
        seen.pipeline = routing.pipeline
      }
    }
    yield frame
  }
}

/** OpenAI 的 finish_reason → dsh 的结束原因。 */
export function mapFinish(reason) {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'tool-calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } }
  }
}

/** OpenAI 的 usage → dsh 的用量。dsh 的各项互不重叠，所以缓存命中的 token 要从 input 里扣掉。 */
export function mapUsage(usage) {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens
  const input = Number.isSafeInteger(usage?.prompt_tokens) ? usage.prompt_tokens : 0
  const output = Number.isSafeInteger(usage?.completion_tokens) ? usage.completion_tokens : 0
  const combined = input + output
  const exact = Number.isSafeInteger(usage?.total_tokens) ? usage.total_tokens === combined : true
  return {
    inputTokens: input - (cacheRead ?? 0),
    outputTokens: output,
    ...(exact ? { totalTokens: combined } : {}),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** 一帧里的思考文本。网关发 `reasoning`，DeepSeek 原生叫 `reasoning_content`，有的只给 `reasoning_details`。 */
export function reasoningOf(delta) {
  for (const field of ['reasoning', 'reasoning_content']) {
    const value = delta?.[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  if (Array.isArray(delta?.reasoning_details)) {
    const text = delta.reasoning_details.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
    if (text.length > 0) return text
  }
  return undefined
}

let sequence = 0

function closed(block) {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    default:
      // 无参数的工具调用，参数必须是合法 JSON，不能是空串。
      return { type: 'tool-call', id: block.id, name: block.name ?? '', arguments: block.text === '' ? '{}' : block.text }
  }
}

/**
 * 把解析好的 SSE 帧翻译成 dsh 的流式块。
 *
 * 增量边流边出；块的结束、用量、结束原因都推迟到 `[DONE]`，所以 finish 之后不会再有块。
 * 一个"成功但什么内容都没有"的回答会变成 EMPTY_RESPONSE 错误，而不是一条悄悄的空消息。
 * 流在没有 `[DONE]` 也没有 finish_reason 时就断了，抛 GatewayError。
 */
export async function* translate(frames) {
  const order = []
  const calls = new Map()
  let text
  let thought
  let finish
  let usage
  let done = false
  const open = (kind, extra = {}) => {
    const block = { index: order.length, kind, text: '', ...extra }
    order.push(block)
    return block
  }

  for await (const frame of frames) {
    if (frame === DONE) {
      done = true
      break
    }
    const data = unwrap(frame)
    // 200 响应里夹一个错误对象，也要当成这次尝试失败，这样被拒的钉住才会换下一个候选。
    if (data?.error !== undefined && data?.choices === undefined) throw new GatewayError(errorText(data.error))
    for (const choice of data?.choices ?? []) {
      const delta = choice?.delta ?? {}
      const reasoning = reasoningOf(delta)
      if (reasoning !== undefined) {
        if (thought === undefined) {
          thought = open('reasoning')
          yield { type: 'block-start', index: thought.index, blockType: 'reasoning' }
        }
        thought.text += reasoning
        yield { type: 'reasoning-delta', index: thought.index, text: reasoning }
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (text === undefined) {
          text = open('text')
          yield { type: 'block-start', index: text.index, blockType: 'text' }
        }
        text.text += delta.content
        yield { type: 'text-delta', index: text.index, text: delta.content }
      }
      for (const call of delta.tool_calls ?? []) {
        const key = call.index ?? 0
        let block = calls.get(key)
        if (block === undefined) {
          sequence += 1
          block = open('tool-call', { id: `call_${Date.now().toString(36)}_${sequence}` })
          calls.set(key, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (typeof call.id === 'string' && call.id !== '') block.id = call.id
        if (typeof call.function?.name === 'string' && call.function.name !== '') block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield { type: 'tool-call-delta', index: block.index, id: block.id, ...(block.name === undefined ? {} : { name: block.name }), argumentsDelta: fragment }
      }
      if (typeof choice?.finish_reason === 'string') finish = mapFinish(choice.finish_reason)
    }
    if (data?.usage !== undefined && data.usage !== null) usage = mapUsage(data.usage)
  }

  if (!done && finish === undefined) throw new GatewayError('stream ended without [DONE]')
  for (const block of order) yield { type: 'block-end', index: block.index, block: closed(block) }
  if (usage !== undefined) yield { type: 'usage', usage }
  let reason = finish ?? { kind: 'stop' }
  // 有的模型发了工具调用却报 finish_reason=stop，按实际内容纠正，否则 dsh 不会执行工具。
  if (reason.kind === 'stop' && order.some((block) => block.kind === 'tool-call')) reason = { kind: 'tool-calls' }
  if (reason.kind === 'stop' && order.length === 0) {
    reason = { kind: 'error', failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' } }
  }
  yield { type: 'finish', reason }
}
