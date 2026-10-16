#!/usr/bin/env node
/**
 * cline-pin：不用启动 dsh，就能查 Cline Pass 的上游渠道、核对钉住是否真的生效。
 *
 * 只用 Node 内置模块。密钥只从环境变量读，不接受命令行参数（避免进 shell 历史）。
 */
import { parseArgs } from 'node:util'
import { chatURL, DEFAULT_BASE_URL, discoverChannels, fetchModelIds, postJSON } from '../lib/gateway.js'
import { adherence, buildAttempts, injectPin, servedBy, slug } from '../lib/pin.js'
import { errorText } from '../lib/wire.js'

const HELP = `用法：cline-pin <命令> [选项]

命令：
  models                     列出官方当前的 Cline Pass 订阅模型（无需密钥），输出可直接粘贴的 knownModels
  probe <model>              列出该模型背后各路由器的上游渠道（需要密钥；不消耗 token）
  check <model> [渠道...]    对每个渠道发一次极小的真实请求，核对到底是不是该渠道响应
                             （需要密钥；每个渠道消耗极少的 token；不写渠道则检查 probe 到的全部渠道）

选项：
  --base-url <url>   网关地址，默认 ${DEFAULT_BASE_URL}（也可用环境变量 CLINE_PASS_BASE_URL）
  --key-env <名字>   从哪个环境变量读密钥，默认 CLINE_PASS_API_KEY
  --json             输出 JSON
  -h, --help         显示本帮助

例：
  export CLINE_PASS_API_KEY=sk-...
  cline-pin probe cline-pass/kimi-k3
  cline-pin check cline-pass/kimi-k3 baseten alibaba`

const VERDICTS = {
  adopted: '✔ 由钉住的渠道响应',
  missed: '✘ 网关没有按钉住走',
  violated: '✘ 被排除的渠道响应了',
  unknown: '? 响应没标明渠道，无法判断',
  error: '✘ 请求失败',
}

function fail(message, code = 2) {
  console.error(`cline-pin: ${message}`)
  process.exit(code)
}

let parsed
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
      'key-env': { type: 'string', default: 'CLINE_PASS_API_KEY' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
} catch (error) {
  fail(`${error.message}\n\n${HELP}`)
}

const { values, positionals } = parsed
const [command, model, ...channels] = positionals
const baseURL = values['base-url'] ?? process.env.CLINE_PASS_BASE_URL ?? DEFAULT_BASE_URL

function apiKey() {
  const key = process.env[values['key-env']]
  if (key === undefined || key.trim() === '') fail(`缺少密钥：请先 export ${values['key-env']}=sk-...`)
  return key.trim()
}

/** 限制并发地对每一项执行 fn，结果顺序与输入一致。 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** 对一个渠道发一次 strict 钉住的极小请求，看是谁响应的。 */
async function checkOne(key, channel) {
  const attempt = buildAttempts({ upstreams: [channel], pinMode: 'strict' })[0]
  const body = injectPin({ model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 128 }, attempt)
  const started = Date.now()
  try {
    const response = await postJSON(chatURL(baseURL), key, body, { timeoutMs: 90_000 })
    const ms = Date.now() - started
    if (response.ok && (response.json?.choices !== undefined || response.json?.data?.choices !== undefined)) {
      const served = servedBy(response.json)
      return { channel, verdict: adherence(attempt, served), served, ms, note: '' }
    }
    return { channel, verdict: 'error', served: null, ms, note: (errorText(response.json?.error) || response.text).slice(0, 120) }
  } catch (error) {
    return { channel, verdict: 'error', served: null, ms: Date.now() - started, note: String(error?.message ?? error).slice(0, 120) }
  }
}

async function main() {
  if (values.help || command === undefined) {
    console.log(HELP)
    return
  }

  if (command === 'models') {
    const models = await fetchModelIds()
    if (values.json) return console.log(JSON.stringify(models, null, 2))
    console.log('# 粘贴到 profile 的 cordis.patch.yml 里，cline-pin 那一行的 config 下')
    console.log('knownModels:')
    for (const entry of models) console.log(`  - ${entry.id}${entry.description === '' ? '' : `   # ${entry.description}`}`)
    return
  }

  if (command === 'probe') {
    if (model === undefined) fail('probe 需要模型 id，例如 cline-pass/kimi-k3')
    const found = await discoverChannels({ baseURL, apiKey: apiKey(), model })
    if (values.json) return console.log(JSON.stringify({ model, ...found }, null, 2))
    const show = (names) => (names === null ? '（没问到）' : names.join(', '))
    console.log(`模型：${model}`)
    console.log(`  Vercel AI Gateway (planner): ${show(found.planner)}`)
    console.log(`  OpenRouter        (direct) : ${show(found.direct)}`)
    if (found.planner === null && found.direct === null) {
      console.error('两边都没问到渠道清单：检查模型 id、密钥和网络；也可以直接 `cline-pin check <model> <渠道>` 逐个试。')
      process.exitCode = 1
    }
    return
  }

  if (command === 'check') {
    if (model === undefined) fail('check 需要模型 id，例如 cline-pass/kimi-k3')
    const key = apiKey()
    let targets = channels
    if (targets.length === 0) {
      const found = await discoverChannels({ baseURL, apiKey: key, model })
      const seen = new Set()
      targets = [...(found.planner ?? []), ...(found.direct ?? [])].filter((name) => !seen.has(slug(name)) && seen.add(slug(name)))
      if (targets.length === 0) fail('没能取到渠道清单，请直接指定要检查的渠道：cline-pin check <model> <渠道>', 1)
    }
    const rows = await mapLimit(targets, 3, (channel) => checkOne(key, channel))
    if (values.json) {
      console.log(JSON.stringify({ model, rows }, null, 2))
    } else {
      console.log(`模型：${model}（每个渠道各发一次 strict 钉住的请求）`)
      for (const row of rows) {
        const served = row.served === null ? '' : `  实际：${row.served}`
        console.log(`  ${row.channel.padEnd(18)} ${VERDICTS[row.verdict] ?? row.verdict}${served}  ${row.ms}ms${row.note === '' ? '' : `  ${row.note}`}`)
      }
    }
    if (rows.some((row) => row.verdict === 'missed' || row.verdict === 'violated')) process.exitCode = 1
    return
  }

  fail(`不认识的命令 "${command}"\n\n${HELP}`)
}

main().catch((error) => fail(String(error?.message ?? error), 1))
