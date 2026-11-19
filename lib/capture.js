/**
 * 采集层：把会话里「用户说的话」和「助手说的话」原样落库，并为每轮排一个抽取任务。
 *
 * 三条纪律（都是调研来的教训）：
 * 1. **只认 `source.kind === 'user'`** —— 插件注入的上下文（`plugin:*`）一律不捕获，
 *    否则记忆会自己喂自己。
 * 2. **不记工具输出、模型推理、subagent 会话** —— 「agent 读过什么，不是它该记住什么」。
 * 3. **先落原文再抽取** —— 原文写入是同步事务，抽取是后台任务；进程被杀也不丢原始记录。
 */

import { resolveScope } from './scope.js'

/** 单条消息保留的最大字符数；超出部分截断并标注。 */
const MAX_MESSAGE_CHARS = 20000

/**
 * 从 content 数组里取纯文本（忽略图片、工具块、推理块）。
 * @param {unknown} content 消息内容。
 * @param {string} role 角色，用于标注截断。
 * @returns {string} 文本。
 */
function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 截断超长文本，保留可读的结尾标注。 */
function clampText(text) {
  if (text.length <= MAX_MESSAGE_CHARS) return text
  return `${text.slice(0, MAX_MESSAGE_CHARS)}\n…（原文 ${text.length} 字符，已截断）`
}

/**
 * 创建采集器。
 * @param {{settings:object, db:object, logger?:object, now?:Function}} deps 依赖。
 * @returns {{onSessionEvent:Function, state:object}} 采集器。
 */
export function createCapture({ settings, db, logger, now = Date.now }) {
  const turnBySession = new Map()
  const state = { messages: 0, turnsQueued: 0, ignored: 0 }

  const insertMessage = db.prepare(
    'insert or ignore into message(scope, session_id, turn, message_id, role, text, created_at)'
    + ' values(?, ?, ?, ?, ?, ?, ?)'
  )
  const insertJob = db.prepare(
    'insert or ignore into job(kind, dedupe_key, payload, next_at, created_at) values(?, ?, ?, ?, ?)'
  )

  /**
   * 写入一条消息；重复（同 message_id）自动忽略。
   * @returns {boolean} 是否真的新增。
   */
  function persist(scope, sessionId, turn, messageId, role, text) {
    if (typeof messageId !== 'string' || messageId === '') return false
    const body = clampText(text)
    if (body === '') return false
    const info = insertMessage.run(scope, sessionId, turn, messageId, role, body, now())
    if (Number(info.changes) > 0) {
      state.messages++
      return true
    }
    return false
  }

  /**
   * 为某一轮排一个抽取任务；同一轮重复触发只排一次。
   */
  function enqueueTurn(scope, sessionId, turn) {
    const key = `extract:${scope}:${sessionId}:${turn}`
    const payload = JSON.stringify({ scope, sessionId, turn })
    const info = insertJob.run('extract', key, payload, now(), now())
    if (Number(info.changes) > 0) state.turnsQueued++
  }

  return {
    state,

    /**
     * `session/event` 的处理入口。
     * @param {object} session 会话对象（含 `header.cwd` / `id`）。
     * @param {object} event 会话事件（`{type, data, time}`）。
     */
    onSessionEvent(session, event) {
      if (process.env.MEMSF_DEBUG === '1') {
        console.error(`[dafa-fish-memory] event type=${String(event?.type)} session=${String(session?.id ?? '').slice(0, 8)} capture=${String(settings.autoCapture)}`)
      }
      if (!settings.autoCapture) return
      try {
        const sessionId = String(session?.id ?? '')
        if (sessionId === '') return
        const scope = resolveScope(settings, session?.header?.cwd)
        const type = event?.type

        if (type === 'turn/start') {
          const turn = Number(event?.data?.turn)
          if (Number.isFinite(turn)) turnBySession.set(sessionId, turn)
          return
        }

        if (type === 'user/message') {
          const message = event?.data
          // 只认用户本人发言；插件注入的 plugin:* 一律跳过
          if (message?.source?.kind !== 'user') {
            state.ignored++
            return
          }
          const turn = turnBySession.get(sessionId) ?? 0
          persist(scope, sessionId, turn, message?.id, 'user', textFromContent(message?.content))
          return
        }

        if (type === 'assistant/message') {
          const data = event?.data
          const turn = Number(data?.turn ?? 0)
          const message = data?.message
          if (message === null || typeof message !== 'object') return
          persist(scope, sessionId, turn, message?.id, 'assistant', textFromContent(message?.content))
          return
        }

        if (type === 'turn/end') {
          const turn = Number(event?.data?.turn ?? turnBySession.get(sessionId) ?? 0)
          enqueueTurn(scope, sessionId, turn)
          turnBySession.delete(sessionId)
          return
        }
      } catch (error) {
        // 采集失败绝不影响宿主
        logger?.warn?.(`dafa-fish-memory: 采集失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
