/**
 * LLM 抽取：把一轮对话压成「可验证的陈述」。
 *
 * 核心防幻觉设计：**要求模型同时给出 `quote`（原文引用），我们校验它确实是用户原话的子串**。
 * 不是子串就丢弃该条——这条硬约束比任何提示词都管用。
 *
 * 提示词用的是 hindsight 的「史官契约」：
 * - 只报过去式、可归属的事实，不写「你应该做 X」；
 * - 字面值（路径/端口/版本/阈值）必须逐字复现；
 * - 报决策与理由，不报当前实现；
 * - 宁可少记，也不要用沾边的猜测填空。
 */

import { fetchWithDeadline, describeError } from './api.js'

const SYSTEM_PROMPT = `你的工作是**挑选**，不是改写。

从用户这段话里，挑出值得长期记住的句子。严格规则：

1. 只挑**用户本人陈述**的事实、偏好、决定、约定；寒暄、临时问题、一次性操作不要。
2. **text 必须逐字取自用户原话的连续片段**，一个字都不要改、不要概括、不要补全。
   （这是硬要求：我们会校验 text 确实是原文子串，不是就丢弃。）
3. 字面值（路径、端口、版本号、账号、阈值、命令）必须原样保留。
4. **不要写成祈使句**，也不要加「用户要求」这类前缀——原话是什么就记什么。
5. **宁缺毋滥**：没有值得记的就返回空数组。

只输出 JSON，不要解释、不要代码围栏。格式：
{"memories":[{"kind":"preference|decision|fact|convention","text":"逐字取自原文的片段","importance":0.0-1.0}]}`

/**
 * 从模型输出里提取 JSON（容忍 ```json 围栏和前后废话）。
 * @param {string} raw 原始输出。
 * @returns {object|null} 解析结果。
 */
export function parseJsonLoose(raw) {
  if (typeof raw !== 'string') return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? raw).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 归一化文本用于子串校验：去掉空白与标点差异。 */
function squash(text) {
  return String(text ?? '').replace(/[\s\u3000]+/g, '').replace(/[，。；：、！？""''（）()《》【】]/g, '')
}

/**
 * 调一次 chat 接口。
 * @returns {Promise<{ok:boolean, content?:string, error?:string}>} 结果。
 */
async function chatOnce(settings, userText, { signal, timeoutMs }) {
  try {
    const response = await fetchWithDeadline(`${settings.apiBase}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.extractionModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText },
        ],
        temperature: 0.2,
        max_tokens: 800,
      }),
    }, { signal, timeoutMs })
    const raw = await response.text()
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}：${raw.slice(0, 160).replace(/\s+/g, ' ')}` }
    const data = JSON.parse(raw)
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim() === '') return { ok: false, error: '模型返回空内容' }
    return { ok: true, content }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

const VALID_KIND = new Set(['preference', 'decision', 'fact', 'convention'])

/**
 * 用 LLM 从一轮对话里抽取候选 claim。
 * @param {{settings:object, messages:Array<{role:string, text:string}>, signal?:AbortSignal, timeoutMs?:number}} input 输入。
 * @returns {Promise<Array<object>|null>} 候选；调用失败返回 null（调用方回退规则抽取）。
 */
export async function extractWithLlm({ settings, messages, signal, timeoutMs = 20000 }) {
  const userText = messages
    .filter(message => message.role === 'user')
    .map(message => message.text)
    .join('\n\n')
    .slice(0, 6000)
  if (userText.trim() === '') return []
  if (!settings.apiKey || !settings.extractionModel) return null

  const result = await chatOnce(settings, userText, { signal, timeoutMs })
  if (!result.ok) return null

  const parsed = parseJsonLoose(result.content)
  if (parsed === null || !Array.isArray(parsed.memories)) return []

  const haystack = squash(userText)
  const out = []
  const seen = new Set()
  for (const item of parsed.memories) {
    if (item === null || typeof item !== 'object') continue
    const kind = String(item.kind ?? '').toLowerCase()
    const text = String(item.text ?? '').trim()
    if (!VALID_KIND.has(kind)) continue
    if (text.length < 4 || text.length > 300) continue
    // 硬约束：记忆正文必须逐字出自用户原话（防改写、防编造）
    if (!haystack.includes(squash(text))) continue
    const importance = Number(item.importance)
    if (seen.has(text)) continue
    seen.add(text)
    out.push({
      kind,
      text,
      basis: 'direct_report',
      origin: 'human_direct',
      importance: Number.isFinite(importance) ? Math.min(1, Math.max(0.2, importance)) : 0.7,
      quote: text,
    })
    if (out.length >= 4) break
  }
  return out
}
