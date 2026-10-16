/**
 * 图片附件处理：dsh 只把附件引用交给适配器，不直接给字节。这里负责按 dsh 的
 * attachment 服务接口把引用换成一次性请求版本，并算好尺寸/字节预算。
 *
 * 思路参考 yhshzh/dsh-cline-pass（MIT）。
 *
 * @module dsh-cline-pin/image
 */

/** 和 dsh 自带适配器一致的图片预算。 */
export const DEFAULT_REQUEST_IMAGE_POLICY = { maxPixels: 4_194_304, maxBytes: 1_048_576 }

/**
 * 在总像素预算内按比例缩小图片；不放大。
 * @returns {{ width: number, height: number }}
 */
export function projectImageDimensions(width, height, maxPixels) {
  const safeWidth = Number.isSafeInteger(width) && width > 0 ? width : 1
  const safeHeight = Number.isSafeInteger(height) && height > 0 ? height : 1
  const safeBudget = Number.isSafeInteger(maxPixels) && maxPixels > 0 ? maxPixels : DEFAULT_REQUEST_IMAGE_POLICY.maxPixels
  const scale = Math.min(1, Math.sqrt(safeBudget / (safeWidth * safeHeight)))
  if (scale === 1) return { width: safeWidth, height: safeHeight }
  if (safeWidth >= safeHeight) {
    let projectedWidth = Math.max(1, Math.floor(safeWidth * scale))
    let projectedHeight = Math.max(1, Math.round((projectedWidth * safeHeight) / safeWidth))
    while (projectedWidth * projectedHeight > safeBudget && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round((projectedWidth * safeHeight) / safeWidth))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(safeHeight * scale))
  let projectedWidth = Math.max(1, Math.round((projectedHeight * safeWidth) / safeHeight))
  while (projectedWidth * projectedHeight > safeBudget && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round((projectedHeight * safeWidth) / safeHeight))
  }
  return { width: projectedWidth, height: projectedHeight }
}

/** 构造 attachment.readImageRequest 需要的目标。 */
export function requestImageTarget(ref, policy = DEFAULT_REQUEST_IMAGE_POLICY) {
  const maxPixels = policy?.maxPixels ?? DEFAULT_REQUEST_IMAGE_POLICY.maxPixels
  const maxBytes = policy?.maxBytes ?? DEFAULT_REQUEST_IMAGE_POLICY.maxBytes
  const width = ref?.width
  const height = ref?.height
  if (Number.isSafeInteger(width) !== true || width <= 0 || Number.isSafeInteger(height) !== true || height <= 0) {
    const error = new Error('cline-pin: 图片引用缺少可用尺寸，无法读取图片')
    error.code = 'UNSUPPORTED_CONTENT'
    throw error
  }
  const projected = projectImageDimensions(width, height, maxPixels)
  return { width: projected.width, height: projected.height, maxPixels, maxBytes }
}

/** 递归找出所有图片引用（包括 tool-result 里的图）。 */
export function collectImageRefs(blocks, refs = new Map()) {
  for (const block of blocks ?? []) {
    if (block && block.type === 'image' && block.attachment && typeof block.attachment.attachmentId === 'string' && block.attachment.attachmentId.length > 0) refs.set(block.attachment.attachmentId, block.attachment)
    else if (block && block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
  return refs
}

/** 递归判断内容里有没有图片。 */
export function contentHasImage(blocks) {
  for (const block of blocks ?? []) {
    if (block && block.type === 'image') return true
    if (block && block.type === 'tool-result' && contentHasImage(block.content)) return true
  }
  return false
}

const toBase64 = (bytes) => Buffer.from(bytes).toString('base64')

/**
 * 一次请求里把所有图片引用读成内联数据 URI 需要的格式。
 * @returns {Promise<Map<string, { mediaType: string, base64: string }>>}
 */
export async function prepareRequestImages(messages, attachments, signal, policy = DEFAULT_REQUEST_IMAGE_POLICY) {
  const refs = new Map()
  for (const message of messages ?? []) collectImageRefs(message.content ?? [], refs)
  if (refs.size === 0) return new Map()
  if (attachments === undefined || attachments === null) {
    const error = new Error('cline-pin: 当前 dsh 环境没有附件服务，无法发送图片')
    error.code = 'UNSUPPORTED_CONTENT'
    throw error
  }
  const versions = new Map()
  for (const ref of refs.values()) {
    const version = await attachments.readImageRequest(ref, requestImageTarget(ref, policy), signal)
    if (version === undefined || version === null || version.data === undefined || version.mediaType === undefined) {
      const error = new Error('cline-pin: 附件服务没有返回可用的图片内容')
      error.code = 'UNSUPPORTED_CONTENT'
      throw error
    }
    versions.set(ref.attachmentId, { mediaType: version.mediaType, base64: toBase64(version.data) })
  }
  return versions
}
