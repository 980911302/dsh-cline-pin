#!/usr/bin/env node
/**
 * 端到端测试：用你机器上真实的 DeepSeek Harness (dsh) 加载本插件，让它对本地假网关发请求，
 * 验证钉住字段真的发出去、故障转移、enforce 等行为。
 *
 * - 全程使用临时的 DSH_HOME，不会碰你真实的 ~/.dsh。
 * - 网关是本机 127.0.0.1 上的假网关，密钥是测试占位值，不会联网、不会花一分钱。
 * - 需要找到 dsh：设置环境变量 DSH_BIN，或让 `dsh` 在 PATH 里，或安装在 /Applications。
 *
 *   DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" node test/e2e.mjs
 *
 * 默认以 link 的方式装本目录。想测打包后的安装（插件被复制进 profile）：
 *   npm pack --pack-destination /tmp && PLUGIN_SPEC=/tmp/dsh-cline-pin-0.1.0.tgz node test/e2e.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockGateway, TEST_KEY } from './mock-gateway.mjs'

const PLUGIN_SPEC = resolve(process.env.PLUGIN_SPEC ?? fileURLToPath(new URL('..', import.meta.url)))
const MODEL = 'cline-pass/glm-5.3'
const FALLBACK_MODEL = 'cline-pass/fallback-test'
const RUN_TIMEOUT_MS = 180_000

function findDsh() {
  const executable = (path) => {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const candidates = [
    process.env.DSH_BIN,
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    ...(process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, 'dsh')),
  ].filter(Boolean)
  return candidates.find(executable)
}

const dsh = findDsh()
if (dsh === undefined) {
  console.error('找不到 dsh。请设置 DSH_BIN 指向 DeepSeek Harness 的 dsh 命令，例如：\n  DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" node test/e2e.mjs')
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'cline-pin-e2e-'))
// 用真实路径：macOS 的临时目录在 /var 下，实际是 /private/var 的软链，工作区策略按真实路径比较。
const work = realpathSync(mkdtempSync(join(tmpdir(), 'cline-pin-e2e-work-')))
writeFileSync(join(work, 'marker.txt'), 'PINNED-CONTENT-12345\n')
assert.notEqual(resolve(home), resolve(process.env.HOME ?? '', '.dsh'), '临时 DSH_HOME 不应该是真实的 ~/.dsh')
const logPath = join(home, 'logs', 'cline-pin.log')
const patchPath = join(home, 'profiles', 'headless', 'cordis.patch.yml')

/** 运行 dsh，返回 { code, stdout, stderr }。 */
function run(args, { env = {}, timeoutMs = RUN_TIMEOUT_MS } = {}) {
  return new Promise((done) => {
    const base = { ...process.env, DSH_HOME: home, CLINE_PASS_API_KEY: TEST_KEY }
    const child = spawn(dsh, args, { cwd: work, env: { ...base, ...env } })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

const parseEvents = (stdout) => stdout.split('\n').filter((line) => line.startsWith('{')).flatMap((line) => {
  try {
    return [JSON.parse(line)]
  } catch {
    return []
  }
})

/** 读请求日志，每行解析成对象。 */
function readLog() {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => {
    const entry = {}
    for (const [, key, raw] of line.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) entry[key] = raw.startsWith('"') ? JSON.parse(raw) : raw
    return entry
  })
}

function writePatch(config, model = MODEL) {
  const patch = [
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'cline-pin', model } },
    { id: 'cline-pin', name: 'dsh-cline-pin', config: { baseURL: gateway.url, knownModels: [model], ...config } },
  ]
  writeFileSync(patchPath, JSON.stringify(patch, null, 2))
}

const gateway = await startMockGateway()
const defaults = { ...gateway.state }

/** 主对话请求（带工具定义的那个）；另有一个不带工具的会话标题请求，断言时忽略。 */
const mainRequests = () => gateway.state.requests.filter((request) => request.kind === 'stream' && request.body.tools !== undefined)
const finalText = (result) => parseEvents(result.stdout).find((event) => event.type === 'final')?.text

/** 这一轮失败时的错误（{ message, code }）；成功则是 undefined。失败时 dsh 仍会输出 final，但文本是空的。 */
const failureOf = (result) => {
  const reason = parseEvents(result.stdout).find((event) => event.type === 'status' && event.phase === 'turn_end')?.reason
  return reason?.kind === 'error' ? reason.error : undefined
}

