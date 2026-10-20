import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_MODELS, KNOWN_WINDOWS, modalitiesFor } from '../lib/models.js'
import {
  collectImageRefs,
  contentHasImage,
  prepareRequestImages,
  projectImageDimensions,
  requestImageTarget,
} from '../lib/image.js'

test('图片尺寸：只缩小，不放大，且不超过像素预算', () => {
  assert.deepEqual(projectImageDimensions(100, 50, 1_000_000), { width: 100, height: 50 })
  const small = projectImageDimensions(4000, 2000, 1_000_000)
  assert.ok(small.width * small.height <= 1_000_000)
  assert.ok(small.width <= 4000 && small.height <= 2000)
})

test('图片引用：能识别直接图片和 tool-result 里的图片', () => {
  const ref = { attachmentId: 'a1', width: 10, height: 10, mediaType: 'image/png' }
  const blocks = [
    { type: 'text', text: 'hi' },
    { type: 'image', attachment: ref },
    { type: 'tool-result', content: [{ type: 'image', attachment: { attachmentId: 'a2', width: 5, height: 5, mediaType: 'image/png' } }] },
  ]
  assert.equal(contentHasImage(blocks), true)
  assert.equal(collectImageRefs(blocks).size, 2)
  assert.equal(requestImageTarget(ref).width, 10)
})

test('prepareRequestImages：把附件服务返回的字节转成 base64/媒体类型', async () => {
  const ref = { attachmentId: 'a1', width: 10, height: 10, mediaType: 'image/png' }
  const attachments = {
    async readImageRequest(seen, target) {
      assert.equal(seen.attachmentId, 'a1')
      assert.equal(target.width, 10)
      assert.equal(target.height, 10)
      return { data: Uint8Array.from([1, 2, 3]), mediaType: 'image/png' }
    },
  }
  const images = await prepareRequestImages([{ role: 'user', content: [{ type: 'image', attachment: ref }] }], attachments, undefined)
  assert.deepEqual(images.get('a1'), { mediaType: 'image/png', base64: 'AQID' })
})

test('prepareRequestImages：没有附件服务时明确报错，不把图片静默丢掉', async () => {
  const ref = { attachmentId: 'a1', width: 10, height: 10, mediaType: 'image/png' }
  await assert.rejects(
    () => prepareRequestImages([{ role: 'user', content: [{ type: 'image', attachment: ref }] }], undefined, undefined),
    /附件服务/,
  )
})

// 1017 是网关发布的新 ID，不能退回未知模型的纯文本能力。
test('DeepSeek V4.1 Flash 1017 可选择并支持图片，保留 1M 上下文', () => {
  const id = 'cline-pass/deepseek-v4.1-flash-1017'
  assert.ok(DEFAULT_MODELS.includes(id))
  assert.deepEqual(modalitiesFor(id), ['text', 'image'])
  assert.equal(KNOWN_WINDOWS[id], 1_000_000)
  assert.deepEqual(modalitiesFor('cline-pass/unknown-model'), ['text'])
})
