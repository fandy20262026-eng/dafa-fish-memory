/**
 * 写操作：显式保存、遗忘、纠正。
 *
 * 这三件事必须**绑定到具体会话**：DSH 的 MCP 路线做不到这一点，所以 scope-recall 在 dsh 上
 * 只敢开放只读工具。我们是原生插件，`exec.agent.session` 可读，因此可以校验
 * 「用户在当前会话里是否真的要求过」——这是写操作安全的关键。
 */

import { contentHash } from './extract.js'
import { makeBigrams } from './store.js'

/** 用户明确表达「删掉 / 忘掉」的说法。 */
const DELETE_INTENT = /(删掉|删除|忘掉|忘记|不要再记|别记|不要记|清除|移除|forget|delete)/i
/** 用户明确表达「改掉 / 更正」的说法。 */
const REVISE_INTENT = /(改成|改为|更正|纠正|换成|不对|不是这样的|应该说|改为|更正为)/

/**
 * 取一段消息的纯文本。
 * @param {unknown} content 消息内容。
 * @returns {string} 文本。
 */
export function textOf(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * 取当前会话里用户最后一条真实发言（排除插件注入）。
 * @param {object|undefined} agent 执行上下文里的 agent。
 * @returns {string} 文本；取不到返回空串。
 */
export function lastUserText(agent) {
  const session = agent?.session
  if (session === undefined || typeof session.deriveMessages !== 'function') return ''
  let messages = []
  try {
    messages = session.deriveMessages()
  } catch {
    return ''
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.source?.kind !== 'user') continue
    const text = textOf(message.content)
    if (text !== '') return text
  }
  return ''
}

/**
 * 判断用户最新发言是否明确要求删除某条记忆。
 * @param {string} userText 用户最新发言。
 * @param {{id?:number, query?:string, text?:string}} target 目标。
 * @returns {{allowed:boolean, reason:string}} 判定结果。
 */
export function confirmDeletion(userText, target) {
  if (userText === '') return { allowed: false, reason: '拿不到你最新的发言，无法确认是否要删除' }
  if (!DELETE_INTENT.test(userText)) {
    return { allowed: false, reason: '你这条消息没有明确说要删除记忆；请直接说「删掉第 N 条」或「删掉关于 X 的记忆」' }
  }
  const idText = target.id === undefined ? '' : String(target.id)
  const mentionsId = idText !== '' && new RegExp(`(^|\\D)${idText}(\\D|$)`).test(userText)
  const keyword = String(target.query ?? '').trim() || String(target.text ?? '').slice(0, 6)
  const mentionsKeyword = keyword !== '' && userText.includes(keyword.slice(0, 4))
  if (!mentionsId && !mentionsKeyword) {
    return { allowed: false, reason: '说了要删，但没指明删哪一条（给出 id 或记忆里的关键词）' }
  }
  return { allowed: true, reason: 'ok' }
}

/**
 * 写入一条显式记忆。
 * @param {object} db SQLite 连接。
 * @param {{scope:string, kind:string, text:string, importance?:number, sessionId?:string, turn?:number, nowTs:number}} input 输入。
 * @returns {{ok:boolean, id?:number, duplicate?:boolean, error?:string}} 结果。
 */
export function writeClaim(db, input) {
  const text = String(input.text ?? '').trim()
  if (text === '') return { ok: false, error: 'text 不能为空' }
  const kind = String(input.kind ?? 'fact')
  const importance = Number.isFinite(input.importance) ? input.importance : 0.8
  const hash = contentHash(input.scope, kind, text)
  const existing = db.prepare('select id from claim where content_hash = ? and deleted_at is null').get(hash)
  if (existing !== undefined) return { ok: true, id: Number(existing.id), duplicate: true }

  const info = db.prepare(
    'insert into claim(scope,kind,text,basis,origin,claim_state,temporal,importance,source_message_id,'
    + 'created_at,updated_at,content_hash)'
    + " values(?,?,?,'direct_report','human_direct','active','current',?,?,?,?,?)"
  ).run(input.scope, kind, text, importance, `${input.sessionId ?? ''}:${input.turn ?? 0}`, input.nowTs, input.nowTs, hash)
  const id = Number(info.lastInsertRowid)
  db.prepare('insert into claim_fts(rowid, bg) values(?, ?)').run(id, makeBigrams(text))
  return { ok: true, id }
}

/**
 * 软删除一条记忆（可恢复 7 天，物理行保留）。
 * @param {object} db SQLite 连接。
 * @param {number} id claim id。
 * @param {number} nowTs 时间戳。
 * @returns {{ok:boolean, error?:string}} 结果。
 */
export function softDeleteClaim(db, id, nowTs) {
  const row = db.prepare('select id from claim where id = ? and deleted_at is null').get(id)
  if (row === undefined) return { ok: false, error: `没有找到 id=${id} 的记忆` }
  db.prepare('update claim set deleted_at = ?, claim_state = ?, updated_at = ? where id = ?')
    .run(nowTs, 'retracted', nowTs, id)
  // 从关键词索引里移除，避免还能被搜到
  try {
    db.prepare('delete from claim_fts where rowid = ?').run(id)
  } catch {
    /* FTS 删除失败不影响主流程，召回时会按 deleted_at 过滤 */
  }
  return { ok: true }
}

/**
 * 纠正一条记忆：写新版本，把旧的标记为被取代（保留历史）。
 * @param {object} db SQLite 连接。
 * @param {{id:number, text:string, nowTs:number}} input 输入。
 * @returns {{ok:boolean, newId?:number, error?:string}} 结果。
 */
export function reviseClaim(db, { id, text, nowTs }) {
  const row = db.prepare('select id, scope, kind, importance from claim where id = ? and deleted_at is null').get(id)
  if (row === undefined) return { ok: false, error: `没有找到 id=${id} 的记忆` }
  const newText = String(text ?? '').trim()
  if (newText === '') return { ok: false, error: '没有给出新的说法' }
  const hash = contentHash(String(row.scope), String(row.kind), newText)
  const info = db.prepare(
    'insert into claim(scope,kind,text,basis,origin,claim_state,temporal,importance,superseded_by,'
    + 'created_at,updated_at,content_hash)'
    + " values(?,?,?,'direct_report','human_direct','active','current',?,NULL,?,?,?)"
  ).run(row.scope, row.kind, newText, Number(row.importance), nowTs, nowTs, hash)
  const newId = Number(info.lastInsertRowid)
  db.prepare('insert into claim_fts(rowid, bg) values(?, ?)').run(newId, makeBigrams(newText))
  db.prepare("update claim set claim_state = 'superseded', superseded_by = ?, updated_at = ? where id = ?")
    .run(newId, nowTs, id)
  return { ok: true, newId }
}
