/**
 * 召回层：四路召回 → RRF 融合 → 相对阈值 → rerank 精排 → MMR 去重 → 预算裁剪。
 *
 * 设计要点（都有出处，见方案 §4.2）：
 * - **四路而不是一路**：纯向量抓不住端口号/错误码/文件名这类精确标识符，
 *   纯关键词抓不住改写；短中文查询（≤3 字）单靠 FTS 也会漏。
 * - **模型只做重排，不做召回**：召回的骨架是机械的，任何一路失败都不影响其余。
 * - **精排失败必须有机械兜底**：`top×0.7`、最多 4 条，绝不清空。
 * - **MMR 去冗余**：避免把「同一件事的三种说法」全塞进上下文。
 */

import { rerankTexts } from './api.js'
import { embedTexts, fromBlob } from './embed.js'
import { makeFtsQuery } from './store.js'
import { usesPrefilter } from './scale.js'

const MAX_CANDIDATES = 40
const RERANK_TOP = 24
const RRF_K = 60
const RELATIVE_THRESHOLD = 0.2
const FALLBACK_KEEP = 4

/** 各通道权重：精确匹配最可信，短查询 LIKE 最弱。 */
const CHANNEL_WEIGHT = { vector: 1, fts: 1, exact: 1.2, like: 0.6 }

/**
 * 余弦相似度（bge-m3 输出已归一化，点积即余弦）。
 * @param {Float32Array} a 向量。
 * @param {Float32Array} b 向量。
 * @returns {number} 相似度。
 */
function cosine(a, b) {
  const length = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < length; i++) sum += a[i] * b[i]
  return sum
}

/**
 * 默认参与自动注入的记忆类型。
 *
 * **特意排除 `convention`**：它是「流程模板」这一类程序性知识，与 skill 职责重叠。
 * skill 是权威的、人写的；记忆里的流程是二手总结、可能过期。两者同时出现会让模型犯迷糊，
 * 所以自动注入只带事实/偏好/决策，流程类只在显式 `memory_search` 里出现。
 */
export const DEFAULT_RECALL_KINDS = ['preference', 'decision', 'fact', 'turn_summary']

/**
 * 构造 claim 过滤片段（作用域 + 类型）。
 * @param {object} settings 运行时设置。
 * @param {string} scope 当前会话 scope。
 * @param {string[]|null} kinds 允许的类型；null/空表示不过滤。
 * @returns {{sql:string, args:any[]}} SQL 片段与参数。
 */
function claimFilter(settings, scope, kinds) {
  const parts = []
  const args = []
  if (settings.scopeMode !== 'global') {
    parts.push("(c.scope = ? or c.scope = 'global')")
    args.push(scope)
  }
  if (Array.isArray(kinds) && kinds.length > 0) {
    parts.push(`c.kind in (${kinds.map(() => '?').join(',')})`)
    args.push(...kinds)
  }
  if (parts.length === 0) return { sql: '', args: [] }
  return { sql: ` and ${parts.join(' and ')}`, args }
}

/**
 * 从查询里提取「精确标识符」：端口、错误码、路径、文件名、版本号。
 * @param {string} query 查询。
 * @returns {string[]} 标识符列表。
 */
