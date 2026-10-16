/**
 * Cline Pass 网关的传输层：只管发请求，不含钉住/故障转移策略。
 * 不依赖 dsh 的任何包，命令行工具（bin/cline-pin.mjs）也用它。
 *
 * @module dsh-cline-pin/gateway
 */
import { availableChannels, probeBody } from './pin.js'
import { errorText } from './wire.js'

/** 网关的默认地址。 */
export const DEFAULT_BASE_URL = 'https://api.cline.bot/api/v1'

/** 官方公开的订阅模型清单（无需登录）。 */
export const MODELS_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'

/** 聊天补全接口的完整地址。 */
export const chatURL = (baseURL) => `${String(baseURL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')}/chat/completions`

const withTimeout = (signal, timeoutMs) => AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal === undefined ? [] : [signal])])

/**
 * 发一个非流式 JSON 请求。HTTP 错误不会抛出，而是照常返回状态码和内容。
 * @returns {Promise<{ status: number, ok: boolean, json: any, text: string }>}
 */
export async function postJSON(url, apiKey, body, { signal, timeoutMs = 60_000, headers = {} } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${apiKey}`, ...headers },
    body: JSON.stringify(body),
    signal: withTimeout(signal, timeoutMs),
  })
  const text = await response.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, ok: response.ok, json, text }
}

/**
 * 向两套路由器各问一次它们各自的渠道清单：把渠道钉到一个不存在的名字，路由器会在
 * 花任何 token 之前报错，并把能用的全部渠道列在报错里。某一边问不到就是 null。
 * @returns {Promise<{ planner: string[]|null, direct: string[]|null }>}
 */
export async function discoverChannels({ baseURL, apiKey, model, signal, timeoutMs = 30_000, headers }) {
  const ask = async (pipeline) => {
    try {
      const { json, text } = await postJSON(chatURL(baseURL), apiKey, probeBody(model, pipeline), { signal, timeoutMs, headers })
      // 清单可能在 error.message 里（夹在文案或内嵌的 JSON 里），也可能在原始响应体或 error.metadata 里，逐个试。
      const listed = json?.error?.metadata?.available_providers
      return availableChannels(errorText(json?.error), pipeline)
        ?? availableChannels(text, pipeline)
        ?? (Array.isArray(listed) && listed.length > 0 ? listed.map(String) : null)
    } catch {
      return null
    }
  }
  const [planner, direct] = await Promise.all([ask('planner'), ask('direct')])
  return { planner, direct }
}

/**
 * 读官方公开的 Cline Pass 订阅模型清单。
 * @returns {Promise<{ id: string, description: string }[]>}
 */
export async function fetchModelIds({ url = MODELS_URL, signal, timeoutMs = 15_000 } = {}) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: withTimeout(signal, timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const json = await response.json()
  return (Array.isArray(json?.clinePass) ? json.clinePass : []).map((model) => ({ id: String(model.id), description: String(model.description ?? '') }))
}
