/**
 * SiliconFlow 客户端（免费档：bge-m3 向量 / bge-reranker-v2-m3 重排）。
 *
 * 原则：
 * - 所有请求都带 `AbortSignal`，并且调用方用 `Promise.race` 再做一层硬超时；
 * - 任何失败都返回结构化结果，**绝不向上抛**（记忆不能拖垮宿主）；
 * - key 只从设置里读，日志里永不打全量。
 */

/** 单次请求的通用超时包装：即使底层不响应 abort，也不会超过 deadline。 */
async function fetchWithDeadline(url, init, { signal, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'))
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function describeError(error) {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '请求超时或被取消'
    const cause = error.cause
    if (cause instanceof Error && cause.message) return `${error.message}（${cause.message}）`
    return error.message
  }
  return String(error)
}

/**
 * 探测 embeddings 接口是否可用（doctor 用）。
 * @param {object} settings 运行时设置。
 * @param {{signal?: AbortSignal, timeoutMs?: number}} options 取消与超时。
 * @returns {Promise<{ok:boolean, dim?:number, ms:number, error?:string}>} 探测结果。
 */
export async function probeEmbedding(settings, options = {}) {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? 8000
  if (!settings.apiKey) return { ok: false, ms: 0, error: '未配置 apiKey' }
  try {
    const response = await fetchWithDeadline(`${settings.apiBase}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model: settings.embeddingModel, input: ['ping'] }),
    }, { signal: options.signal, timeoutMs })
    const text = await response.text()
    if (!response.ok) {
      const brief = text.slice(0, 200).replace(/\s+/g, ' ')
      return { ok: false, ms: Date.now() - startedAt, error: `HTTP ${response.status}：${brief}` }
    }
    const data = JSON.parse(text)
    const dim = data?.data?.[0]?.embedding?.length
    if (typeof dim !== 'number' || dim <= 0) {
      return { ok: false, ms: Date.now() - startedAt, error: '响应里没有 embedding 向量' }
    }
    return { ok: true, dim, ms: Date.now() - startedAt }
  } catch (error) {
    return { ok: false, ms: Date.now() - startedAt, error: describeError(error) }
  }
}

/**
 * 调用重排接口给候选打分（`bge-reranker-v2-m3`）。
 * @param {object} settings 运行时设置。
 * @param {string} query 用户查询。
 * @param {string[]} documents 候选文本。
 * @param {{topN?:number, signal?:AbortSignal, timeoutMs?:number}} options 选项。
 * @returns {Promise<{ok:boolean, scores?:Array<{index:number, score:number}>, error?:string}>} 结果。
 */
export async function rerankTexts(settings, query, documents, options = {}) {
  if (documents.length === 0) return { ok: true, scores: [] }
  const timeoutMs = options.timeoutMs ?? 6000
  const body = {
    model: settings.rerankModel,
    query,
    documents,
    return_documents: false,
  }
  if (Number.isFinite(options.topN)) body.top_n = options.topN
  try {
    const response = await fetchWithDeadline(`${settings.apiBase}/v1/rerank`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
    }, { signal: options.signal, timeoutMs })
    const raw = await response.text()
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}：${raw.slice(0, 200).replace(/\s+/g, ' ')}` }
    }
    const data = JSON.parse(raw)
    const list = Array.isArray(data?.results) ? data.results : []
    const scores = []
    for (const item of list) {
      const index = Number(item?.index)
      const score = Number(item?.relevance_score)
      if (Number.isInteger(index) && Number.isFinite(score)) scores.push({ index, score })
    }
    if (scores.length === 0) return { ok: false, error: '重排响应里没有 results' }
    return { ok: true, scores }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

/** 对 key 做脱敏，只留头尾各 4 位。 */
export function maskKey(key) {
  if (typeof key !== 'string' || key === '') return '(未配置)'
  if (key.length <= 12) return '****'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

export { describeError, fetchWithDeadline }
