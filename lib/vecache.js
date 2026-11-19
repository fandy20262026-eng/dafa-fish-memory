/**
 * 向量缓存：把 `vec` 表里的向量放进内存，避免每次召回都从 SQLite 读几十 MB。
 *
 * ## 按规模自动切换存储与扫描方式
 *
 * 见 `scale.js` 的档位表。本模块只负责「按档位决定怎么存、怎么扫」：
 *
 * - **A 档（≤2 万）**：存 Float32Array，全量点积。最精确，2 万条约 80MB、单次约 30–80ms。
 * - **B 档（2 万–10 万）**：存 int8 + 缩放系数，点积时用 float 查询乘 int8 存储。
 *   内存降到 1/4，扫描快约 3 倍，排序结果基本不变。
 * - **C 档（>10 万）**：同样存 int8，但召回时先由 SQL 预筛候选 id（重要度/时间窗），
 *   只对候选集做点积，避免一次扫十几万条把事件循环占住。
 *
 * ## 请求路径永不触发全量加载
 *
 * 第一版用 `pragma data_version` 做失效检测，导致 worker 每写一条记忆就全量重读 35MB，
 * 又把这段同步代码放在 `agent/pre-step` 上，最终把 Web 卡死了。现在的规则：
 *
 * 1. `scan()` 只读内存，绝不读库；
 * 2. 启动时 `warmup()` 在 `setImmediate` 里加载一次；
 * 3. worker 嵌入后用 `put()` 增量补；
 * 4. 最多每 `refreshMs`（默认 10 分钟）在后台兜底重载一次，消化另一个进程写入的向量。
 */

import { fromBlob } from './embed.js'
import { dotInt8, quantizeVector, usesQuantizedStorage } from './scale.js'

const DEFAULT_REFRESH_MS = 600_000

/**
 * 创建向量缓存。
 * @param {object} db SQLite 连接。
 * @param {object} settings 运行时设置（用 embeddingModel 区分模型空间）。
 * @param {{tier?:object, now?:Function, refreshMs?:number, logger?:object}} options 选项。
 * @returns {object} 缓存。
 */
export function createVectorCache(db, settings, options = {}) {
  const now = options.now ?? Date.now
  const refreshMs = Number(options.refreshMs ?? DEFAULT_REFRESH_MS)
  const logger = options.logger
  const tier = options.tier ?? null

  /** 是否用 int8 存储。档位未知时先按 float32，等首次加载后再定。 */
  let quantized = tier === null ? false : usesQuantizedStorage(tier.strategy)
  const map = new Map()
  let loadedAt = 0
  let loaded = false
  let refreshing = false

  /**
   * 把一条向量放进缓存（按当前模式）。
   * @param {number} claimId claim id。
   * @param {Float32Array} vector 原始向量。
   */
  function store(claimId, vector) {
    if (quantized) {
      const { data, scale } = quantizeVector(vector)
      map.set(Number(claimId), { data, scale })
    } else {
      map.set(Number(claimId), vector)
    }
  }

  /** 同步全量读取（只在预热与后台刷新里调用，绝不放在请求路径上）。 */
  function loadNow() {
    const startedAt = now()
    try {
      // 先数一下规模，决定要不要量化
      const total = Number(
        db.prepare('select count(*) c from vec where model = ?').get(settings.embeddingModel)?.c ?? 0
      )
      if (tier === null) {
        // 没有外部档位时，按 2 万条阈值自动决定（与 scale.js 的 A/B 分界一致）
        quantized = total > 20_000
      }

      const rows = db.prepare('select claim_id, vec from vec where model = ?').all(settings.embeddingModel)
      const next = new Map()
      for (const row of rows) {
        try {
          const vector = fromBlob(row.vec)
          if (quantized) {
            const { data, scale } = quantizeVector(vector)
            next.set(Number(row.claim_id), { data, scale })
          } else {
            next.set(Number(row.claim_id), vector)
          }
        } catch {
          /* 单条损坏不影响整体 */
        }
      }
      map.clear()
      for (const [id, value] of next) map.set(id, value)
      loaded = true
      loadedAt = now()
      const cost = now() - startedAt
      if (cost > 200) {
        logger?.warn?.(
          `dsh-memory: 向量缓存重载耗时 ${cost}ms（${map.size} 条，${quantized ? 'int8' : 'float32'}）`
        )
      }
      return true
    } catch (error) {
      logger?.warn?.(`dsh-memory: 向量缓存加载失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  return {
    /** 取当前内存里的向量（不读库、不阻塞）。保留给诊断用。 */
    all() {
      return map
    },

    /** 当前条数。 */
    count() {
      return map.size
    },

    /** 是否已加载。 */
    isLoaded() {
      return loaded
    },

    /** 当前存储形态，给 doctor 展示。 */
    storageMode() {
      return quantized ? 'int8' : 'float32'
    },

    /**
     * 向量召回：返回与查询最相似的 claim id。
     *
     * 只读内存。调用方负责再用 SQL 校验 scope / 状态 / 类型。
     * @param {Float32Array} queryVector 查询向量。
     * @param {number} limit 取前多少条。
     * @param {Set<number>|null} allow 允许的 claim id 集合（C 档预筛用）；null 表示不限。
     * @returns {Array<{id:number, score:number}>} 按相似度降序。
     */
    scan(queryVector, limit, allow = null) {
      // int8 模式下查询向量也量化一次，之后全程整数运算（这是提速的关键）
      const quantizedQuery = quantized ? quantizeVector(queryVector) : null
      const scored = []
      for (const [id, value] of map) {
        if (allow !== null && !allow.has(id)) continue
        const score = value instanceof Float32Array
          ? dotFloat(queryVector, value)
          : dotInt8(quantizedQuery.data, quantizedQuery.scale, value.data, value.scale)
        if (Number.isFinite(score)) scored.push({ id, score })
      }
      scored.sort((a, b) => b.score - a.score)
      return limit > 0 ? scored.slice(0, limit) : scored
    },

    /** 增量写入（worker 嵌入后调用）。 */
    put(claimId, vector) {
      store(claimId, vector)
    },

    /** 删除一条（遗忘时调用）。 */
    remove(claimId) {
      map.delete(Number(claimId))
    },

    /** 强制立即重载（脚本与排障用，不在请求路径调用）。 */
    reload() {
      return loadNow()
    },

    /** 启动预热：放到下一个 tick，避开启动阶段的同步工作。 */
    warmup() {
      setImmediate(() => {
        loadNow()
      })
    },

    /** 后台兜底刷新：距上次加载超过 `refreshMs` 才真的重读。 */
    maybeRefresh() {
      if (refreshing) return
      if (loaded && now() - loadedAt < refreshMs) return
      refreshing = true
      setImmediate(() => {
        try {
          loadNow()
        } finally {
          refreshing = false
        }
      })
    },

    /** 诊断信息。 */
    stats() {
      return {
        size: map.size,
        loaded,
        ageMs: loaded ? now() - loadedAt : null,
        quantized,
      }
    },
  }
}

/**
 * float32 点积（embedding 已归一化，点积≈余弦）。
 * @param {Float32Array|number[]} a 查询向量。
 * @param {Float32Array} b 存储向量。
 * @returns {number} 点积。
 */
function dotFloat(a, b) {
  const length = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < length; i++) sum += a[i] * b[i]
  return sum
}
