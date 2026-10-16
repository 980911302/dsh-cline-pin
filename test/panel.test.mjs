import assert from 'node:assert/strict'
import test from 'node:test'
import { createPanel, isUsableKey } from '../lib/panel.js'

const settings = { provider: 'cline-pin', displayName: 'Cline Pass (Pin)', perModel: {}, autoPin: true }

function makeStore() {
  let ids = []
  return {
    store: {
      entry: () => ({}),
      modelsFetchedAt: () => 0,
      setModelIds: (next) => { ids = next },
      patch: () => {},
    },
    modelIds: () => ids,
  }
}

test('密钥校验：空值或含空白的值不能直接当 HTTP 头发送', () => {
  assert.equal(isUsableKey(''), false)
  assert.equal(isUsableKey('sk has space'), false)
  assert.equal(isUsableKey('sk-line\nbreak'), false)
  assert.equal(isUsableKey('sk-test-local'), true)
})

test('key.save：网关明确拒绝的密钥不保存、不取模型清单', async () => {
  const { store, modelIds } = makeStore()
  let setCalls = 0
  let fetchCalls = 0
  const credentials = {
    ref: 'CLINE_PASS_API_KEY',
    describe: async () => ({ configured: false, source: '', writable: true }),
    set: async () => { setCalls += 1 },
    unset: async () => {},
  }
  const panel = createPanel({
    settings,
    store,
    credentials,
    modelIds,
    verifyKey: async () => ({ state: 'rejected', detail: 'Unauthorized: invalid api key' }),
    fetchModelIds: async () => { fetchCalls += 1; return [] },
    ensureChannels: async () => null,
    modelsChanged: () => {},
  })

  await assert.rejects(() => panel['key.save']({ value: 'sk-wrong-test' }), /网关拒绝了这个密钥.*没有保存/)
  assert.equal(setCalls, 0, '被拒绝的密钥绝不能写进凭据存储')
  assert.equal(fetchCalls, 0, '密钥没通过前不该取模型清单')
})

test('key.save：有效密钥保存后取模型清单，并返回界面状态', async () => {
  const { store, modelIds } = makeStore()
  let saved = ''
  let changed = 0
  const credentials = {
    ref: 'CLINE_PASS_API_KEY',
    describe: async () => ({ configured: saved !== '', source: saved === '' ? '' : 'file', writable: true }),
    set: async (value) => { saved = value },
    unset: async () => { saved = '' },
  }
  const panel = createPanel({
    settings,
    store,
    credentials,
    modelIds,
    verifyKey: async () => ({ state: 'valid', detail: '' }),
    fetchModelIds: async () => [{ id: 'cline-pass/test-model' }],
    ensureChannels: async () => ({ planner: ['baseten'], direct: ['baseten'] }),
    modelsChanged: () => { changed += 1 },
  })

  const value = await panel['key.save']({ value: 'sk-valid-test' })
  assert.equal(saved, 'sk-valid-test')
  assert.equal(changed, 1)
  assert.equal(value.key.configured, true)
  assert.equal(value.notice.kind, 'ok')
  assert.match(value.notice.text, /密钥有效，已保存/)
  assert.match(value.notice.text, /1 个模型/)
  assert.deepEqual(value.models.map((model) => model.id), ['cline-pass/test-model'])
})
