/**
 * 配置解析：默认值、`${ENV}` 展开、路径规范化、模型名校验。
 *
 * 设计要点（来自 memos 的 401 事故教训）：
 * 插件必须**自己**展开 `${...}`，否则用户写了占位符就会把字面量当 Bearer token 发出去，
 * 表现为「持续 401」而看不出原因。这里未展开的变量会被记录进 `problems`，
 * 由 `memory_doctor` 直接报给用户。
 */

import { homedir } from 'node:os'
import { join, isAbsolute, resolve as resolvePath } from 'node:path'

/** 付费档前缀：一律拒绝，回退到免费标准模型。 */
const PAID_PREFIX = 'pro/'

const FREE_EMBEDDING = 'BAAI/bge-m3'
const FREE_RERANK = 'BAAI/bge-reranker-v2-m3'

/**
 * 展开字符串里的 `${VAR}`。
 * @param {unknown} value 原始值。
 * @param {Record<string, string|undefined>} env 环境变量表。
 * @returns {{ value: unknown, missing: string[] }} 展开结果与缺失的变量名。
 */
export function interpolateEnv(value, env = process.env) {
  if (typeof value !== 'string') return { value, missing: [] }
  const missing = []
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const found = env[name]
    if (found === undefined || found === '') {
      missing.push(name)
      return ''
    }
    return found
  })
  return { value: expanded, missing }
}

/**
 * 解析 DSH 主目录。与 DSH 自己的约定一致：`DSH_HOME` 优先，否则 `~/.dsh`。
 * @param {string} configured 配置里显式给的路径，可为空。
 * @returns {string} 绝对路径。
 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    return isAbsolute(configured) ? configured : resolvePath(configured)
  }
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolvePath(fromEnv)
  return join(homedir(), '.dsh')
}

/** 模型名是否属于付费档。 */
export function isPaidModel(model) {
  return typeof model === 'string' && model.trim().toLowerCase().startsWith(PAID_PREFIX)
}

/**
 * 把 cordis 传入的配置整理成运行时设置。
 * @param {Record<string, unknown>} config cordis 已按 Schema 填好默认值的配置。
 * @returns {object} 运行时设置，含 problems（启动自检问题）与已展开的密钥。
 */
export function resolveSettings(config = {}) {
  const problems = []
  const home = resolveDshHome(config.home)
  const dataDir = join(home, 'memory-sf')

  // ---- 密钥：显式值 > ${ENV} 展开 > process.env ----
  let apiKey = ''
  let apiKeyMissing = []
  const rawKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  if (rawKey !== '') {
    const expanded = interpolateEnv(rawKey)
    apiKey = String(expanded.value).trim()
    apiKeyMissing = expanded.missing
    if (expanded.missing.length > 0) {
      problems.push(`apiKey 引用了未设置的环境变量：${expanded.missing.join(', ')}`)
    }
  } else {
    // 不绑定具体服务商：优先 MEMORY_API_KEY，同时兼容旧变量名 SILICONFLOW_API_KEY
    apiKey = (process.env.MEMORY_API_KEY ?? process.env.SILICONFLOW_API_KEY ?? '').trim()
    if (apiKey === '') {
      problems.push('未配置 apiKey，也没有 MEMORY_API_KEY（或旧名 SILICONFLOW_API_KEY）环境变量')
    }
  }
  if (apiKey.includes('${')) problems.push('apiKey 展开后仍含 ${，请检查配置')

  // ---- 模型：不做免费/付费限制，由使用者自己决定 ----
  // 早先这里会拒绝 `Pro/` 开头的模型并回退到免费档。后来改成完全不干预：
  // 用什么档位、什么维度是使用者的成本决策，插件不该替他选。
  const embeddingModel = String(config.embeddingModel ?? FREE_EMBEDDING)
  const rerankModel = String(config.rerankModel ?? FREE_RERANK)

  const embeddingDim = Number(config.embeddingDim ?? 1024)
  if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
    problems.push(`embeddingDim 非法：${String(config.embeddingDim)}，已回退 1024`)
  }

  // ---- 路径 ----
  const storagePath = typeof config.storagePath === 'string' && config.storagePath.trim() !== ''
    ? resolvePath(interpolateEnv(config.storagePath).value)
    : join(dataDir, 'memory.db')

  // ---- 搬迁用的 scope 映射（旧前缀 → 新前缀） ----
  let scopeMap = {}
  const rawScopeMap = typeof config.scopeMapJson === 'string' ? config.scopeMapJson.trim() : ''
  if (rawScopeMap !== '') {
    try {
      const parsed = JSON.parse(rawScopeMap)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) scopeMap = parsed
      else problems.push('scopeMapJson 必须是 {"旧前缀":"新前缀"} 形式的对象，已忽略')
    } catch {
      problems.push('scopeMapJson 不是合法 JSON，已忽略')
    }
  }

  return {
    home,
    dataDir,
    storagePath,
    logPath: join(dataDir, 'memory.log'),
    diagPath: join(dataDir, 'diag.jsonl'),
    lockPath: join(dataDir, 'worker.lock'),
    apiKey,
    apiKeyMissing,
    apiBase: config.apiBase ?? 'https://api.siliconflow.cn',
    embeddingModel,
    embeddingDim: Number.isInteger(embeddingDim) && embeddingDim > 0 ? embeddingDim : 1024,
    rerankModel,
    scopeMode: config.isolation === 'global' ? 'global' : 'workspace',
    scopeMap,
    autoRecall: config.autoRecall !== false,
    autoCapture: config.autoCapture !== false,
    extraction: config.extraction ?? 'rules',
    extractionModel: config.extractionModel ?? 'Qwen/Qwen3-8B',
    scaleTier: ['A', 'B', 'C'].includes(config.scaleTier) ? config.scaleTier : 'auto',
    recallTimeoutMs: Number(config.recallTimeoutMs ?? 5000),
    contextMaxChars: Number(config.contextMaxChars ?? 4000),
    maxItems: Number(config.maxItems ?? 5),
    workerIntervalMs: Number(config.workerIntervalMs ?? 2000),
    viewerEnabled: config.viewerEnabled !== false,
    viewerPort: Number(config.viewerPort ?? 18181),
    logLevel: config.logLevel ?? 'warn',
    problems,
  }
}
