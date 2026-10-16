/**
 * dsh-cline-pin：把 Cline Pass 订阅模型接入 DeepSeek Harness（dsh），并自动钉住每个模型的上游渠道。
 *
 * 用法：在"设置 → 模型"页的 Cline Pass (Pin) 卡片里粘贴密钥，保存。之后：
 *   - 模型清单自动取（官方公开清单）；
 *   - 每个模型第一次用过之后，自动记住网关把它分到了哪个渠道，此后一直锁在那个渠道上
 *     （它挂了才换备选，换成功了锁就跟过去）；
 *   - 想手动指定渠道，在同一张卡片里下拉选；
 *   - 想写进配置文件也行（perModel），配置文件里写的优先级最高：
 *
 *       perModel:
 *         cline-pass/kimi-k3:
 *           upstreams: [baseten, alibaba]   # 候选渠道，按优先级
 *           pinMode: strict                 # strict：一次请求只许一个渠道；preferred：优先，但允许回退
 *           exclude: [deepseek]             # 永远不许用的渠道
 *           sort: ttft                      # 可选：cost / ttft / tps
 *
 * 密钥不放配置里：配置只写凭据名（默认 CLINE_PASS_API_KEY），实际的密钥在 dsh 的凭据存储里。
 *
 * @module dsh-cline-pin
 */
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, attributionHeaders, errorChain, LlmError } from '@deepseek-ai/dsh-llm'
import { ClinePinAdapter } from './adapter.js'
import { chatURL, DEFAULT_BASE_URL, discoverChannels, fetchModelIds, MODELS_URL, postJSON } from './gateway.js'
import { createRecorder, resolveLogPath } from './log.js'
import { DEFAULT_MODELS, KNOWN_WINDOWS } from './models.js'
import { createPanel, registerPanel } from './panel.js'
import { availableChannels, probeBody, slug } from './pin.js'
import { createStore, planFor, resolveLearnedChannel, resolveStatePath } from './state.js'
import { errorText } from './wire.js'

export { ClinePinAdapter } from './adapter.js'
export { adherence, buildAttempts, injectPin, servedBy, servedByPipeline } from './pin.js'

/** dsh 加载器里的插件身份。 */
export const name = 'cline-pin'

/** 需要宿主提供的服务。 */
export const inject = ['llm']

/** 没有在配置里指定时注册的 provider 路由名。 */
export const DEFAULT_PROVIDER = 'cline-pin'

/** 默认的凭据名。 */
export const DEFAULT_API_KEY_ENV = 'CLINE_PASS_API_KEY'

export { DEFAULT_MODELS, KNOWN_WINDOWS }

/** 单个模型的显示与容量覆盖。 */
export const ModelProfile = z.object({
  name: z.string().default(''),
  contextWindow: z.number().default(0),
  maxTokens: z.number().default(0),
})

/** 单个模型的钉住配置。 */
export const PinProfile = z.object({
  upstreams: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  pinMode: z.string().default('strict'),
  sort: z.string().default(''),
})

export const Config = z.object({
  provider: z.string().default(DEFAULT_PROVIDER),
  displayName: z.string().default('Cline Pass (Pin)'),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  // 官方公开的订阅模型清单地址（无需登录）；一般不用改。
  modelsURL: z.string().default(MODELS_URL),
  // volatile：让设置界面能写这个字段（保存密钥用），宿主会把它作为带 .get() 的引用传进来。
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  // 手动指定对外展示的模型清单；留空 = 用设置页取到的官方清单（还没取过就用内置清单）。
  knownModels: z.array(z.string()).default([]),
  models: z.dict(ModelProfile).default({}),
  perModel: z.dict(PinProfile).default({}),
  // 自动锁定：每个没配置过渠道的模型，第一次用过之后自动记住网关分到的渠道，此后锁在它上面。
  autoPin: z.boolean().default(true),
  // 开启后，钉住没被遵守（网关换了别的渠道）就在交出任何内容之前放弃这次尝试，换下一个候选。
  enforce: z.boolean().default(false),
  // 请求日志：空串 = <dsh home>/logs/cline-pin.log；off = 不写；也可以写一个具体路径。
  logFile: z.string().default(''),
  defaultContextWindow: z.number().default(128_000),
  defaultMaxTokens: z.number().default(32_000),
  streamIdleTimeoutMs: z.number().default(300_000),
})

/** volatile 字段是带 .get() 的引用，其余字段就是普通值。 */
const read = (field) => (field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field)

/** 渠道清单缓存多久：两边都读到了就缓存一天，读不全 5 分钟后重读。 */
const channelsTtl = (channels) => (channels?.planner != null && channels?.direct != null ? 86_400_000 : 300_000)