const scenarios = [
  {
    name: 'strict 钉住：两种拼法都发到网关，回答来自钉住的渠道，日志记为 adopted',
    config: { perModel: { [MODEL]: { upstreams: ['baseten', 'alibaba'], pinMode: 'strict' } } },
    async check({ result, log }) {
      assert.equal(failureOf(result), undefined)
      assert.equal(finalText(result), 'Hello from baseten')
      const [request] = mainRequests()
      assert.deepEqual(request.body.providerOptions, { gateway: { only: ['baseten'] } })
      assert.deepEqual(request.body.provider, { only: ['baseten'] })
      assert.equal(request.body.max_tokens, 32000)
      assert.equal(request.body.stream_options.include_usage, true)
      assert.match(request.headers['user-agent'], /deepseek-harness/)
      assert.ok(log.some((entry) => entry.want === 'baseten' && entry.got === 'Baseten' && entry.verdict === 'adopted'), JSON.stringify(log))
    },
  },
  {
    name: '故障转移：第一个渠道 503，首个内容块之前换到第二个渠道',
    config: { perModel: { [MODEL]: { upstreams: ['baseten', 'alibaba'], pinMode: 'strict' } } },
    mock: { failChannels: ['baseten'] },
    async check({ result, log }) {
      assert.equal(finalText(result), 'Hello from alibaba')
      assert.deepEqual(mainRequests().map((request) => request.channel), ['baseten', 'alibaba'])
      assert.ok(log.some((entry) => entry.want === 'baseten' && entry.result === 'failed' && entry.code === 'SERVER' && entry.next === 'alibaba'), JSON.stringify(log))
      assert.ok(log.some((entry) => entry.want === 'alibaba' && entry.verdict === 'adopted' && entry.earlier_failures === 'baseten'), JSON.stringify(log))
    },
  },
  {
    name: '空回答也算这个渠道失败，换下一个渠道',
    config: { perModel: { [MODEL]: { upstreams: ['baseten', 'alibaba'], pinMode: 'strict' } } },
    mock: { emptyChannels: ['baseten'] },
    async check({ result, log }) {
      assert.equal(failureOf(result), undefined)
      assert.equal(finalText(result), 'Hello from alibaba')
      assert.deepEqual(mainRequests().map((request) => request.channel), ['baseten', 'alibaba'], '空回答只该触发一次换渠道，而不是反复重试同一个渠道')
      assert.ok(log.some((entry) => entry.want === 'baseten' && entry.code === 'EMPTY_RESPONSE' && entry.next === 'alibaba'), JSON.stringify(log))
    },
  },
  {
    name: '流式请求收到 200 + JSON 错误体：带出真正的错误文本，并换下一个渠道',
    config: { perModel: { [MODEL]: { upstreams: ['baseten', 'alibaba'], pinMode: 'strict' } } },
    mock: { jsonErrorChannels: ['baseten'] },
    async check({ result, log }) {
      assert.equal(finalText(result), 'Hello from alibaba')
      assert.ok(log.some((entry) => entry.want === 'baseten' && /baseten exploded/.test(entry.error ?? '') && entry.next === 'alibaba'), JSON.stringify(log))
    },
  },
  {
    name: '网关无视钉住 + enforce 关闭：内容照常交付，日志记为 missed（警告）',
    config: { perModel: { [MODEL]: { upstreams: ['baseten'], pinMode: 'strict' } }, enforce: false },
    mock: { ignorePin: true },
    async check({ result, log }) {
      assert.equal(finalText(result), 'Hello from deepseek')
      assert.ok(log.some((entry) => entry.want === 'baseten' && entry.got === 'DeepSeek' && entry.verdict === 'missed'), JSON.stringify(log))
    },
  },
  {
    name: '网关无视钉住 + enforce 开启：交出任何内容之前放弃，逐个候选都被拦下，请求失败',
    config: { perModel: { [MODEL]: { upstreams: ['baseten', 'alibaba'], pinMode: 'strict' } }, enforce: true },
    mock: { ignorePin: true },
    async check({ result, log }) {
      assert.equal(failureOf(result)?.code, 'PIN_NOT_HONORED')
      assert.equal(finalText(result), '', '被拦下的请求不该有任何回答内容')
      assert.deepEqual(mainRequests().map((request) => request.channel), ['deepseek', 'deepseek'], '两个候选都应该被尝试过，且各只尝试一次')
      assert.ok(log.some((entry) => entry.want === 'baseten' && entry.code === 'PIN_NOT_HONORED' && entry.next === 'alibaba'), JSON.stringify(log))
      assert.ok(log.some((entry) => entry.want === 'alibaba' && entry.code === 'PIN_NOT_HONORED' && entry.next === 'none'), JSON.stringify(log))
    },
  },
  {
    name: 'preferred：写 order 而不是 only，名单里的第一个渠道优先',
    config: { perModel: { [MODEL]: { upstreams: ['alibaba', 'baseten'], pinMode: 'preferred' } } },
    async check({ result, log }) {
      assert.equal(finalText(result), 'Hello from alibaba')
      const [request] = mainRequests()
      assert.deepEqual(request.body.providerOptions.gateway, { order: ['alibaba', 'baseten'] })
      assert.deepEqual(request.body.provider, { order: ['alibaba', 'baseten'] })
      assert.ok(log.some((entry) => entry.want === 'alibaba' && entry.verdict === 'adopted'), JSON.stringify(log))
    },
  },
  {
    name: 'exclude：先探测渠道清单（不花 token），再编译成白名单，并带上 OpenRouter 的 ignore',
    config: { perModel: { [MODEL]: { exclude: ['deepseek'] } } },
    async check({ result }) {
      assert.equal(finalText(result), 'Hello from baseten')
      const probes = gateway.state.requests.filter((request) => request.kind.startsWith('probe'))
      assert.deepEqual(probes.map((request) => request.kind).sort(), ['probe-direct', 'probe-planner'], '只探测一次（第二个请求用缓存）')
      const [request] = mainRequests()
      assert.deepEqual(request.body.providerOptions.gateway, { only: ['baseten', 'alibaba'] })
      assert.deepEqual(request.body.provider, { only: ['baseten', 'alibaba'], ignore: ['deepseek'] })
    },
  },
  {
    name: 'planner 路由器：渠道只在最后一帧的元数据里出现，同样能核对（adopted）',
    config: { perModel: { [MODEL]: { upstreams: ['baseten'], pinMode: 'strict' } } },
    mock: { pipeline: 'planner' },
    async check({ result, log }) {
      assert.equal(finalText(result), 'Hello from baseten')
      assert.ok(log.some((entry) => entry.want === 'baseten' && entry.got === 'baseten' && entry.verdict === 'adopted'), JSON.stringify(log))
    },
  },
  {
    name: 'planner 路由器 + 网关无视钉住 + enforce：渠道要到最后才知道，拦不住，但会如实记为 missed',
    config: { perModel: { [MODEL]: { upstreams: ['baseten'], pinMode: 'strict' } }, enforce: true },
    mock: { pipeline: 'planner', ignorePin: true },
    async check({ result, log }) {
      assert.equal(finalText(result), 'Hello from deepseek')
      assert.ok(log.some((entry) => entry.want === 'baseten' && entry.got === 'deepseek' && entry.verdict === 'missed'), JSON.stringify(log))
    },
  },
  {
    name: '工具调用往返：并行两个 tool_calls（参数分片、交错到达）→ dsh 真实执行 → 结果按 OpenAI 格式回传，钉住在两个请求里都在',
    config: { perModel: { [MODEL]: { upstreams: ['baseten'], pinMode: 'strict' } } },
    mock: { toolCalls: [{ name: 'read', arguments: { file_path: join(work, 'marker.txt') } }, { name: 'glob', arguments: { pattern: 'marker*' } }] },
    async check({ result }) {
      assert.equal(failureOf(result), undefined)
      assert.match(finalText(result), /^Tool said: .*PINNED-CONTENT-12345.*marker\.txt/s)
      const [first, second] = mainRequests()
      assert.equal(mainRequests().length, 2, '一次工具往返 = 两个主请求')
      const messages = second.body.messages
      const assistantAt = messages.findIndex((message) => message.role === 'assistant')
      const assistant = messages[assistantAt]
      assert.deepEqual(assistant.tool_calls.map((call) => [call.id, call.type, call.function.name]), [['call_mock_1', 'function', 'read'], ['call_mock_2', 'function', 'glob']])
      assert.equal(JSON.parse(assistant.tool_calls[0].function.arguments).file_path, join(work, 'marker.txt'), '分片参数拼接后必须是完整合法的 JSON')
      assert.deepEqual(JSON.parse(assistant.tool_calls[1].function.arguments), { pattern: 'marker*' })
      // 助手消息后面必须紧跟每个调用 id 的 tool 回答，且 id 一一对应
      const answers = messages.slice(assistantAt + 1, assistantAt + 3)
      assert.deepEqual(answers.map((message) => message.role), ['tool', 'tool'])
      assert.deepEqual(answers.map((message) => message.tool_call_id).sort(), ['call_mock_1', 'call_mock_2'])
      assert.match(answers.find((message) => message.tool_call_id === 'call_mock_1').content, /PINNED-CONTENT-12345/)
      assert.match(answers.find((message) => message.tool_call_id === 'call_mock_2').content, /marker\.txt/)
      for (const request of [first, second]) assert.deepEqual(request.body.provider, { only: ['baseten'] })
    },
  },
  {
    name: '没有钉住配置：请求体不带任何路由字段',
    config: {},
    async check({ result, log }) {
      assert.equal(finalText(result), 'Hello from deepseek')
      const [request] = mainRequests()
      assert.equal(request.body.provider, undefined)
      assert.equal(request.body.providerOptions, undefined)
      assert.ok(log.filter((entry) => entry.want !== undefined).every((entry) => entry.want === 'auto'), JSON.stringify(log))
      assert.ok(log.some((entry) => entry.event === 'auto-pinned' && entry.channel === 'deepseek'), JSON.stringify(log))
    },
  },
  {
    name: 'logFile: off：不写请求日志文件',
    config: { logFile: 'off', perModel: { [MODEL]: { upstreams: ['baseten'] } } },
    async check({ result }) {
      assert.equal(finalText(result), 'Hello from baseten')
      assert.equal(existsSync(logPath), false)
    },
  },
  {
    name: '没有密钥：明确提示缺哪个凭据，不会向网关发任何请求',
    config: { perModel: { [MODEL]: { upstreams: ['baseten'] } } },
    env: { CLINE_PASS_API_KEY: '' },
    async check({ result }) {
      const failure = failureOf(result)
      assert.equal(failure?.code, 'MISSING_CREDENTIAL')
      assert.match(failure.message, /CLINE_PASS_API_KEY/)
      assert.equal(gateway.state.requests.length, 0)
    },
  },
  {
    name: '渠道探测不可用：第一次自动路由，并从实际响应兜底学习渠道',
    model: FALLBACK_MODEL,
    config: {},
    mock: { probeUnavailable: true },
    async check({ result, log }) {
      assert.equal(finalText(result), 'Hello from deepseek')
      assert.ok(log.some((entry) => entry.event === 'auto-pinned' && entry.channel === 'deepseek'), JSON.stringify(log))
    },
  },
]

