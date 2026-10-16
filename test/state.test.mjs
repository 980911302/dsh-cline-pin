import assert from 'node:assert/strict'
import test from 'node:test'
import { planFor, resolveLearnedChannel } from '../lib/state.js'

test('渠道清单可用：按清单解析，两份路由都写', () => {
  const channels = { planner: ['zai'], direct: ['z-ai'] }
  assert.deepEqual(resolveLearnedChannel('Z.AI', channels, 'direct'), { channel: 'zai', pipeline: null })
  assert.deepEqual(resolveLearnedChannel('DeepSeek', { planner: ['deepseek'], direct: null }, 'planner'), { channel: 'deepseek', pipeline: null })
})

test('渠道清单不可用：按实际路由器的拼法兜底学习，只写单条路由', () => {
  assert.deepEqual(resolveLearnedChannel('DeepSeek', undefined, 'direct'), { channel: 'deepseek', pipeline: 'direct' })
  assert.deepEqual(resolveLearnedChannel('Z.AI', undefined, 'direct'), { channel: 'z-ai', pipeline: 'direct' })
  assert.deepEqual(resolveLearnedChannel('Z.AI', undefined, 'planner'), { channel: 'zai', pipeline: 'planner' })
  assert.equal(resolveLearnedChannel('DeepSeek', undefined, undefined), null)
})

test('自动钉住：记住的渠道会带上兜底学到的路由', () => {
  const plan = planFor({ config: {}, entry: { auto: 'deepseek', autoPipeline: 'direct' }, autoPin: true })
  assert.equal(plan.source, 'auto')
  assert.equal(plan.pipeline, 'direct')
  assert.deepEqual(plan.pin.upstreams, ['deepseek'])

  const fromList = planFor({ config: {}, entry: { auto: 'deepseek', channels: { planner: ['deepseek'], direct: ['deepseek'] } }, autoPin: true })
  assert.equal(fromList.pipeline, null)
})
