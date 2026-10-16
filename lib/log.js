/**
 * 请求日志：每个请求一行 logfmt，写明钉的是谁、实际是谁、核对结果。
 *
 * 为什么要自己写文件：dsh 的 logger 默认只放行 error 和 info，headless 下根本没有挂控制台输出，
 * 桌面版也没有现成的日志文件。想确认"钉住到底生不生效"，得有个看得见的地方。
 * 日志里只有模型名、渠道名、耗时，没有任何对话内容和密钥。
 *
 * 不依赖 dsh 的任何包，可以单独测试。
 *
 * @module dsh-cline-pin/log
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_LOG_NAME = 'cline-pin.log'

/** 超过这个大小，下次启动时把旧日志改名为 .1（只留一份），避免无限增长。 */
export const ROTATE_BYTES = 2 * 1024 * 1024

/**
 * 日志文件放哪。
 * - `off`：不写文件
 * - 空串：`<dsh home>/logs/cline-pin.log`（dsh home 是 $DSH_HOME，没设就是 ~/.dsh）
 * - `~/` 开头：展开成用户目录
 * @returns {string|null} null 表示关闭。
 */
export function resolveLogPath(setting, env = process.env, home = homedir()) {
  const value = String(setting ?? '').trim()
  if (value.toLowerCase() === 'off') return null
  if (value === '') return join(env.DSH_HOME || join(home, '.dsh'), 'logs', DEFAULT_LOG_NAME)
  return value.startsWith('~/') ? join(home, value.slice(2)) : value
}

const quote = (value) => (value !== '' && /^[\w.:/@+,()?-]*$/.test(value) ? value : JSON.stringify(value))

/**
 * 把一条记录格式化成一行 logfmt。
 *
 * 成功：`model want pin got verdict ms`；失败（带 `error`）：`model want pin result=failed code next error`；
 * 事件（带 `event`，如自动锁定了某个渠道）：`model event channel`。
 * `want` 为空表示没钉渠道（自动路由）；`pin` 是这次钉住的来源：config / manual / auto / none。
 * @param {object} entry
 * @param {Date|null} [now] 时间戳；传 null 则不写（交给 logger 自己带时间）。
 */
export function formatEntry(entry, now = new Date()) {
  const fields = now === null ? [] : [['ts', now.toISOString()]]
  fields.push(['model', entry.model])
  if (entry.event !== undefined) {
    fields.push(['event', entry.event], ['channel', entry.channel ?? '?'])
    return fields.map(([key, value]) => `${key}=${quote(String(value))}`).join(' ')
  }
  fields.push(['want', entry.want ?? 'auto'])
  if (entry.pin !== undefined) fields.push(['pin', entry.pin])
  if (entry.error === undefined) {
    fields.push(['got', entry.got ?? '?'], ['verdict', entry.verdict], ['ms', entry.ms])
  } else {
    fields.push(['result', 'failed'], ['code', entry.code ?? '?'], ['next', entry.next ?? 'none'], ['error', entry.error])
  }
  if (entry.failed?.length > 0) fields.push(['earlier_failures', entry.failed.join(',')])
  return fields.map(([key, value]) => `${key}=${quote(String(value))}`).join(' ')
}

/** 这条记录该用哪个日志级别：失败和钉住没生效算 warn，没钉渠道的日常请求算 debug。 */
export function levelOf(entry) {
  if (entry.error !== undefined || entry.verdict === 'missed' || entry.verdict === 'violated') return 'warn'
  return entry.verdict === 'auto' ? 'debug' : 'info'
}

/**
 * 创建记录器。`record(entry)` 返回 Promise 但调用方不必等待；写文件失败只告警一次，绝不影响请求。
 * @param {{ file: string|null, logger?: any }} options
 */
export function createRecorder({ file, logger }) {
  let ready
  let warned = false
  const prepare = async () => {
    await mkdir(dirname(file), { recursive: true })
    try {
      if ((await stat(file)).size > ROTATE_BYTES) await rename(file, `${file}.1`)
    } catch { /* 文件还不存在，不用轮转 */ }
  }
  return async function record(entry) {
    logger?.[levelOf(entry)]?.('[cline-pin] %s', formatEntry(entry, null))
    if (file === null) return
    try {
      ready ??= prepare()
      await ready
      await appendFile(file, `${formatEntry(entry)}\n`, { mode: 0o600 })
    } catch (error) {
      if (warned) return
      warned = true
      logger?.warn?.('[cline-pin] 请求日志写不进 %s（%s），之后不再提示', file, error?.message)
    }
  }
}