export function apply(ctx, config) {
  const provider = String(config.provider ?? '').trim()
  if (provider === '') throw new LlmError('cline-pin: `provider` 必须是非空的路由名', 'INVALID_ADAPTER')

  const settings = {
    provider,
    displayName: config.displayName,
    baseURL: config.baseURL,
    modelsURL: config.modelsURL,
    knownModels: config.knownModels,
    models: config.models,
    perModel: config.perModel,
    autoPin: config.autoPin,
    enforce: config.enforce,
    defaultContextWindow: config.defaultContextWindow,
    defaultMaxTokens: config.defaultMaxTokens,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    windows: KNOWN_WINDOWS,
  }

  const store = createStore({ file: resolveStatePath() })
  const logFile = resolveLogPath(config.logFile)
  const record = createRecorder({ file: logFile, logger: ctx.logger })

  /** 对外展示的模型：配置里手动指定的 > 设置页取到的官方清单 > 内置清单。 */
  const modelIds = () => {
    if (settings.knownModels.length > 0) return settings.knownModels
    const fetched = store.modelIds()
    return fetched.length > 0 ? fetched : DEFAULT_MODELS
  }

  // ── 密钥 ──────────────────────────────────────────────────────────────────

  const keyRef = () => credentialRef(String(read(config.apiKeyEnv) || DEFAULT_API_KEY_ENV))

  /** 解析密钥：先走凭据服务（桌面版里"设置"和 ~/.dsh/.credentials.yaml 都在这），没有凭据服务才看启动环境。 */
  const apiKey = async () => {
    const ref = keyRef()
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined ? await credentials.resolve(ref) : launchEnvironmentOf(ctx).get(ref)
    const value = hit?.value
    if (value === undefined || String(value).length === 0) {
      throw new LlmError(`cline-pin: 还没有 Cline Pass 密钥；请在"设置 → 模型"页的 ${settings.displayName} 卡片里粘贴并保存（或把 ${ref} 放进 ~/.dsh/.env）`, 'MISSING_CREDENTIAL')
    }
    return assertUsableApiKey(value, 'cline-pin', ref)
  }

  /** 设置页用的密钥存取：只进不出，界面永远拿不到值。 */
  const credentials = {
    get ref() {
      return String(keyRef())
    },
    async describe() {
      const service = ctx.get('credentials')
      if (service !== undefined) return await service.describe(keyRef())
      const ambient = launchEnvironmentOf(ctx).get(keyRef())
      return { configured: ambient !== undefined && ambient.value.length > 0, source: 'env', writable: false }
    },
    async set(value) {
      const service = ctx.get('credentials')
      if (service === undefined) throw new Error('dsh 的凭据服务不可用，没法保存密钥；请改用启动环境变量')
      await service.set(keyRef(), value)
    },
    async unset() {
      const service = ctx.get('credentials')
      if (service === undefined) throw new Error('dsh 的凭据服务不可用')
      await service.unset(keyRef())
    },
  }

  /** 拿一个探测请求试这把密钥：401/403 是被拒；拿到渠道清单说明网关认了；其它情况只能算"没法确认"。 */
  const verifyKey = async (key) => {
    try {
      const model = modelIds()[0] ?? DEFAULT_MODELS[0]
      const response = await postJSON(chatURL(settings.baseURL), key, probeBody(model, 'direct'), { timeoutMs: 30_000, headers: attributionHeaders() })
      const detail = errorText(response.json?.error) || response.text.slice(0, 200)
      if (response.status === 401 || response.status === 403 || /unauthorized|invalid\s*(?:api\s*key|token)|re-?authenticate/i.test(detail)) {
        return { state: 'rejected', detail: detail || `HTTP ${response.status}` }
      }
      const listed = availableChannels(errorText(response.json?.error), 'direct') ?? availableChannels(response.text, 'direct') ?? availableChannels(detail, 'planner')
      return { state: listed === null ? 'unverified' : 'valid', detail }
    } catch (error) {
      return { state: 'unverified', detail: error?.message ?? String(error) }
    }
  }

  // ── 渠道清单与自动锁定 ────────────────────────────────────────────────────

  const inflight = new Map()
  const failedAt = new Map()

  /** 读取并缓存一个模型的渠道清单（探测请求在花任何 token 之前就会失败）。读不到就沿用旧的。 */
  const ensureChannels = async (model, { force = false } = {}) => {
    const entry = store.entry(model)
    if (!force && entry.channels !== undefined && Date.now() - (entry.channelsAt ?? 0) < channelsTtl(entry.channels)) return entry.channels
    if (!force && (failedAt.get(model) ?? 0) > Date.now() - 300_000) return entry.channels ?? null
    if (inflight.has(model)) return await inflight.get(model)
    const job = (async () => {
      const found = await discoverChannels({ baseURL: settings.baseURL, apiKey: await apiKey(), model, headers: attributionHeaders() })
      if (found.planner === null && found.direct === null) {
        failedAt.set(model, Date.now())
        return entry.channels ?? null
      }
      store.patch(model, { channels: found, channelsAt: Date.now() })
      return found
    })().finally(() => inflight.delete(model))
    inflight.set(model, job)
    return await job
  }

  const learning = new Set()

  /**
   * 记住网关把这个模型分到了哪个渠道。
   * 有渠道清单就正常解析（两份路由都写）；探测不到但响应标明了路由器时，按那条路由器的拼法兜底学习。
   */
  const learn = async (model, served, pipeline) => {
    if (learning.has(model)) return
    learning.add(model)
    try {
      const found = resolveLearnedChannel(served, await ensureChannels(model), pipeline)
      if (found === null) return
      store.patch(model, { auto: found.channel, autoPipeline: found.pipeline })
      record({ model, event: 'auto-pinned', channel: found.channel })
    } catch { /* 这次没学成，下次请求再试 */ } finally {
      learning.delete(model)
    }
  }

  /** 一个请求成功之后：记下实际渠道；该学就学；自动钉住的渠道失败后备选成功了，锁就跟过去。 */
  const served = ({ model, plan, attempt, served: who, verdict, pipeline }) => {
    if (who) store.patch(model, { lastServed: who, lastAt: Date.now() })
    if (!settings.autoPin) return
    if (plan.source === 'auto') {
      if (attempt.upstream === null) {
        // 记住的渠道全失败了，最后那次不钉的尝试成功了：记的渠道多半过期了，重新学。
        store.patch(model, { auto: null, autoPipeline: null })
        if (who) void learn(model, who, pipeline)
      } else if (slug(attempt.upstream) !== slug(plan.pin.upstreams[0]) && (verdict === 'adopted' || verdict === 'unknown')) {
        store.patch(model, { auto: attempt.upstream, autoPipeline: null })
        record({ model, event: 'auto-moved', channel: attempt.upstream })
      }
    } else if (plan.learn && who) {
      void learn(model, who, pipeline)
    }
  }

  // ── 注册 ──────────────────────────────────────────────────────────────────

  const adapter = new ClinePinAdapter({
    settings: () => settings,
    apiKey,
    // 只有真的带图片的请求才会懒解析附件服务，纯文本对话不碰它。
    attachments: () => ctx.get('attachments'),
    channels: (model) => ensureChannels(model),
    plan: (model) => planFor({ config: settings.perModel[model], entry: store.entry(model), autoPin: settings.autoPin }),
    modelIds,
    served,
    record,
    log: ctx.logger,
  })
  const registration = ctx.llm.registerAdapter([provider], adapter)

  // 模型清单变了（设置页取到了新清单）：让 dsh 重新读取，模型选择器里才会出现。
  const modelsChanged = () => {
    try {
      registration.replace([provider])
    } catch (error) {
      ctx.logger?.warn('[cline-pin] 通知 dsh 刷新模型清单失败：%s', errorChain(error))
    }
  }

  // 配置目录里的条目让设置界面把这个命名空间当作该路由的配置（行里的绿/红点就是靠它）；
  // 冲突只影响展示，不该拖垮路由本身。
  try {
    ctx.llm.registerConfigurableProviders([{
      provider,
      displayName: settings.displayName,
      settingsNs: ctx.fiber.entry?.options.id ?? 'cline-pin',
      settingsPath: [],
    }])
  } catch (error) {
    ctx.logger?.warn('[cline-pin] 配置目录条目被拒绝（不影响使用）：%s', errorChain(error))
  }

  // 设置页：只有带浏览器界面的 profile（desktop / web）才有 Connection，headless 下这里什么也不做。
  try {
    registerPanel(ctx, createPanel({
      settings,
      store,
      credentials,
      modelIds,
      verifyKey,
      fetchModelIds: () => fetchModelIds({ url: settings.modelsURL }),
      ensureChannels,
      modelsChanged,
    }), ctx.logger)
  } catch (error) {
    ctx.logger?.warn('[cline-pin] 设置页接口注册失败（不影响使用）：%s', errorChain(error))
  }

  const pinned = Object.keys(settings.perModel).length
  ctx.logger?.info(
    '[cline-pin] 已注册路由 "%s"：%d 个模型，%d 个在配置里写了渠道；自动锁定%s%s；请求日志：%s',
    provider, modelIds().length, pinned, settings.autoPin ? '开' : '关', settings.enforce ? '，enforce 已开启' : '', logFile ?? '关闭',
  )
}
