/**
 * dsh-cline-pin —— 浏览器端。
 *
 * 在"设置 → 模型"页的 Cline Pass (Pin) 卡片里：粘贴密钥 → 保存并获取模型 → 看每个模型锁定在哪个渠道，
 * 不满意可以手动换。所有读写都发给宿主端的 `/api/cline-pin`（见 lib/panel.js）。
 *
 * 手写的 dsh 客户端包，没有构建步骤：模块系统用 `window.__ModuleLoader__.load` 加载它，返回的 exports 就是一个
 * 普通的 Cordis 插件（apply + inject）。`require` 只够得着宿主预置的模块表（react 等）。
 * 卡片挂在 `settings.models.provider-card` 这个按 provider 设置命名空间（`cline-pin`）分发的插槽里。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cline-pin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 本包的设置命名空间，也是插槽的 key。 */
    const NS = 'cline-pin'
    /** 宿主端发布的、受认证的接口路由。 */
    const PANEL_PATH = '/api/cline-pin'
    /** 与 lib/state.js 约定的"不锁定"取值。 */
    const NO_PIN = '__none__'
    /** 配置文件指定了渠道时，下拉框里那个只读的取值。 */
    const FROM_CONFIG = '__config__'

    //#region 文案

    /**
     * 界面语言跟着 App 走（App 会把 <html lang> 设成当前语言）。必须在渲染时现读：本包加载得比 App
     * 设置语言更早，那时 <html lang> 还是默认的 en。
     */
    const isZh = () => /^zh/i.test(String((typeof document !== 'undefined' && document.documentElement.lang) || (typeof navigator !== 'undefined' && navigator.language) || ''))
    const TEXT = {
      zh: {
        loading: '加载中…',
        loadFailed: '读不到设置（{error}）。请确认 dsh 已加载 cline-pin 插件并重启过。',
        intro: '密钥只保存在本机的 dsh 凭据里。保存后会自动取模型；每个模型第一次用过之后，会自动锁定它的上游渠道。',
        keyPlaceholder: '粘贴 Cline Pass 的 API 密钥',
        saveFetch: '保存并获取模型',
        working: '处理中…',
        cancel: '取消',
        keyOk: '已配置密钥',
        keySource: '（来源：{source}）',
        envLocked: '密钥由{source}提供，不能在这里修改。',
        replace: '更换密钥',
        clear: '清除密钥',
        refresh: '重新获取模型',
        fetchedAt: '模型清单更新于 {time}',
        builtIn: '正在使用内置的模型清单',
        probing: '正在读取各模型的渠道清单… {done}/{total}',
        colModel: '模型',
        colPin: '锁定的渠道',
        colServed: '最近一次实际渠道',
        optAuto: '自动（首次使用后自动锁定）',
        optNoAuto: '默认（不锁定，让网关自己选）',
        optAutoOn: '自动（当前锁定：{channel}）',
        optOff: '不锁定（让网关自己选）',
        fromConfig: '配置文件指定：{channels}',
        notUsed: '还没用过',
        sourceEnv: '启动环境变量',
        sourceFile: '凭据文件',
      },
      en: {
        loading: 'Loading…',
        loadFailed: 'Cannot read the settings ({error}). Make sure dsh loaded the cline-pin plugin and was restarted.',
        intro: 'The key stays in your local dsh credentials. Models are fetched automatically, and each model\'s upstream channel is locked after its first use.',
        keyPlaceholder: 'Paste your Cline Pass API key',
        saveFetch: 'Save & fetch models',
        working: 'Working…',
        cancel: 'Cancel',
        keyOk: 'API key configured',
        keySource: ' (from {source})',
        envLocked: 'The key comes from the {source} and cannot be changed here.',
        replace: 'Replace key',
        clear: 'Remove key',
        refresh: 'Refresh models',
        fetchedAt: 'Model list updated {time}',
        builtIn: 'Using the built-in model list',
        probing: 'Reading channel lists… {done}/{total}',
        colModel: 'Model',
        colPin: 'Pinned channel',
        colServed: 'Last served by',
        optAuto: 'Auto (locks after first use)',
        optNoAuto: 'Default (no pin, gateway chooses)',
        optAutoOn: 'Auto (locked: {channel})',
        optOff: 'Off (let the gateway choose)',
        fromConfig: 'Set in cordis.patch.yml: {channels}',
        notUsed: 'not used yet',
        sourceEnv: 'launch environment',
        sourceFile: 'credentials file',
      },
    }
    const t = (key, vars) => {
      const text = (isZh() ? TEXT.zh : TEXT.en)[key] ?? key
      return vars === undefined ? text : text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
    }
    const sourceName = (source) => (source === 'env' ? t('sourceEnv') : source === 'file' ? t('sourceFile') : String(source || ''))

    //#endregion

    //#region 样式（用宿主的主题变量，跟着浅色/深色走）

    const CSS = [
      '.cpin{display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary);margin-top:8px}',
      '.cpin-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.cpin-grow{flex:1;min-width:160px}',
      '.cpin-muted{color:var(--dsw-alias-label-tertiary)}',
      '.cpin-intro{margin:0;font-size:12px;line-height:18px}',
      '.cpin-input,.cpin-select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;font-size:13px;min-width:0;max-width:100%}',
      '.cpin-input:focus-visible,.cpin-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cpin-select:disabled{opacity:.6}',
      '.cpin-btn{border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer}',
      '.cpin-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.cpin-btn:disabled{opacity:.5;cursor:default}',
      '.cpin-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}',
      '.cpin-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;background:var(--dsw-alias-state-success-primary)}',
      '.cpin-msg{border-radius:6px;padding:6px 8px;font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-word}',
      '.cpin-msg-ok{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base)}',
      '.cpin-msg-warn{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base)}',
      '.cpin-msg-err{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}',
      '.cpin-table{display:grid;grid-template-columns:minmax(80px,1fr) minmax(150px,1.7fr) minmax(70px,1fr);gap:0 10px;align-items:center}',
      '.cpin-th{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:0 0 6px;border-bottom:0.5px solid var(--dsw-alias-border-l3)}',
      '.cpin-td{padding:6px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2);min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px}',
      '.cpin-name{font-weight:600;white-space:nowrap}',
      '.cpin-select{width:100%;font-size:12px;padding:4px 6px}',
      '.cpin-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px}',
    ].join('\n')
    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.setAttribute('data-cline-pin', '')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    //#endregion

    //#region 与宿主端通信

    /** 一次接口调用：同源的 fetch，会话 cookie 自动带上；宿主把每个动作都答成 { ok, value?, error? }。 */
    async function call(endpoint, payload) {
      let response
      try {
        response = await fetch(PANEL_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, payload: payload ?? {} }),
        })
      } catch (error) {
        throw new Error(String(error?.message ?? error))
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json().catch(() => null)
      if (result?.ok === true) return result.value
      throw new Error(result?.error?.message ?? '请求被拒绝')
    }

    //#endregion

    //#region 卡片

    function Message(props) {
      return props.message === null ? null : h('div', { className: `cpin-msg cpin-msg-${props.message.kind}`, role: props.message.kind === 'err' ? 'alert' : 'status' }, props.message.text)
    }

    /** 一个模型的"锁定的渠道"下拉框。 */
    function PinSelect(props) {
      const model = props.model
      const fromConfig = model.mode === 'config'
      const value = fromConfig ? FROM_CONFIG : model.manual
      const options = fromConfig
        ? [[FROM_CONFIG, t('fromConfig', { channels: model.pinned.concat(model.excluded.map((name) => `-${name}`)).join(' → ') })]]
        : [
          ['', !props.autoPin ? t('optNoAuto') : model.auto !== '' ? t('optAutoOn', { channel: model.auto }) : t('optAuto')],
          [NO_PIN, t('optOff')],
          ...model.channels.map((name) => [name, name]),
        ]
      // 手动选过、但之后渠道清单里没有它了：也留在选项里，别让下拉框悄悄显示成别的值。
      if (!fromConfig && value !== '' && value !== NO_PIN && !model.channels.includes(value)) options.push([value, value])
      return h('select', {
        className: 'cpin-select',
        value,
        disabled: props.busy || fromConfig,
        'aria-label': model.id,
        onChange: (event) => props.onPick(model.id, event.target.value),
      }, options.map(([optionValue, label]) => h('option', { key: optionValue, value: optionValue }, label)))
    }

    function Card() {
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [replacing, setReplacing] = React.useState(false)

      const accept = (value) => {
        if (value === null || typeof value !== 'object' || value.provider === undefined) return
        setData(value)
        if (value.notice !== undefined) setMessage(value.notice)
      }
      /** 执行一个动作：忙碌状态、结果提示、失败信息都在这里统一处理。 */
      const act = async (endpoint, payload) => {
        setBusy(true)
        setMessage(null)
        try {
          accept(await call(endpoint, payload))
          return true
        } catch (error) {
          setMessage({ kind: 'err', text: String(error?.message ?? error) })
          return false
        } finally {
          setBusy(false)
        }
      }

      React.useEffect(() => {
        let alive = true
        call('state', {}).then((value) => { if (alive) accept(value) }).catch((error) => {
          if (alive) setMessage({ kind: 'err', text: t('loadFailed', { error: String(error?.message ?? error) }) })
        })
        return () => { alive = false }
      }, [])

      // 后台在读渠道清单时，隔一会儿刷新一次进度。
      const probing = data?.probing?.active === true
      React.useEffect(() => {
        if (!probing) return undefined
        const timer = setInterval(() => { call('state', {}).then(accept).catch(() => {}) }, 1200)
        return () => clearInterval(timer)
      }, [probing])

      if (data === null) {
        return h('div', { className: 'cpin' }, message === null ? h('span', { className: 'cpin-muted' }, t('loading')) : h(Message, { message }))
      }

      const keyOn = data.key.configured === true
      const locked = keyOn && data.key.writable === false
      const save = () => {
        const value = draft.trim()
        if (value === '' || busy) return
        void act('key.save', { value }).then((ok) => { if (ok) { setDraft(''); setReplacing(false) } })
      }

      const keyForm = h('div', { className: 'cpin-row' }, [
        h('input', {
          key: 'input',
          type: 'password',
          className: 'cpin-input cpin-grow',
          placeholder: t('keyPlaceholder'),
          value: draft,
          autoComplete: 'new-password',
          spellCheck: false,
          disabled: busy,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); save() } },
        }),
        h('button', { key: 'save', type: 'button', className: 'cpin-btn cpin-btn-primary', disabled: busy || draft.trim() === '', onClick: save }, busy ? t('working') : t('saveFetch')),
        replacing ? h('button', { key: 'cancel', type: 'button', className: 'cpin-btn', disabled: busy, onClick: () => { setReplacing(false); setDraft('') } }, t('cancel')) : null,
      ])

      const keyStatus = h('div', { className: 'cpin-row' }, [
        h('span', { key: 'dot', className: 'cpin-dot', role: 'img', 'aria-label': t('keyOk') }),
        h('span', { key: 'text', className: 'cpin-grow' }, t('keyOk') + (data.key.source === '' ? '' : t('keySource', { source: sourceName(data.key.source) }))),
        locked ? null : h('button', { key: 'replace', type: 'button', className: 'cpin-btn', disabled: busy, onClick: () => setReplacing(true) }, t('replace')),
        locked ? null : h('button', { key: 'clear', type: 'button', className: 'cpin-btn', disabled: busy, onClick: () => { void act('key.clear', {}) } }, t('clear')),
      ])

      const table = !keyOn ? null : h('div', { key: 'models', className: 'cpin-table', role: 'table' }, [
        h('div', { key: 'h1', className: 'cpin-th', role: 'columnheader' }, t('colModel')),
        h('div', { key: 'h2', className: 'cpin-th', role: 'columnheader' }, t('colPin')),
        h('div', { key: 'h3', className: 'cpin-th', role: 'columnheader' }, t('colServed')),
        ...data.models.flatMap((model) => [
          h('div', { key: `${model.id}:n`, className: 'cpin-td cpin-name', title: model.id }, model.name),
          h('div', { key: `${model.id}:p`, className: 'cpin-td' }, h(PinSelect, { model, busy, autoPin: data.autoPin, onPick: (id, channel) => { void act('model.pin', { model: id, channel }) } })),
          h('div', { key: `${model.id}:s`, className: `cpin-td${model.lastServed === '' ? ' cpin-muted' : ''}` }, model.lastServed === '' ? t('notUsed') : model.lastServed),
        ]),
      ])

      const footer = !keyOn ? null : h('div', { key: 'foot', className: 'cpin-foot' }, [
        h('button', { key: 'refresh', type: 'button', className: 'cpin-btn', disabled: busy, onClick: () => { void act('models.refresh', {}) } }, t('refresh')),
        h('span', { key: 'when', className: 'cpin-muted' }, data.modelsFetchedAt > 0 ? t('fetchedAt', { time: new Date(data.modelsFetchedAt).toLocaleString() }) : t('builtIn')),
        probing ? h('span', { key: 'probing', className: 'cpin-muted' }, t('probing', { done: data.probing.done, total: data.probing.total })) : null,
      ])

      return h('div', { className: 'cpin' }, [
        keyOn && !replacing ? React.createElement(React.Fragment, { key: 'status' }, keyStatus) : React.createElement(React.Fragment, { key: 'form' }, keyForm),
        locked ? h('p', { key: 'locked', className: 'cpin-muted cpin-intro' }, t('envLocked', { source: sourceName(data.key.source) })) : null,
        keyOn ? null : h('p', { key: 'intro', className: 'cpin-muted cpin-intro' }, t('intro')),
        h(Message, { key: 'message', message }),
        table,
        footer,
      ])
    }

    //#endregion

    //#region 插件

    /** 插槽注册表和宿主的 RPC 通道（后者只用来保证 Connection 先于本包就绪）。 */
    const inject = ['slots', 'connection']

    function apply(ctx) {
      // 按 provider 的设置命名空间分发：只会出现在 Cline Pass (Pin) 自己那一行里。
      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card',
        key: NS,
        inject: () => ({}),
      }, Card))
    }

    //#endregion

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