let failures = 0
try {
  console.log(`dsh: ${dsh}\n临时 DSH_HOME: ${home}\n`)
  await run(['--profile', 'headless', '--help'])
  const install = await run(['plugin', '--profile', 'headless', 'add', PLUGIN_SPEC])
  if (install.code !== 0) throw new Error(`安装插件失败 (exit ${install.code})：\n${install.stdout}\n${install.stderr}`)
  const manifestPath = join(home, 'profiles', 'headless', 'package.json')
  const installed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(installed.dependencies?.['dsh-cline-pin'], '插件应该出现在 profile 的 dependencies 里')
  assert.ok(installed.dsh?.profile?.bundles?.includes('dsh-cline-pin'), '插件应该被登记为 profile 的 bundle')
  console.log(`✔ 插件已装进临时 profile（${installed.dependencies['dsh-cline-pin'].replace(home, '<home>')}）\n`)

  for (const scenario of scenarios) {
    Object.assign(gateway.state, defaults, scenario.mock ?? {})
    gateway.state.requests = []
    rmSync(join(home, 'logs'), { recursive: true, force: true })
    writePatch(scenario.config, scenario.model ?? MODEL)
    const result = await run(['--profile', 'headless', '--json', 'say hi'], { env: scenario.env })
    try {
      await scenario.check({ result, log: readLog() })
      console.log(`✔ ${scenario.name}`)
    } catch (error) {
      failures += 1
      console.log(`✘ ${scenario.name}\n    ${String(error.message).split('\n').join('\n    ')}`)
      console.log(`    --- dsh exit=${result.code}\n    stdout: ${result.stdout.slice(0, 1500).split('\n').join('\n    ')}\n    stderr: ${result.stderr.slice(0, 1500).split('\n').join('\n    ')}`)
      console.log(`    --- 假网关收到 ${gateway.state.requests.length} 个请求：${JSON.stringify(gateway.state.requests.map((request) => [request.kind, request.channel]))}`)
    }
  }

  // 卸载：README 里写的 `remove` 要真的能把插件干净地摘掉。
  const removal = await run(['plugin', '--profile', 'headless', 'remove', 'dsh-cline-pin'])
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  try {
    assert.equal(removal.code, 0, `${removal.stdout}\n${removal.stderr}`)
    assert.equal(after.dependencies?.['dsh-cline-pin'], undefined)
    assert.equal(after.dsh?.profile?.bundles?.includes('dsh-cline-pin'), false)
    console.log('✔ 卸载：`plugin remove` 同时摘掉了依赖和 bundle 登记')
  } catch (error) {
    failures += 1
    console.log(`✘ 卸载\n    ${String(error.message).split('\n').join('\n    ')}`)
  }
} catch (error) {
  failures += 1
  console.error(error.message)
} finally {
  await gateway.close()
  if (process.env.KEEP_E2E_HOME === '1') console.log(`\n保留了临时目录：${home}`)
  else {
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? `\n全部 ${scenarios.length} 个场景通过` : `\n${failures} 个场景失败`)
process.exit(failures === 0 ? 0 : 1)
