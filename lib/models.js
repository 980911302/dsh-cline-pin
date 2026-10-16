/**
 * 内置的 Cline Pass 模型清单与上下文窗口。独立成一个不依赖 dsh 的模块，
 * 这样命令行工具（bin/cline-pin.mjs）不装 dsh 也能用它。
 *
 * @module dsh-cline-pin/models
 */

/**
 * Cline Pass 当前的订阅模型（2026-10-15 取自官方公开清单；用 `cline-pin models` 可以重新生成最新的）。
 */
export const DEFAULT_MODELS = [
  'cline-pass/deepseek-v4.1-flash',
  'cline-pass/deepseek-v4-pro',
  'cline-pass/glm-5.3',
  'cline-pass/glm-5.3-flash',
  'cline-pass/kimi-k3',
  'cline-pass/mimo-v2.5',
  'cline-pass/mimo-v2.5-pro',
  'cline-pass/mimo-v2.6-flash',
  'cline-pass/mimo-v2.6-pro',
  'cline-pass/minimax-m3',
  'cline-pass/muse-spark-1.3-contributor',
  'cline-pass/qwen3.7-max',
  'cline-pass/qwen3.7-plus',
  'cline-pass/qwen3.8-max',
]

/** 官方清单的描述里明确写了 1M 上下文的模型；其它模型用 `defaultContextWindow`，可在 `models` 里单独调。 */
export const KNOWN_WINDOWS = {
  'cline-pass/deepseek-v4.1-flash': 1_000_000,
  'cline-pass/deepseek-v4-pro': 1_000_000,
  'cline-pass/minimax-m3': 1_000_000,
  'cline-pass/qwen3.7-max': 1_000_000,
}

/**
 * 参考 dsh-cline-pass（MIT）发布的 Cline Pass 模型输入能力。
 * 官方 models 接口没有这个字段，所以这里只收当前已知的支持图片的模型；
 * 没列到的按纯文本处理，避免给上游发它不认识的图片块。
 */
export const INPUT_MODALITIES = {
  'cline-pass/deepseek-v4.1-flash': ['text', 'image'],
  'cline-pass/glm-5.3-flash': ['text', 'image'],
  'cline-pass/kimi-k3': ['text', 'image'],
  'cline-pass/minimax-m3': ['text', 'image'],
  'cline-pass/qwen3.8-max': ['text', 'image'],
  'cline-pass/qwen3.7-plus': ['text', 'image'],
  'cline-pass/mimo-v2.5': ['text', 'image'],
}

/** 一个模型对外声明的输入模态；未知模型保守地只用文本。 */
export function modalitiesFor(id) {
  const list = INPUT_MODALITIES[String(id)]
  return Array.isArray(list) && list.length > 0 ? [...list] : ['text']
}

/** 支持的思考等级定义（标准五级：Off, Low, Medium, High, Max，完美兼容 DeepSeek 官方及各大推理网关）。 */
export const REASONING_EFFORTS = [
  { id: 'off', name: 'Off', description: '关闭思考；速度最快、消耗最少。' },
  { id: 'low', name: 'Low', description: '低强度思考，适合常规或低延迟任务。' },
  { id: 'medium', name: 'Medium', description: '均衡的思考量。' },
  { id: 'high', name: 'High', description: '高强度思考，适合多步骤复杂任务。' },
  { id: 'max', name: 'Max', description: '最高思考深度，优先保证回答质量。' },
]

/** 支持思考/推理的模型集合。 */
export const REASONING_MODELS = new Set([
  'cline-pass/deepseek-v4.1-flash',
  'cline-pass/deepseek-v4-flash',
  'cline-pass/deepseek-v4-pro',
  'cline-pass/glm-5.3',
  'cline-pass/glm-5.3-flash',
  'cline-pass/glm-5.2',
  'cline-pass/kimi-k3',
  'cline-pass/kimi-k2.7-code',
  'cline-pass/kimi-k2.6',
  'cline-pass/minimax-m3',
  'cline-pass/qwen3.8-max',
  'cline-pass/qwen3.7-max',
  'cline-pass/qwen3.7-plus',
  'cline-pass/mimo-v2.5-pro',
  'cline-pass/mimo-v2.5',
  'cline-pass/mimo-v2.6-flash',
  'cline-pass/mimo-v2.6-pro',
])

/** 判断一个模型是否具备思考能力。 */
export function reasoningFor(id) {
  const str = String(id).toLowerCase()
  if (REASONING_MODELS.has(String(id))) return true
  if (/deepseek|kimi|qwen|glm|minimax|mimo|o1|o3|r1|reasoning|thinking/i.test(str)) return true
  return false
}

