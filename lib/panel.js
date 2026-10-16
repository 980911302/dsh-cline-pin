/**
 * 设置页的宿主端：浏览器里那张卡片（lib/client.js）的全部读写，都走这一条受认证的 `/api/cline-pin` 路由。
 *
 * 路由挂在 Connection 的 `/api` 前缀下是有意的：只有 Connection 的处理器会做 Host/Origin 校验和浏览器会话
 * 认证；直接挂在裸的 webserver 上，谁能连到端口谁就能调。
 *
 * 密钥只进不出：界面只会知道"配了没有、来自哪里"，永远拿不到值。
 * 不依赖 dsh 的任何包（凭据、网关等都由 index.js 以函数的形式传进来），所以可以脱离宿主单独测试。
 *
 * @module dsh-cline-pin/panel
 */
import { slug } from './pin.js'
import { NO_PIN, planFor, usableChannels } from './state.js'

/** 本包独占的 `/api` 路由。 */
export const PANEL_PATH = '/api/cline-pin'

/** 这条通道上所有失败共用的错误码。 */
export const PANEL_ERROR_CODE = 'cline-pin/panel'

/** 密钥能不能放进 HTTP 头：非空，且不含空白和控制字符。 */
export function isUsableKey(key) {
  return typeof key === 'string' && key.length > 0 && !/[\s\u0000-\u001f\u007f]/.test(key)
}

const shortName = (id) => String(id).replace(/^cline-pass\//, '')
const oneLine = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const sourceLabel = (source) => (source === 'env' ? '启动环境变量' : source === 'file' ? '凭据文件' : source ? String(source) : '外部来源')

/**
 * 创建设置页的接口表：`名字 -> (payload) => Promise<json>`。
 *
 * @param deps.settings       静态配置：provider、displayName、perModel、autoPin。
 * @param deps.store          状态存储（见 state.js）。
 * @param deps.credentials    `{ ref, describe(), set(value), unset() }`，密钥的存取。
 * @param deps.modelIds       `() => string[]`，当前对外展示的模型清单。
 * @param deps.verifyKey      `async (key) => { state: 'valid'|'rejected'|'unverified', detail }`。
 * @param deps.fetchModelIds  `async () => [{ id }]`，官方的模型清单。
 * @param deps.ensureChannels `async (model, { force }) => channels|null`，读取并缓存一个模型的渠道清单。
 * @param deps.modelsChanged  `() => void`，模型清单变了，让 dsh 重新读取。
 */
export function createPanel({ settings, store, credentials, modelIds, verifyKey, fetchModelIds, ensureChannels, modelsChanged }) {
  const probing = { active: false, done: 0, total: 0 }

  /** 一个模型在界面上的样子。 */
  function view(id) {
    const entry = store.entry(id)
    const configured = settings.perModel[id] ?? {}
    const plan = planFor({ config: configured, entry, autoPin: settings.autoPin })
    const primary = plan.source === 'config' ? '' : (plan.pin.upstreams?.[0] ?? '')
    return {
      id,
      name: shortName(id),
      channels: usableChannels(entry.channels),
      // config：配置文件指定；manual：设置页里选的；auto：自动记住的；off：手动选了不锁定；none：还没锁定
      mode: plan.source === 'none' && entry.manual === NO_PIN ? 'off' : plan.source,
      pinned: plan.source === 'config' ? (configured.upstreams ?? []).map(String) : (primary === '' ? [] : [primary]),
      excluded: plan.source === 'config' ? (configured.exclude ?? []).map(String) : [],
      auto: typeof entry.auto === 'string' ? entry.auto : '',
      manual: typeof entry.manual === 'string' ? entry.manual : '',
      lastServed: String(entry.lastServed ?? ''),
      lastAt: Number(entry.lastAt ?? 0),
    }
  }

  async function state() {
    const key = await credentials.describe()
    return {
      provider: settings.provider,
      displayName: settings.displayName,
      key: { ref: credentials.ref, configured: key?.configured === true, source: String(key?.source ?? ''), writable: key?.writable !== false },
      autoPin: settings.autoPin,
      modelsFetchedAt: store.modelsFetchedAt(),
      probing: { ...probing },
      models: modelIds().map(view),
    }
  }

  /** 取官方模型清单并存下来；返回模型个数。 */
  async function refreshModels() {
    const ids = (await fetchModelIds()).map((item) => item.id).filter(Boolean)
    if (ids.length === 0) throw new Error('官方清单是空的')
    store.setModelIds(ids)
    modelsChanged()
    return ids.length
  }

  /**
   * 在后台读各个模型的渠道清单（探测请求在花任何 token 之前就会失败，所以不花钱），
   * 最多 3 个并发；界面轮询 `state` 看进度。已经读过的默认跳过。
   */
  function startProbe({ force = false } = {}) {
    if (probing.active) return
    const todo = modelIds().filter((id) => force || store.entry(id).channels === undefined)
    if (todo.length === 0) return
    Object.assign(probing, { active: true, done: 0, total: todo.length })
    void (async () => {
      let next = 0
      const worker = async () => {
        while (next < todo.length) {
          const model = todo[next++]
          try {
            await ensureChannels(model, { force })
          } catch { /* 这个模型没读到，不影响其它模型 */ }
          probing.done += 1
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, todo.length) }, worker))
      probing.active = false
    })()
  }

  return {
    state,

    /** 验证并保存密钥，然后取模型、在后台读渠道清单。网关明确拒绝（401/403）的密钥不保存。 */
    async 'key.save'(payload) {
      const value = String(payload?.value ?? '').trim()
      if (!isUsableKey(value)) throw new Error('密钥是空的，或者含有空格/换行，请重新复制粘贴')
      const current = await credentials.describe()
      if (current?.writable === false) throw new Error(`当前密钥由${sourceLabel(current.source)}提供，不能在这里修改`)
      const verdict = await verifyKey(value)
      if (verdict.state === 'rejected') throw new Error(`网关拒绝了这个密钥（${oneLine(verdict.detail, 120)}），没有保存`)
      await credentials.set(value)
      let kind = verdict.state === 'valid' ? 'ok' : 'warn'
      const parts = [verdict.state === 'valid' ? '密钥有效，已保存。' : '密钥已保存，但这次没能向网关确认它是否有效（网络问题，或网关没有明确答复）。']
      try {
        parts.push(`已获取 ${await refreshModels()} 个模型。`)
      } catch (error) {
        kind = 'warn'
        parts.push(`模型清单没取到（${oneLine(error?.message, 120)}），先用内置清单。`)
      }
      startProbe()
      return { ...(await state()), notice: { kind, text: parts.join('') } }
    },

    async 'key.clear'() {
      const current = await credentials.describe()
      if (current?.writable === false) throw new Error(`当前密钥由${sourceLabel(current.source)}提供，不能在这里清除`)
      await credentials.unset()
      const after = await credentials.describe()
      const still = after?.configured === true
      const text = still ? `已清除保存的密钥，但仍有一份来自${sourceLabel(after.source)}，请到那里删除。` : '已清除密钥。'
      return { ...(await state()), notice: { kind: still ? 'warn' : 'ok', text } }
    },

    async 'models.refresh'() {
      const count = await refreshModels()
      startProbe()
      return { ...(await state()), notice: { kind: 'ok', text: `已获取 ${count} 个模型。` } }
    },

    async 'models.probe'(payload) {
      startProbe({ force: payload?.force === true })
      return await state()
    },

    /** 手动选渠道：空串 = 回到自动；NO_PIN = 不锁定；其它必须是这个模型两套路由器都认的渠道。 */
    async 'model.pin'(payload) {
      const model = String(payload?.model ?? '')
      if (!modelIds().includes(model)) throw new Error(`没有这个模型：${model}`)
      const channel = String(payload?.channel ?? '')
      if (channel === '') {
        store.patch(model, { manual: null })
      } else if (channel === NO_PIN) {
        store.patch(model, { manual: NO_PIN })
      } else {
        const hit = usableChannels(store.entry(model).channels).find((name) => slug(name) === slug(channel))
        if (hit === undefined) throw new Error(`${channel} 不在 ${shortName(model)} 的可用渠道里（可能还没读到渠道清单）`)
        store.patch(model, { manual: hit })
      }
      return await state()
    },
  }
}

