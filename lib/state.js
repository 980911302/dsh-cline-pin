/**
 * 插件自己的持久状态（不含任何密钥）：取到的模型清单、各模型的渠道清单、自动记住/手动选定的渠道、
 * 最近一次实际渠道。存成 <dsh home>/cline-pin/state.json（权限 600）。
 *
 * 写入同步且原子（先写临时文件再改名）；读到坏文件就当没有；写失败只是不持久化，不影响使用。
 * 不依赖 dsh 的任何包。
 *
 * @module dsh-cline-pin/state
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeSort, slug, spell } from './pin.js'

/** 手动选择"不锁定"时存的值。 */
export const NO_PIN = '__none__'

/** 状态文件放哪：$DSH_HOME 优先，没设就是 ~/.dsh/cline-pin/state.json。 */
export function resolveStatePath(env = process.env, home = homedir()) {
  return join(env.DSH_HOME || join(home, '.dsh'), 'cline-pin', 'state.json')
}

const knownLists = (channels) => ['planner', 'direct'].map((pipeline) => channels?.[pipeline]).filter((list) => Array.isArray(list) && list.length > 0)

/**
 * 两套路由器都认的渠道：按各自已知的清单取交集（只知道一边就用那一边），次序跟第一个已知清单。
 * 只有两边都认的渠道才敢钉：OpenRouter 对不认识的渠道名是直接拒绝，而不是忽略。
 */
export function usableChannels(channels) {
  const [first, ...rest] = knownLists(channels)
  if (first === undefined) return []
  return first.filter((name) => rest.every((list) => list.some((other) => slug(other) === slug(name))))
}

/** 把网关报告的实际渠道（可能是显示名，如 "Z.AI"）解析成可以钉的写法；解析不了就是 null。 */
export function resolveChannel(name, channels) {
  const key = slug(name)
  return key === '' ? null : (usableChannels(channels).find((candidate) => slug(candidate) === key) ?? null)
}

/**
 * 请求成功后学习实际渠道。
 * - 有渠道清单：正常解析，两份路由都写。
 * - 没有渠道清单，但响应说明它来自哪条路由器：按那条路由器的拼法直接记住，并只在那条路由上写约束。
 *   这是探测不可用时的兜底，不冒充另一条路由器也认识这个渠道。
 * @returns {{ channel: string, pipeline: 'planner'|'direct'|null }|null}
 */
export function resolveLearnedChannel(served, channels, pipeline) {
  const resolved = resolveChannel(served, channels)
  if (resolved !== null) return { channel: resolved, pipeline: null }
  if (pipeline !== 'planner' && pipeline !== 'direct') return null
  const name = spell(slug(served), pipeline)
  return /^[a-z0-9][a-z0-9-]*$/.test(name) ? { channel: name, pipeline } : null
}

/** 备选渠道：除了主渠道，按次序最多再取 limit 个。 */
export function fallbackChannels(primary, channels, limit = 2) {
  return usableChannels(channels).filter((name) => slug(name) !== slug(primary)).slice(0, limit)
}

const named = (list) => (Array.isArray(list) ? list : []).some((item) => String(item).trim() !== '')

/**
 * 一个模型这次请求该用什么钉住。优先级：配置文件里写的 > 设置页里手动选的 > 自动记住的 > 不钉（并在响应后学习）。
 *
 * - config：配置文件（perModel）里写了渠道/排除/排序，原样使用，不学习。
 * - manual：设置页里选了某个渠道，钉它，后面带几个备选渠道。
 * - auto：之前记住的渠道，钉它加备选；`bypass` 表示最后再加一次不钉的尝试——自动钉住是便利，不是承诺，
 *   记住的渠道下线了也不该让请求失败。
 * - none：不钉。`learn` 表示响应回来后要记住是哪个渠道服务的。
 *
 * @returns {{ source: 'config'|'manual'|'auto'|'none', pin: object, bypass: boolean, learn: boolean }}
 */
export function planFor({ config, entry, autoPin = true }) {
  const explicit = config ?? {}
  if (named(explicit.upstreams) || named(explicit.exclude) || normalizeSort(explicit.sort) !== null) {
    return { source: 'config', pin: explicit, bypass: false, learn: false }
  }
  const chain = (primary) => ({ upstreams: [primary, ...fallbackChannels(primary, entry?.channels)], pinMode: 'strict' })
  if (entry?.manual === NO_PIN) return { source: 'none', pin: {}, bypass: false, learn: false }
  if (typeof entry?.manual === 'string' && entry.manual !== '') return { source: 'manual', pin: chain(entry.manual), bypass: false, learn: false }
  if (autoPin && typeof entry?.auto === 'string' && entry.auto !== '') {
    const pipeline = entry.autoPipeline === 'planner' || entry.autoPipeline === 'direct' ? entry.autoPipeline : null
    return { source: 'auto', pin: chain(entry.auto), bypass: true, learn: false, pipeline }
  }
  return { source: 'none', pin: {}, bypass: false, learn: autoPin }
}

const blank = () => ({ version: 1, models: { ids: [], fetchedAt: 0 }, perModel: {} })

function load(file) {
  if (file === null) return blank()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed?.version !== 1 || typeof parsed.perModel !== 'object' || parsed.perModel === null) return blank()
    return {
      version: 1,
      models: { ids: Array.isArray(parsed.models?.ids) ? parsed.models.ids.map(String) : [], fetchedAt: Number(parsed.models?.fetchedAt) || 0 },
      perModel: parsed.perModel,
    }
  } catch {
    return blank()
  }
}

/**
 * 打开（或创建）状态存储。`file` 为 null 时只在内存里。
 * @param {{ file: string|null, now?: () => number }} options
 */
export function createStore({ file, now = Date.now }) {
  const data = load(file)
  let failure
  const save = () => {
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, file)
      chmodSync(file, 0o600)
    } catch (error) {
      failure = error
    }
  }
  return {
    /** 取到过的模型清单（没取过就是空）。 */
    modelIds: () => [...data.models.ids],
    modelsFetchedAt: () => data.models.fetchedAt,
    setModelIds(ids) {
      data.models = { ids: [...new Set(ids.map(String))], fetchedAt: now() }
      save()
    },
    /** 一个模型的记录（拷贝）：channels、channelsAt、auto、manual、lastServed、lastAt。 */
    entry: (model) => ({ ...(data.perModel[model] ?? {}) }),
    /** 合并字段；值为 null/undefined 的字段会被删掉。 */
    patch(model, fields) {
      const next = { ...(data.perModel[model] ?? {}), ...fields }
      for (const key of Object.keys(next)) if (next[key] === null || next[key] === undefined) delete next[key]
      data.perModel[model] = next
      save()
    },
    /** 最近一次写盘失败的原因（没有失败过就是 undefined）。 */
    failure: () => failure,
  }
}