function identifiersOf(query) {
  const matches = String(query).match(/[A-Za-z0-9_][A-Za-z0-9_.#:@/\\-]{2,}/g) ?? []
  const out = []
  for (const raw of matches) {
    const token = raw.replace(/[.,;:]+$/, '')
    if (token.length >= 3 && !out.includes(token)) out.push(token)
  }
  return out.slice(0, 4)
}

/**
 * A 路：向量召回。
 *
 * 按规模档位切换：
 * - A/B 档：`cache.scan()` 直接全量扫描（B 档内部已是 int8，调用方无感）；
 * - C 档：先用 SQL 预筛候选 id（重要度 + 时间窗），再只对这些 id 做点积，
 *   避免一次扫十几万条把事件循环占住。
 *
 * @param {object|null} cache 内存向量缓存；为 null 时走保守的逐行读库路径。
 * @param {object|null} tier 档位描述（见 scale.js）；null 表示未分档。
 * @param {number} nowTs 当前时间戳（C 档预筛用）。
 * @returns {number[]} 按相似度降序的 claim id。
 */
function vectorChannel(db, settings, scope, queryVector, cache, kinds, tier = null, nowTs = Date.now()) {
  if (cache === null) {
    // 无缓存时的保守路径（脚本/首启）
    const filter = claimFilter(settings, scope, kinds)
    const rows = db.prepare(
      'select c.id, v.vec from claim c join vec v on v.claim_id = c.id and v.model = ?'
      + " where c.deleted_at is null and c.claim_state = 'active'" + filter.sql
    ).all(settings.embeddingModel, ...filter.args)
    const scored = []
    for (const row of rows) {
      let vector
      try {
        vector = fromBlob(row.vec)
      } catch {
        continue
      }
      const similarity = cosine(queryVector, vector)
      if (Number.isFinite(similarity)) scored.push({ id: Number(row.id), score: similarity })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, MAX_CANDIDATES).map(item => item.id)
  }

  // B/C 档：预筛候选集（减少参与比较的条数，这才是压住延迟的关键）
  const allow = usesPrefilter(tier?.strategy) ? buildTieredCandidates(db, settings, scope, kinds, nowTs) : null
  if (allow !== null && allow.size === 0) return []

  const top = cache.scan(queryVector, MAX_CANDIDATES * 3, allow)
  if (top.length === 0) return []

  const ids = top.map(item => item.id)
  const placeholders = ids.map(() => '?').join(',')
  const filter = claimFilter(settings, scope, kinds)
  let validRows = []
  try {
    validRows = db.prepare(
      `select c.id from claim c where c.id in (${placeholders})`
      + " and c.deleted_at is null and c.claim_state = 'active'" + filter.sql
    ).all(...ids, ...filter.args)
  } catch {
    return []
  }
  const valid = new Set(validRows.map(row => Number(row.id)))
  return top.filter(item => valid.has(item.id)).slice(0, MAX_CANDIDATES).map(item => item.id)
}

/**
 * C 档的候选预筛：只保留「够重要」或「够新」的记忆参与向量扫描。
 *
 * 取舍：超大规模下不可能每条都参与比较，宁可牺牲长尾的少量召回，也要保住单轮延迟。
 * 阈值（importance ≥ 0.4 或近 180 天）是可以调的，默认值针对「聊天记忆」这类分布。
 * @param {number} nowTs 当前时间戳。
 * @returns {Set<number>} 候选 id 集合。
 */
function buildTieredCandidates(db, settings, scope, kinds, nowTs) {
  const filter = claimFilter(settings, scope, kinds)
  const cutoff = nowTs - 180 * 86_400_000
  try {
    const rows = db.prepare(
      'select c.id from claim c'
      + " where c.deleted_at is null and c.claim_state = 'active'"
      + ' and (c.importance >= 0.4 or c.created_at >= ?)' + filter.sql
      + ' limit 60000'
    ).all(cutoff, ...filter.args)
    return new Set(rows.map(row => Number(row.id)))
  } catch {
    return null
  }
}

/**
 * B 路：关键词召回（中文 bigram）。
 * @returns {number[]} 按相关度降序的 claim id。
 */
function ftsChannel(db, settings, scope, query, kinds) {
  const match = makeFtsQuery(query)
  if (match === null) return []
  const filter = claimFilter(settings, scope, kinds)
  try {
    const rows = db.prepare(
      'select c.id from claim_fts join claim c on c.id = claim_fts.rowid'
      + ' where claim_fts match ?' + filter.sql
      + " and c.deleted_at is null and c.claim_state = 'active'"
      + ' order by bm25(claim_fts) limit ?'
    ).all(match, ...filter.args, MAX_CANDIDATES / 2)
    return rows.map(row => Number(row.id))
  } catch {
    return []
  }
}

/**
 * C 路：短查询 LIKE（中文 2~3 字时 FTS 可能切不出词，用子串兜底）。
 * @returns {number[]} claim id。
 */
function likeChannel(db, settings, scope, query, kinds) {
  const trimmed = String(query).trim()
  if (trimmed.length === 0 || trimmed.length > 6) return []
  const filter = claimFilter(settings, scope, kinds)
  try {
    const rows = db.prepare(
      'select c.id from claim c where c.text like ?' + filter.sql
      + " and c.deleted_at is null and c.claim_state = 'active' limit 10"
    ).all(`%${trimmed}%`, ...filter.args)
    return rows.map(row => Number(row.id))
  } catch {
    return []
  }
}

/**
 * D 路：精确标识符（端口 / 路径 / 错误码）。
 * @returns {number[]} claim id。
 */
function exactChannel(db, settings, scope, query, kinds) {
  const tokens = identifiersOf(query)
  if (tokens.length === 0) return []
  const filter = claimFilter(settings, scope, kinds)
  const hits = []
  for (const token of tokens) {
    try {
      const rows = db.prepare(
        'select c.id from claim c where c.text like ?' + filter.sql
        + " and c.deleted_at is null and c.claim_state = 'active' limit 10"
      ).all(`%${token}%`, ...filter.args)
      for (const row of rows) {
        const id = Number(row.id)
        if (!hits.includes(id)) hits.push(id)
      }
    } catch {
      /* 单路失败不影响其他 */
    }
  }
  return hits.slice(0, MAX_CANDIDATES / 2)
}

/**
 * RRF 融合：多通道各给一个排名，分数相加；同一条被多路命中再加成。
 * @param {Array<{name:string, ids:number[]}>} channels 各通道结果。
 * @returns {Array<{id:number, score:number}>} 融合后的候选。
 */
function fuse(channels) {
  const merged = new Map()
  for (const channel of channels) {
    const weight = CHANNEL_WEIGHT[channel.name] ?? 1
    channel.ids.forEach((id, position) => {
      const entry = merged.get(id) ?? { id, score: 0, hits: 0 }
      entry.score += weight / (RRF_K + position + 1)
      entry.hits++
      merged.set(id, entry)
    })
  }
  const list = [...merged.values()]
  for (const entry of list) {
    // 多路同时命中说明信号更强
    if (entry.hits >= 2) entry.score *= 1.15
  }
  list.sort((a, b) => b.score - a.score)
  return list
}

/**
 * MMR 去冗余：在相关性与多样性之间折中。
 * @param {Array<object>} items 候选（含 vector）。
 * @param {number} limit 保留条数。
 * @param {number} lambda 相关性权重。
 * @returns {Array<object>} 精选结果。
 */
function selectByMmr(items, limit, lambda = 0.7) {
  if (items.length <= limit) return items
  const selected = []
  const pool = [...items]
  while (selected.length < limit && pool.length > 0) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i]
      let redundancy = 0
      for (const chosen of selected) {
        if (candidate.vector && chosen.vector) {
          redundancy = Math.max(redundancy, cosine(candidate.vector, chosen.vector))
        } else {
          // 没有向量时用字符重合度近似
          const a = new Set(candidate.text)
          const b = new Set(chosen.text)
          let inter = 0
          for (const ch of a) if (b.has(ch)) inter++
          redundancy = Math.max(redundancy, inter / Math.max(1, Math.min(a.size, b.size)))
        }
      }
      const score = lambda * (candidate.relScore ?? 0) - (1 - lambda) * redundancy
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0])
  }
  return selected
}

