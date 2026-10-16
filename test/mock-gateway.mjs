/**
 * 本地假网关：模拟 Cline Pass 网关的聊天接口、两种路由器对钉住字段的处理，以及
 * "钉到不存在的渠道"时的报错清单。只监听 127.0.0.1，不访问任何外部服务，仅用于测试。
 */
import http from 'node:http'

/** 假网关接受的密钥——只是测试占位值，不是任何真实凭据。 */
export const TEST_KEY = 'sk-test-local-mock-key'

const DISPLAY = { baseten: 'Baseten', alibaba: 'Alibaba', deepseek: 'DeepSeek', zai: 'Z.AI' }
const display = (channel) => DISPLAY[channel] ?? channel

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/**
 * 启动假网关。返回 `{ url, state, close }`：`state` 可随时改，用来切换网关的行为。
 *
 * - models        官方公开清单（GET .../ai/cline/recommended-models）返回的模型 id。
 * - pipeline      本模型走哪套路由器：direct 读 provider.*、每一帧带 provider；
 *                 planner 读 providerOptions.gateway.*、渠道只在最后的元数据帧里给。
 * - ignorePin     true：无视所有钉住，一律由 fallback 渠道响应。
 * - failChannels  选中这些渠道时返回 503。
 * - emptyChannels 选中这些渠道时返回"成功但没有内容"。
 * - jsonErrorChannels 选中这些渠道时，对流式请求返回 200 + JSON 错误体。
 */
export async function startMockGateway(initial = {}) {
  const state = {
    requests: [],
    pipeline: 'direct',
    models: ['cline-pass/glm-5.3', 'cline-pass/kimi-k3', 'cline-pass/qwen3.7-max'],
    channels: { planner: ['baseten', 'alibaba', 'deepseek'], direct: ['baseten', 'alibaba', 'deepseek'] },
    fallback: 'deepseek',
    ignorePin: false,
    failChannels: [],
    emptyChannels: [],
    jsonErrorChannels: [],
    probeUnavailable: false,
    // 非空时，带工具定义的流式请求会先回复这些并行的工具调用 [{ name, arguments }]；
    // 等工具结果回传后，再回复 "Tool said: <各工具输出>"。
    toolCalls: [],
    reply: (channel) => `Hello from ${channel}`,
    ...initial,
  }

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      // 官方公开的订阅模型清单（无需密钥）
      if (req.method === 'GET' && req.url.endsWith('/ai/cline/recommended-models')) {
        state.requests.push({ kind: 'models', headers: req.headers })
        return sendJSON(res, 200, { clinePass: state.models.map((id) => ({ id, name: id, description: '' })) })
      }
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) return sendJSON(res, 404, { error: { message: 'not found' } })
      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) return sendJSON(res, 401, { error: { message: 'Unauthorized: invalid api key' } })
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return sendJSON(res, 400, { error: { message: 'invalid json' } })
      }
      const planner = body.providerOptions?.gateway
      const direct = body.provider

      // 探测：钉到不存在的渠道 → 在花任何 token 之前报错，并列出能用的渠道。
      if (planner?.only?.includes('__probe__')) {
        state.requests.push({ kind: 'probe-planner', body, headers: req.headers })
        if (state.probeUnavailable) return sendJSON(res, 403, { error: { message: 'not subscribed to required model plan' } })
        return sendJSON(res, 400, { error: { message: `No providers matched ["__probe__"]. Available providers are: ${state.channels.planner.join(', ')}.` } })
      }
      if (direct?.only?.includes('__probe__')) {
        state.requests.push({ kind: 'probe-direct', body, headers: req.headers })
        if (state.probeUnavailable) return sendJSON(res, 403, { error: { message: 'not subscribed to required model plan' } })
        const inner = { error: { message: 'No allowed providers are available', code: 404, metadata: { available_providers: state.channels.direct, requested_providers: ['__probe__'] } } }
        return sendJSON(res, 404, { error: { message: `Provider returned error ${JSON.stringify(inner)}`, code: 404 } })
      }

      const view = state.pipeline === 'planner' ? planner : direct
      const wanted = state.ignorePin ? undefined : (view?.order?.[0] ?? view?.only?.[0])
      const known = state.channels[state.pipeline]
      const channel = wanted !== undefined && known.includes(wanted) ? wanted : state.fallback
      state.requests.push({ kind: body.stream ? 'stream' : 'complete', body, headers: req.headers, channel })

      if (state.failChannels.includes(channel)) return sendJSON(res, 503, { error: { message: `upstream ${channel} unavailable` } })
      // 流式请求却回 200 + JSON 错误体（有的网关会这样）
      if (state.jsonErrorChannels.includes(channel) && body.stream === true) return sendJSON(res, 200, { error: { message: `upstream ${channel} exploded` } })

      // 对话末尾连续的 tool 消息 = 刚回传的工具结果
      const trailing = []
      for (let i = (body.messages?.length ?? 0) - 1; i >= 0 && body.messages[i].role === 'tool'; i -= 1) trailing.unshift(String(body.messages[i].content))
      const scripted = state.toolCalls.length > 0
      const calling = body.stream === true && body.tools !== undefined && scripted && trailing.length === 0
      const text = state.emptyChannels.includes(channel)
        ? ''
        : scripted && trailing.length > 0 ? `Tool said: ${trailing.join(' | ').slice(0, 400)}` : state.reply(channel)
      const labelled = state.pipeline === 'direct' ? { provider: display(channel) } : {}
      const routing = state.pipeline === 'planner' ? { provider_metadata: { gateway: { routing: { finalProvider: channel, canonicalSlug: body.model } } } } : {}

      if (body.stream !== true) {
        return sendJSON(res, 200, {
          id: 'mock',
          model: body.model,
          ...labelled,
          choices: [{ index: 0, message: { role: 'assistant', content: text, ...routing }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        })
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frame = (extra) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: body.model, ...labelled, ...extra })}\n\n`)
      frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      if (calling) {
        // 每个调用的参数拆成两片，且所有调用交错发送，用来检验分片拼接。
        const args = state.toolCalls.map((call) => JSON.stringify(call.arguments))
        const piece = (index, first) => frame({
          choices: [{
            index: 0,
            delta: { tool_calls: [first
              ? { index, id: `call_mock_${index + 1}`, type: 'function', function: { name: state.toolCalls[index].name, arguments: args[index].slice(0, 8) } }
              : { index, function: { arguments: args[index].slice(8) } }] },
            finish_reason: null,
          }],
        })
        state.toolCalls.forEach((_, index) => piece(index, true))
        state.toolCalls.forEach((_, index) => piece(index, false))
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], ...routing })
        frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      if (text !== '') {
        const middle = Math.ceil(text.length / 2)
        for (const part of [text.slice(0, middle), text.slice(middle)]) {
          frame({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })
        }
      }
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...routing })
      frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    state,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}
