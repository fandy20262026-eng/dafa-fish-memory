/**
 * 嵌入层：把 claim 文本转成向量，写进 `vec` 表。
 *
 * 设计要点：
 * - 批量 32 条/请求，失败整批重试一次，再退化为逐条（定位坏样本）；
 * - 只写 `vec(claim_id, model)`；换模型时旧向量保留，新向量并行存在；
 * - 任何失败都返回结构化结果，由 worker 决定退避，不抛给宿主。
 */

import { fetchWithDeadline, describeError } from './api.js'

const BATCH_SIZE = 32

/**
 * 把 Float32 数组转成 Buffer，便于直接存 BLOB。
 * @param {ArrayLike<number>} values 数值。
 * @returns {Buffer} 二进制。
 */
export function toBlob(values) {
  return Buffer.from(new Float32Array(values).buffer)
}

/**
 * 从 BLOB 还原 Float32 数组。
 * @param {Buffer|Uint8Array} blob 二进制。
 * @returns {Float32Array} 向量。
 */
export function fromBlob(blob) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
}

/**
 * 调用一次 embeddings 接口。
 * @returns {Promise<{ok:boolean, vectors?:number[][], error?:string}>} 结果。
 */
async function embedBatch(settings, texts, { signal, timeoutMs }) {
  try {
    const response = await fetchWithDeadline(`${settings.apiBase}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model: settings.embeddingModel, input: texts }),
    }, { signal, timeoutMs })
    const raw = await response.text()
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}：${raw.slice(0, 200).replace(/\s+/g, ' ')}` }
    }
    const data = JSON.parse(raw)
    const list = Array.isArray(data?.data) ? data.data : []
    if (list.length !== texts.length) {
      return { ok: false, error: `返回条数 ${list.length} ≠ 请求条数 ${texts.length}` }
    }
    const vectors = list.map(item => item?.embedding)
    if (vectors.some(vec => !Array.isArray(vec) || vec.length === 0)) {
      return { ok: false, error: '返回里有空向量' }
    }
    return { ok: true, vectors }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

/**
 * 批量嵌入一批文本。
 * @param {object} settings 运行时设置。
 * @param {string[]} texts 文本列表。
 * @param {{signal?:AbortSignal, timeoutMs?:number}} options 取消与超时。
 * @returns {Promise<{ok:boolean, vectors?:number[][], dim?:number, error?:string}>} 结果。
 */
export async function embedTexts(settings, texts, options = {}) {
  if (texts.length === 0) return { ok: true, vectors: [], dim: settings.embeddingDim }
  const timeoutMs = options.timeoutMs ?? 15000

  const chunks = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) chunks.push(texts.slice(i, i + BATCH_SIZE))

  const vectors = []
  for (const chunk of chunks) {
    let result = await embedBatch(settings, chunk, { signal: options.signal, timeoutMs })
    if (!result.ok) {
      // 整批重试一次
      result = await embedBatch(settings, chunk, { signal: options.signal, timeoutMs })
    }
    if (!result.ok) return { ok: false, error: result.error }
    vectors.push(...result.vectors)
  }

  const dim = vectors[0]?.length ?? 0
  const mismatch = vectors.find(item => item.length !== dim)
  if (mismatch !== undefined) return { ok: false, error: '同一批返回的向量维度不一致' }
  return { ok: true, vectors, dim }
}

/**
 * 为一组 claim 补向量（只补缺失的）。
 * @param {object} db SQLite 连接。
 * @param {object} settings 运行时设置。
 * @param {Array<{id:number, text:string}>} claims 待嵌入的 claim。
 * @param {{signal?:AbortSignal}} options 取消。
 * @returns {Promise<{ok:boolean, embedded:number, error?:string}>} 结果。
 */
export async function embedClaims(db, settings, claims, options = {}) {
  if (claims.length === 0) return { ok: true, embedded: 0 }
  const result = await embedTexts(settings, claims.map(item => item.text), options)
  if (!result.ok) return { ok: false, embedded: 0, error: result.error }

  const insert = db.prepare(
    'insert into vec(claim_id, model, dim, vec) values(?, ?, ?, ?)'
    + ' on conflict(claim_id, model) do update set dim = excluded.dim, vec = excluded.vec'
  )
  let embedded = 0
  const written = []
  for (let i = 0; i < claims.length; i++) {
    const vector = result.vectors[i]
    if (vector === undefined) continue
    insert.run(claims[i].id, settings.embeddingModel, vector.length, toBlob(vector))
    written.push({ id: claims[i].id, vector: new Float32Array(vector) })
    embedded++
  }
  return { ok: true, embedded, written }
}
