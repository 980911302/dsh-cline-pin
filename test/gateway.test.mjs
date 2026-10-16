import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chatURL, discoverChannels, fetchModelIds, postJSON } from '../lib/gateway.js'
import { startMockGateway, TEST_KEY } from './mock-gateway.mjs'

const CLI = fileURLToPath(new URL('../bin/cline-pin.mjs', import.meta.url))

/** 运行命令行工具，返回 { code, stdout, stderr }。 */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('聊天接口地址：去掉末尾斜杠，空值用默认网关', () => {
  assert.equal(chatURL('http://x/api/v1///'), 'http://x/api/v1/chat/completions')
  assert.equal(chatURL(''), 'https://api.cline.bot/api/v1/chat/completions')
})

test('postJSON：HTTP 错误不抛出，而是照常返回状态码和内容', async () => {
  const gateway = await startMockGateway()
  try {
    const response = await postJSON(`${gateway.url}/chat/completions`, 'wrong-key', { model: 'm' })
    assert.equal(response.status, 401)
    assert.equal(response.ok, false)
    assert.match(response.json.error.message, /Unauthorized/)
  } finally {
    await gateway.close()
  }
})

test('取渠道清单：两种路由器的报错格式都能解析，且探测不会带上任何真实内容', async () => {
  const gateway = await startMockGateway({ channels: { planner: ['baseten', 'alibaba'], direct: ['baseten', 'z-ai'] } })
  try {
    const found = await discoverChannels({ baseURL: gateway.url, apiKey: TEST_KEY, model: 'cline-pass/m' })
    assert.deepEqual(found, { planner: ['baseten', 'alibaba'], direct: ['baseten', 'z-ai'] })
    assert.deepEqual(gateway.state.requests.map((request) => request.kind).sort(), ['probe-direct', 'probe-planner'])
    for (const request of gateway.state.requests) assert.equal(request.body.max_tokens, 16)
  } finally {
    await gateway.close()
  }
})

test('取渠道清单：密钥不对或服务不可达时，得到 null 而不是抛错', async () => {
  const gateway = await startMockGateway()
  try {
    assert.deepEqual(await discoverChannels({ baseURL: gateway.url, apiKey: 'wrong', model: 'm' }), { planner: null, direct: null })
  } finally {
    await gateway.close()
  }
  assert.deepEqual(await discoverChannels({ baseURL: 'http://127.0.0.1:1/api/v1', apiKey: 'k', model: 'm', timeoutMs: 2000 }), { planner: null, direct: null })
})

test('读官方模型清单：只取 clinePass 一栏', async () => {
  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ recommended: [{ id: 'x/y' }], clinePass: [{ id: 'cline-pass/a', description: 'A' }, { id: 'cline-pass/b' }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const models = await fetchModelIds({ url: `http://127.0.0.1:${server.address().port}/m` })
    assert.deepEqual(models, [{ id: 'cline-pass/a', description: 'A' }, { id: 'cline-pass/b', description: '' }])
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('命令行 probe：列出两边的渠道清单', async () => {
  const gateway = await startMockGateway({ channels: { planner: ['baseten', 'alibaba'], direct: ['baseten', 'z-ai'] } })
  try {
    const result = await runCli(['probe', 'cline-pass/m'], { CLINE_PASS_API_KEY: TEST_KEY, CLINE_PASS_BASE_URL: gateway.url })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /baseten, alibaba/)
    assert.match(result.stdout, /baseten, z-ai/)
  } finally {
    await gateway.close()
  }
})

test('命令行 check：渠道都按钉住响应 → 退出码 0；网关无视钉住 → 报告 missed 且退出码 1', async () => {
  const gateway = await startMockGateway()
  try {
    const env = { CLINE_PASS_API_KEY: TEST_KEY, CLINE_PASS_BASE_URL: gateway.url }
    const honored = await runCli(['check', 'cline-pass/m', 'baseten', 'alibaba', '--json'], env)
    assert.equal(honored.code, 0, honored.stderr)
    assert.deepEqual(JSON.parse(honored.stdout).rows.map((row) => [row.channel, row.verdict]), [['baseten', 'adopted'], ['alibaba', 'adopted']])

    gateway.state.ignorePin = true
    const ignored = await runCli(['check', 'cline-pass/m', 'baseten', '--json'], env)
    assert.equal(ignored.code, 1)
    const [row] = JSON.parse(ignored.stdout).rows
    assert.equal(row.verdict, 'missed')
    assert.equal(row.served, 'DeepSeek')
  } finally {
    await gateway.close()
  }
})

test('命令行 check：不指定渠道时，自动检查 probe 到的全部渠道（planner 与 direct 去重）', async () => {
  const gateway = await startMockGateway({ channels: { planner: ['baseten', 'zai'], direct: ['baseten', 'alibaba'] } })
  try {
    const result = await runCli(['check', 'cline-pass/m', '--json'], { CLINE_PASS_API_KEY: TEST_KEY, CLINE_PASS_BASE_URL: gateway.url })
    assert.deepEqual(JSON.parse(result.stdout).rows.map((row) => row.channel), ['baseten', 'zai', 'alibaba'])
  } finally {
    await gateway.close()
  }
})

test('命令行：缺少密钥或命令不认识时给出明确提示，退出码 2', async () => {
  const noKey = await runCli(['probe', 'cline-pass/m'], {})
  assert.equal(noKey.code, 2)
  assert.match(noKey.stderr, /缺少密钥/)
  const unknown = await runCli(['frobnicate'], {})
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /不认识的命令/)
  const help = await runCli(['--help'], {})
  assert.equal(help.code, 0)
  assert.match(help.stdout, /用法：cline-pin/)
})
