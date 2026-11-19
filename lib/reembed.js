/**
 * 重嵌（升维 / 换模型）：把库里所有记忆用当前配置的模型重新算一遍向量。
 *
 * ## 什么时候需要
 *
 * - 换了 embedding 模型（比如从 `BAAI/bge-m3` 换成别的）
 * - 换了维度（1024 → 2048 / 4096）
 * - 换了 `apiBase`（同一模型名在别的服务商上向量不通用）
 *
 * ## 为什么不是"数学升维"
 *
 * 1024 维向量没法真正变成 2048 维——补零会破坏余弦相似度的分布，
 * 检索质量会明显下降。正确做法是**用新模型把文本重新嵌入一遍**，
 * 原文一直在 `claim` 表里，向量本来就是派生物，随时可重建。
 *
 * ## 旧向量会怎样
 *
 * `vec` 表的主键是 `(claim_id, model)`，所以新旧模型的向量**并行存在**。
 * 重嵌过程中旧模型的向量仍然可用（检索按 `settings.embeddingModel` 匹配），
 * 所以中途失败也不会让记忆变成"搜不到"。
 */

import { embedClaims } from './embed.js'

/** 每批嵌入多少条。太大容易触发接口限流，太小则慢。 */
const BATCH_SIZE = 32

/**
 * 重建全部向量。
 * @param {object} input 输入。
 * @param {object} input.db SQLite 连接。
 * @param {object} input.settings 运行时设置（读取目标模型与维度）。
 * @param {object} [input.logger] 日志。
 * @param {AbortSignal} [input.signal] 取消信号。
 * @param {Function} [input.onProgress] 进度回调 `(done, total) => void`。
 * @returns {Promise<{ok:boolean, done:number, total:number, failed:number, error?:string}>} 结果。
 */
export async function reembedAll({ db, settings, logger, signal, onProgress }) {
  const rows = db.prepare(
    "select id, text from claim where deleted_at is null and claim_state = 'active'"
  ).all()
  const total = rows.length
  if (total === 0) return { ok: true, done: 0, total: 0, failed: 0 }

  let done = 0
  let failed = 0

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    if (signal?.aborted) {
      return { ok: false, done, total, failed, error: '已取消' }
    }
    const batch = rows.slice(offset, offset + BATCH_SIZE).map(row => ({
      id: Number(row.id),
      text: String(row.text),
    }))

    let result
    try {
      result = await embedClaims(db, settings, batch, { signal })
    } catch (error) {
      // 单批失败不中断整体：记录后继续，最后统一报告
      failed += batch.length
      logger?.warn?.(
        `dafa-fish-memory: 重嵌第 ${offset / BATCH_SIZE + 1} 批失败：${error instanceof Error ? error.message : String(error)}`
      )
      continue
    }

    if (!result.ok) {
      failed += batch.length
      logger?.warn?.(`dafa-fish-memory: 重嵌批次失败：${result.error ?? '未知错误'}`)
      continue
    }

    done += result.embedded
    onProgress?.(done, total)
    if (done % 320 === 0) {
      logger?.info?.(`dafa-fish-memory: 重嵌进度 ${done}/${total}`)
    }
  }

  // 全部跑完才更新 active 标记：中途失败时旧模型仍是"有效模型"
  if (failed === 0) {
    db.prepare("insert into meta(key, value) values('active_model', ?) on conflict(key) do update set value = excluded.value")
      .run(settings.embeddingModel)
    db.prepare("insert into meta(key, value) values('active_dim', ?) on conflict(key) do update set value = excluded.value")
      .run(String(settings.embeddingDim))
  }

  return { ok: failed === 0, done, total, failed }
}

/**
 * 统计库里各模型各维度的向量数量，用于「换模型前先看清楚现状」。
 * @param {object} db SQLite 连接。
 * @returns {Array<{model:string, dim:number, count:number}>} 分布。
 */
export function vectorBreakdown(db) {
  try {
    return db.prepare('select model, dim, count(*) c from vec group by model, dim order by c desc').all()
      .map(row => ({ model: String(row.model), dim: Number(row.dim), count: Number(row.c) }))
  } catch {
    return []
  }
}
