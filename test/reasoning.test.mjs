import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDeepSeekEffort, reasoningEffortsFor, reasoningFor } from '../lib/models.js'
import { toBody } from '../lib/wire.js'

const MODEL = 'cline-pass/deepseek-v4.1-flash-1017'
const bodyFor = (effort, model = MODEL) => toBody({ model, messages: [], reasoningEffort: effort })

test('1017 声明 Off / Low / High / Max，未知模型不默认启用推理', () => {
  assert.equal(reasoningFor(MODEL), true)
  assert.deepEqual(reasoningEffortsFor(MODEL).map(({ id }) => id), ['off', 'low', 'high', 'max'])
  assert.equal(reasoningFor('cline-pass/unknown-model'), false)
})

test('Off 明确发送关闭参数，不能靠省略参数关闭默认开启的思考', () => {
  for (const effort of ['off', 'none']) {
    const body = bodyFor(effort)
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.equal(body.reasoning_effort, 'none')
  }
})

test('Low / High / Max 明确开启思考且保留所选强度', () => {
  for (const effort of ['low', 'high', 'max']) {
    const body = bodyFor(effort)
    assert.deepEqual(body.thinking, { type: 'enabled' })
    assert.equal(body.reasoning_effort, effort)
  }
})

test('兼容已有等级配置：Medium / XHigh 映射 High，Ultra 映射 Max', () => {
  for (const [requested, actual] of [['minimal', 'low'], ['medium', 'high'], ['xhigh', 'high'], ['ultra', 'max']]) {
    assert.equal(normalizeDeepSeekEffort(requested), actual)
    assert.equal(bodyFor(requested).reasoning_effort, actual)
  }
})

test('未指定强度时保留上游默认值，DeepSeek 参数不泄漏给其它模型', () => {
  const unset = bodyFor(undefined)
  assert.equal(Object.hasOwn(unset, 'reasoning_effort'), false)
  assert.equal(Object.hasOwn(unset, 'thinking'), false)
  const other = bodyFor('high', 'cline-pass/glm-5.3')
  assert.equal(other.reasoning_effort, 'high')
  assert.equal(Object.hasOwn(other, 'thinking'), false)
})