/**
 * 把接口表挂到 Connection 的受认证 `/api` 路由上。每个动作是一个分发入口，浏览器在请求体里点名要哪个：
 * `POST /api/cline-pin  { endpoint, payload }  →  { ok: true, value } | { ok: false, error }`。
 * @returns 注销函数（随插件一起释放）。
 */
export function registerPanel(ctx, panel, logger) {
  const handle = async (endpoint, payload) => {
    const route = Object.hasOwn(panel, endpoint) ? panel[endpoint] : undefined
    if (route === undefined) return { ok: false, error: { code: PANEL_ERROR_CODE, message: `未知的操作 ${JSON.stringify(endpoint)}`, details: {} } }
    try {
      return { ok: true, value: await route(payload ?? {}) }
    } catch (error) {
      return { ok: false, error: { code: PANEL_ERROR_CODE, message: oneLine(error?.message ?? error, 400), details: {} } }
    }
  }
  return ctx.inject(['connection'], (connectionCtx) => {
    const registered = connectionCtx.connection.fetch.register({
      path: PANEL_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return Response.json({ ok: false, error: { code: PANEL_ERROR_CODE, message: '请求体不是 JSON', details: {} } }, { status: 400, headers: { 'cache-control': 'no-store' } })
        }
        return Response.json(await handle(String(body?.endpoint ?? ''), body?.payload), { headers: { 'cache-control': 'no-store' } })
      },
    })
    logger?.info('[cline-pin] 设置页接口 %s 已就绪', PANEL_PATH)
    return registered
  })
}
