import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRecorder, formatEntry, levelOf, resolveLogPath, ROTATE_BYTES } from '../lib/log.js'

const when = new Date('2026-10-15T13:50:03.123Z')

test('日志路径：off 关闭；空串用 dsh home；$DSH_HOME 优先；~/ 会展开', () => {
  assert.equal(resolveLogPath('off', {}, '/home/u'), null)
  assert.equal(resolveLogPath(' OFF ', {}, '/home/u'), null)
  assert.equal(resolveLogPath('', {}, '/home/u'), '/home/u/.dsh/logs/cline-pin.log')
  assert.equal(resolveLogPath('', { DSH_HOME: '/data/dsh' }, '/home/u'), '/data/dsh/logs/cline-pin.log')
  assert.equal(resolveLogPath('~/pin.log', {}, '/home/u'), '/home/u/pin.log')
  assert.equal(resolveLogPath('/var/log/pin.log', {}, '/home/u'), '/var/log/pin.log')
})

test('成功的一行：钉的是谁、实际是谁、核对结果', () => {
  const line = formatEntry({ model: 'cline-pass/glm-5.3', want: 'baseten', got: 'Baseten', verdict: 'adopted', ms: 812, failed: [] }, when)
  assert.equal(line, 'ts=2026-10-15T13:50:03.123Z model=cline-pass/glm-5.3 want=baseten got=Baseten verdict=adopted ms=812')
})

test('没钉渠道记为 auto；响应没标明渠道记为 ?；之前失败过的渠道会带上', () => {
  const line = formatEntry({ model: 'm', got: null, verdict: 'unknown', ms: 5, failed: ['baseten', 'alibaba'] }, null)
  assert.equal(line, 'model=m want=auto got=? verdict=unknown ms=5 earlier_failures=baseten,alibaba')
})

test('失败的一行：带错误码、下一个候选；含空格的错误文本会被引号包起来', () => {
  const line = formatEntry({ model: 'm', want: 'baseten', code: 'SERVER', error: 'upstream baseten unavailable', next: 'alibaba' }, null)
  assert.equal(line, 'model=m want=baseten result=failed code=SERVER next=alibaba error="upstream baseten unavailable"')
  assert.match(formatEntry({ model: 'm', want: 'a', code: 'X', error: 'say "hi"' }, null), /next=none error="say \\"hi\\""$/)
})

test('日志级别：失败和钉住没生效是 warn，没钉渠道是 debug，其余 info', () => {
  assert.equal(levelOf({ error: 'x' }), 'warn')
  assert.equal(levelOf({ verdict: 'missed' }), 'warn')
  assert.equal(levelOf({ verdict: 'violated' }), 'warn')
  assert.equal(levelOf({ verdict: 'auto' }), 'debug')
  assert.equal(levelOf({ verdict: 'adopted' }), 'info')
  assert.equal(levelOf({ verdict: 'unknown' }), 'info')
})

test('记录器：同时写 logger 和文件，目录不存在会自动创建', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cline-pin-log-'))
  const file = join(dir, 'nested', 'pin.log')
  const seen = []
  const logger = { info: (...args) => seen.push(['info', ...args]), warn: (...args) => seen.push(['warn', ...args]) }
  const record = createRecorder({ file, logger })
  await record({ model: 'm', want: 'a', got: 'a', verdict: 'adopted', ms: 1 })
  await record({ model: 'm', want: 'a', got: 'b', verdict: 'missed', ms: 2 })
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^ts=\S+ model=m want=a got=a verdict=adopted ms=1$/)
  assert.deepEqual(seen.map(([level]) => level), ['info', 'warn'])
  // logger 的格式串里不能混进日志内容里的 % 号
  assert.equal(seen[0][1], '[cline-pin] %s')
})

test('记录器：文件关闭时只走 logger；写不进去时不抛错，只告警一次', async () => {
  const seen = []
  const logger = { info: () => {}, warn: (...args) => seen.push(args) }
  await createRecorder({ file: null, logger })({ model: 'm', verdict: 'adopted', ms: 1 })
  const dir = await mkdtemp(join(tmpdir(), 'cline-pin-log-'))
  await writeFile(join(dir, 'blocker'), 'x')
  const record = createRecorder({ file: join(dir, 'blocker', 'pin.log'), logger })
  await record({ model: 'm', verdict: 'adopted', ms: 1 })
  await record({ model: 'm', verdict: 'adopted', ms: 2 })
  assert.equal(seen.length, 1)
  assert.match(seen[0][0], /写不进/)
})

test('记录器：旧日志超过上限时，下次启动改名为 .1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cline-pin-log-'))
  const file = join(dir, 'pin.log')
  await writeFile(file, 'x'.repeat(ROTATE_BYTES + 1))
  await createRecorder({ file })({ model: 'm', verdict: 'adopted', ms: 1 })
  assert.equal((await stat(`${file}.1`)).size, ROTATE_BYTES + 1)
  assert.ok((await stat(file)).size < 200)
})