/**
 * 时间衰减：越新越有价值。
 * @param {number} createdAt 写入时间。
 * @param {number} nowTs 当前时间。
 * @returns {number} 0~1。
 */
function recency(createdAt, nowTs) {
  const days = Math.max(0, (nowTs - createdAt) / 86_400_000)
  return Math.exp(-days / 90)
}

/**
 * 执行一次召回。
 * @param {{settings:object, db:object, query:string, scope:string, signal?:AbortSignal, cache?:object,
 *          kinds?:string[]|null, tier?:object|null, now?:Function}} input 输入。
 *   - `kinds` 为 null/空数组时不过滤类型（显式检索用），默认只召回事实/偏好/决策类。
 *   - `tier` 为规模档位（scale.js）；C 档会先预筛候选集。
 * @returns {Promise<{hits:Array<object>, trace:object}>} 结果与诊断信息。
 */
export async function retrieve({
  settings, db, query, scope, signal, cache = null,
  kinds = DEFAULT_RECALL_KINDS, tier = null, now = Date.now,
}) {
  const nowTs = now()
  const trace = { query: String(query).slice(0, 80), channels: {}, fused: 0, reranked: false, kept: 0, ms: 0 }
  const startedAt = nowTs

  const trimmed = String(query ?? '').trim()
  if (trimmed === '') return { hits: [], trace }

  // ---- 四路召回 ----
  let queryVector = null
  if (settings.apiKey !== '') {
    const embedded = await embedTexts(settings, [trimmed], { signal })
    if (embedded.ok && embedded.vectors.length > 0) queryVector = new Float32Array(embedded.vectors[0])
  }

  const channelResults = []
  if (queryVector !== null) {
    const ids = vectorChannel(db, settings, scope, queryVector, cache, kinds, tier, nowTs)
    trace.channels.vector = ids.length
    channelResults.push({ name: 'vector', ids })
  } else {
    trace.channels.vector = 0
  }
  const ftsIds = ftsChannel(db, settings, scope, trimmed, kinds)
  trace.channels.fts = ftsIds.length
  channelResults.push({ name: 'fts', ids: ftsIds })

  const likeIds = likeChannel(db, settings, scope, trimmed, kinds)
  trace.channels.like = likeIds.length
  if (likeIds.length > 0) channelResults.push({ name: 'like', ids: likeIds })

  const exactIds = exactChannel(db, settings, scope, trimmed, kinds)
  trace.channels.exact = exactIds.length
  if (exactIds.length > 0) channelResults.push({ name: 'exact', ids: exactIds })

  const fused = fuse(channelResults)
  trace.fused = fused.length
  if (fused.length === 0) {
    trace.ms = now() - startedAt
    return { hits: [], trace }
  }

  // ---- 相对阈值 ----
  const topScore = fused[0].score
  const aboveThreshold = fused.filter(item => item.score >= topScore * RELATIVE_THRESHOLD)
  trace.aboveThreshold = aboveThreshold.length

  // ---- 取详情 ----
  const ids = aboveThreshold.map(item => item.id)
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(
    `select c.id, c.text, c.kind, c.basis, c.importance, c.created_at, c.use_count,
            v.vec
       from claim c left join vec v on v.claim_id = c.id and v.model = ?
      where c.id in (${placeholders})`
  ).all(settings.embeddingModel, ...ids)

  const byId = new Map()
  for (const row of rows) {
    let vector = null
    if (row.vec) {
      try {
        vector = fromBlob(row.vec)
      } catch {
        vector = null
      }
    }
    byId.set(Number(row.id), {
      id: Number(row.id),
      text: String(row.text),
      kind: String(row.kind),
      basis: String(row.basis),
      importance: Number(row.importance),
      createdAt: Number(row.created_at),
      useCount: Number(row.use_count),
      vector,
      score: fused.find(item => item.id === Number(row.id))?.score ?? 0,
    })
  }

  let candidates = aboveThreshold
    .map(item => byId.get(item.id))
    .filter(item => item !== undefined)

  // ---- rerank 精排（失败则机械兜底）----
  const budgetChars = settings.contextMaxChars
  const limit = settings.maxItems

  if (candidates.length > 0 && settings.apiKey !== '') {
    const top = candidates.slice(0, RERANK_TOP)
    const result = await rerankTexts(settings, trimmed, top.map(item => item.text.slice(0, 2000)), {
      signal,
      topN: top.length,
    })
    if (result.ok) {
      trace.reranked = true
      const scoreById = new Map()
      for (const item of result.scores) {
        const target = top[item.index]
        if (target !== undefined) scoreById.set(target.id, item.score)
      }
      for (const item of candidates) {
        const rerankScore = scoreById.get(item.id)
        item.relScore = rerankScore === undefined ? 0 : rerankScore
      }
      candidates.sort((a, b) => b.relScore - a.relScore)
      // 只有精排分太低的才丢（避免全空）
      const best = candidates[0].relScore
      if (best > 0) candidates = candidates.filter(item => item.relScore >= best * 0.05)
    } else {
      trace.rerankError = result.error
      trace.fallback = 'rrf'
      candidates = candidates.slice(0, Math.min(FALLBACK_KEEP, limit))
      for (const item of candidates) item.relScore = item.score
    }
  } else {
    trace.fallback = 'rrf'
    candidates = candidates.slice(0, Math.min(FALLBACK_KEEP, limit))
    for (const item of candidates) item.relScore = item.score
  }

  // ---- 综合打分 ----
  for (const item of candidates) {
    item.final = 0.70 * (item.relScore ?? 0)
      + 0.15 * recency(item.createdAt, nowTs)
      + 0.10 * item.importance
      + 0.05 * 1
  }
  candidates.sort((a, b) => b.final - a.final)

  // ---- MMR + 预算 ----
  const picked = selectByMmr(candidates, limit)
  const hits = []
  let usedChars = 0
  for (const item of picked) {
    const text = item.text.length > 640 ? `${item.text.slice(0, 640)}…` : item.text
    if (usedChars + text.length > budgetChars && hits.length > 0) break
    usedChars += text.length
    hits.push({
      id: item.id,
      text,
      kind: item.kind,
      basis: item.basis,
      importance: item.importance,
      createdAt: item.createdAt,
      score: Number(item.final.toFixed(4)),
    })
  }
  trace.kept = hits.length
  trace.chars = usedChars
  trace.ms = now() - startedAt
  return { hits, trace }
}
