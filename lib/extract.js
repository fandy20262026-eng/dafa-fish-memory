/**
 * 抽取层：把一轮对话压成「可验证的陈述」（claim）。
 *
 * 纪律（来自三家插件的共同教训）：
 * 1. **规则先筛**，只对「像事实/偏好/决策」的句子动手；其余不产生 claim，原文仍可被关键词搜到。
 * 2. **`basis` 必填**，且只有用户本人说的话才是 `direct_report`——助手说的话一律 `derived_summary`。
 * 3. **只改写，不新增**：claim 的文本必须来自原句，不允许模型「补充」没说过的事实。
 */

import { createHash } from 'node:crypto'
import { makeBigrams } from './store.js'

/** 显式要求记住。 */
const EXPLICIT = /(记住|记一下|记住这|别忘了|别忘记|要记得|请记)/
/** 偏好类。 */
const PREFERENCE = /(以后|之后|今后|从现在开始|每次|一律|都要|统一|优先|默认|不要|别用|禁止|避免|必须|只用|只认)/
/** 决策类。 */
const DECISION = /(决定|敲定|确定|采用|定下来|就这么|该用|改用|换成|先不|暂不|不切换|不升级|先保留)/
/** 事实类：含具体标识符或数值。 */
const FACT = /(\d{2,}|版本|端口|路径|配置|模型|接口|数据库|\.[a-z]{2,4}\b|[A-Za-z]:[\\/])/

/**
 * 切句：中英文句号、问号、换行、分号。
 * @param {string} text 原文。
 * @returns {string[]} 句子数组。
 */
function splitSentences(text) {
  return String(text ?? '')
    .split(/[。！？!?\n；;]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 6 && item.length <= 400)
}

/**
 * 归一化文本用于去重：只留中英文与数字，折叠空白。
 * @param {string} text 文本。
 * @returns {string} 归一化结果。
 */
function normalizeForHash(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 500)
}

/**
 * 计算 content_hash。
 * @param {string} scope 作用域。
 * @param {string} kind 类型。
 * @param {string} text 文本。
 * @returns {string} 十六进制摘要。
 */
export function contentHash(scope, kind, text) {
  return createHash('sha256').update(`${scope}\u0000${kind}\u0000${normalizeForHash(text)}`).digest('hex')
}

/**
 * 用规则从一轮对话里抽取候选 claim。
 *
 * **只从用户原话里抽**：助手说的话是「对我的复述」，把它当成记忆会污染事实源
 * （实测：助手回一句「已记住，并写进了…」就会被抽成一条高重要度的 fact）。
 * 助手的原文仍然完整保存在 `message` 表里，可被关键词检索到，只是不直接成为 claim。
 * @param {{scope:string, messages:Array<{role:string, text:string}>}} input 一轮的原文。
 * @returns {Array<{kind:string, text:string, basis:string, origin:string, importance:number, quote:string}>} 候选。
 */
export function extractByRules({ scope, messages }) {
  const candidates = []
  const seen = new Set()

  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const sentence of splitSentences(message.text)) {
      let kind = null
      let importance = 0.5

      if (EXPLICIT.test(sentence)) {
        kind = 'fact'
        importance = 0.85
      } else if (PREFERENCE.test(sentence)) {
        kind = 'preference'
        importance = 0.8
      } else if (DECISION.test(sentence)) {
        kind = 'decision'
        importance = 0.75
      } else if (FACT.test(sentence)) {
        kind = 'fact'
        importance = 0.55
      }

      if (kind === null) continue

      const hash = contentHash(scope, kind, sentence)
      if (seen.has(hash)) continue
      seen.add(hash)

      candidates.push({
        kind,
        text: sentence,
        basis: 'direct_report',
        origin: 'human_direct',
        importance,
        quote: sentence,
      })
    }
  }

  return candidates
}

/**
 * 把候选写入 claim 表（按 content_hash 去重），并返回真正新增的 id。
 * @param {object} db SQLite 连接。
 * @param {string} scope 作用域。
 * @param {string} sessionId 会话 id。
 * @param {number} turn 轮次。
 * @param {Array<object>} candidates 候选列表。
 * @param {number} nowTs 时间戳。
 * @returns {number[]} 新增的 claim id。
 */
export function persistClaims(db, scope, sessionId, turn, candidates, nowTs) {
  const insert = db.prepare(
    'insert or ignore into claim(scope, kind, text, basis, origin, claim_state, temporal, importance,'
    + ' source_message_id, created_at, updated_at, content_hash)'
    + " values(?, ?, ?, ?, ?, 'active', 'current', ?, ?, ?, ?, ?)"
  )
  const insertEvidence = db.prepare(
    'insert into evidence(claim_id, message_id, ref_type, quote, created_at) values(?, ?, ?, ?, ?)'
  )
  const findId = db.prepare('select id from claim where content_hash = ?')
  const insertFts = db.prepare('insert into claim_fts(rowid, bg) values(?, ?)')

  const created = []
  for (const candidate of candidates) {
    const hash = contentHash(scope, candidate.kind, candidate.text)
    const info = insert.run(
      scope, candidate.kind, candidate.text, candidate.basis, candidate.origin,
      candidate.importance, `${sessionId}:${turn}`, nowTs, nowTs, hash,
    )
    if (Number(info.changes) === 0) continue
    const row = findId.get(hash)
    const claimId = Number(row?.id ?? info.lastInsertRowid)
    created.push(claimId)
    insertEvidence.run(claimId, `${sessionId}:${turn}`, 'message', candidate.quote.slice(0, 400), nowTs)
    // 同步进关键词索引（中文 bigram）
    insertFts.run(claimId, makeBigrams(candidate.text))
  }
  return created
}
