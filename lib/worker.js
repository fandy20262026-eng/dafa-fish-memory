/**
 * 后台 worker：消费 `job` 表，做抽取与嵌入。
 *
 * 纪律：
 * - 只做本地耗时工作，**永不阻塞对话**；
 * - 任何异常都变成「退避重试」而不是抛出；
 * - 进程退出时 `unref` 定时器，不阻止退出。
 */

import { embedClaims } from './embed.js'
import { extractByRules, persistClaims } from './extract.js'
import { extractWithLlm } from './llm-extract.js'

const MAX_ATTEMPTS = 8
const BACKOFF_BASE_MS = 10_000
const BACKOFF_MAX_MS = 3_600_000
const EMBED_CHUNK = 64

/**
 * 创建 worker。
 * @param {{settings:object, db:object, logger?:object, now?:Function, lease?:object}} deps 依赖。
 * @returns {{start:Function, stop:Function, tick:Function, state:object}} worker。
 */
export function createWorker({ settings, db, logger, now = Date.now, lease = null, cache = null }) {
  const state = {
    processed: 0,
    failed: 0,
    lastError: null,
    lastRunAt: null,
    running: false,
  }

  const selectDue = db.prepare('select * from job where next_at <= ? order by next_at asc limit 1')
  const deleteJob = db.prepare('delete from job where id = ?')
  const bumpJob = db.prepare('update job set attempts = ?, next_at = ? where id = ?')
  const insertJob = db.prepare(
    'insert or ignore into job(kind, dedupe_key, payload, next_at, created_at) values(?, ?, ?, ?, ?)'
  )
  const selectMessages = db.prepare(
    'select role, text from message where session_id = ? and turn = ? order by id asc'
  )
  const selectMissingVec = db.prepare(
    'select c.id, c.text from claim c'
    + ' left join vec v on v.claim_id = c.id and v.model = ?'
    + ' where c.scope = ? and c.deleted_at is null and v.claim_id is null'
    + ' order by c.importance desc, c.created_at asc limit ?'
  )
  const countMissingVec = db.prepare(
    'select count(*) c from claim c'
    + ' left join vec v on v.claim_id = c.id and v.model = ?'
    + ' where c.scope = ? and c.deleted_at is null and v.claim_id is null'
  )

  /**
   * 处理一条 extract 任务：读原文 → 规则抽取 → 写 claim → 排 embed。
   * @param {{scope:string, sessionId:string, turn:number}} payload 任务载荷。
   * @returns {Promise<boolean>} 是否成功。
   */
  async function runExtract(payload) {
    const rows = selectMessages.all(payload.sessionId, payload.turn)
    if (rows.length === 0) return true // 没有原文就当作已完成，避免死循环
    const messages = rows.map(row => ({ role: row.role, text: row.text }))

    let candidates = null
    if (settings.extraction === 'llm') {
      // 质量优先：让模型提炼；返回 null 表示调用失败 → 回退规则，绝不因此丢这一轮
      candidates = await extractWithLlm({ settings, messages })
      if (candidates === null) {
        state.lastError = 'LLM 抽取失败，已回退规则抽取'
        candidates = extractByRules({ scope: payload.scope, messages })
      }
    } else if (settings.extraction === 'rules') {
      candidates = extractByRules({ scope: payload.scope, messages })
    } else {
      candidates = []
    }

    const created = persistClaims(db, payload.scope, payload.sessionId, payload.turn, candidates, now())
    if (created.length > 0) {
      insertJob.run(
        'embed',
        `embed:${payload.scope}`,
        JSON.stringify({ scope: payload.scope }),
        now(),
        now(),
      )
    }
    return true
  }

  /**
   * 处理一条 embed 任务：给缺失向量的 claim 补向量。
   * @param {{scope:string}} payload 任务载荷。
   * @returns {Promise<boolean>} 是否成功。
   */
  async function runEmbed(payload) {
    if (settings.apiKey === '') return false
    const missing = selectMissingVec.all(settings.embeddingModel, payload.scope, EMBED_CHUNK)
    if (missing.length === 0) return true
    const result = await embedClaims(db, settings, missing.map(row => ({ id: Number(row.id), text: row.text })))
    if (!result.ok) {
      state.lastError = result.error ?? '嵌入失败'
      return false
    }
    // 增量更新内存缓存，避免下次召回全量重载
    if (cache !== null && Array.isArray(result.written)) {
      for (const item of result.written) cache.put(item.id, item.vector)
    }
    // 还有剩余就再排一轮，避免一次吞太多导致长任务
    const left = Number(countMissingVec.get(settings.embeddingModel, payload.scope).c)
    if (left > 0) {
      insertJob.run('embed', `embed:${payload.scope}`, JSON.stringify({ scope: payload.scope }), now() + 200, now())
    }
    return true
  }

  /**
   * 执行一次轮询。
   * @returns {Promise<void>}
   */
  async function tick() {
    if (state.running) return
    state.running = true
    try {
      const job = selectDue.get(now())
      if (job === undefined) return
      state.lastRunAt = now()
      let payload = {}
      try {
        payload = JSON.parse(job.payload)
      } catch {
        payload = {}
      }
      let ok = false
      try {
        if (job.kind === 'extract') ok = await runExtract(payload)
        else if (job.kind === 'embed') ok = await runEmbed(payload)
        else ok = true // 未知类型直接丢弃，避免堵住队列
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error)
        ok = false
      }

      if (ok) {
        deleteJob.run(job.id)
        state.processed++
      } else {
        const attempts = Number(job.attempts) + 1
        state.failed++
        if (attempts > MAX_ATTEMPTS) {
          deleteJob.run(job.id)
          logger?.warn?.(`dafa-fish-memory: 任务放弃（${job.kind}，${attempts} 次失败）：${state.lastError ?? '未知错误'}`)
        } else {
          const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1))
          bumpJob.run(attempts, now() + delay, job.id)
        }
      }
    } finally {
      state.running = false
    }
  }

  let timer = null

  return {
    state,
    tick,

    /** 启动定时轮询（不阻止进程退出）。 */
    start() {
      if (timer !== null) return
      timer = setInterval(() => {
        // 双端共存时只有持租约的进程消费队列，避免重复烧 API 额度
        if (lease !== null) {
          if (!lease.isHeld() && !lease.tryAcquire()) return
          lease.renew()
        }
        // 顺带做一次兜底刷新（内部有 10 分钟节流，且走下一 tick，不阻塞）
        cache?.maybeRefresh?.()
        void tick()
      }, settings.workerIntervalMs)
      timer.unref?.()
      // 启动后立刻跑一次，让积压尽快清掉
      if (lease !== null) lease.tryAcquire()
      void tick()
    },

    /** 停止轮询并让出租约。 */
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      try {
        lease?.release()
      } catch {
        /* 释放失败忽略 */
      }
    },
  }
}
