/**
 * dafa-fish-memory —— DSH 本地优先记忆插件（M0：骨架 + 自检）
 *
 * 硬约束（写在最前面，后面每个里程碑都不得违反）：
 * 1. 钩子里**绝不抛错**：pre-step 永远返回合法 decision，超时即跳过；
 * 2. 注入消息的 source 必须是 `plugin:dafa-fish-memory`（裸 `plugin` 会让宿主 fail-loud 退出）；
 * 3. 只捕获用户与助手的文本，不捕获工具输出、模型推理、subagent 会话；
 * 4. 模型名不得以 `Pro/` 开头（付费档）；
 * 5. `output.schema` 里不得出现任何 `required`（会让宿主启动失败）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { resolveSettings } from './config.js'
import { openStore } from './store.js'
import { buildDoctor, buildStats } from './doctor.js'
import { createCapture } from './capture.js'
import { createWorker } from './worker.js'
import { createRecaller } from './inject.js'
import { retrieve } from './retrieve.js'
import { resolveScope } from './scope.js'
import { confirmDeletion, lastUserText, reviseClaim, softDeleteClaim, writeClaim } from './mutate.js'
import { SKILL_BODY, SKILL_DESCRIPTION, SKILL_NAME } from './skill.js'
import { createLease } from './lease.js'
import { startViewer } from './viewer.js'
import { createVectorCache } from './vecache.js'
import { resolveTier } from './scale.js'
import { createDiag } from './diag.js'

export const name = 'dafa-fish-memory'

/** 需要 cordis 注入的服务；访问 ctx.tools / ctx.skills 前必须声明。 */
export const inject = ['tools', 'skills']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  home: Schema.string().default(''),
  storagePath: Schema.string().default(''),
  apiKey: Schema.string().default(''),
  apiBase: Schema.string().default('https://api.siliconflow.cn'),
  embeddingModel: Schema.string().default('BAAI/bge-m3'),
  embeddingDim: Schema.number().step(1).min(1).default(1024),
  rerankModel: Schema.string().default('BAAI/bge-reranker-v2-m3'),
  isolation: Schema.union(['workspace', 'global']).default('workspace'),
  scopeMapJson: Schema.string().default(''),
  autoRecall: Schema.boolean().default(true),
  autoCapture: Schema.boolean().default(true),
  extraction: Schema.union(['off', 'rules', 'llm']).default('rules'),
  extractionModel: Schema.string().default('Qwen/Qwen3-8B'),
  scaleTier: Schema.union(['auto', 'A', 'B', 'C']).default('auto'),
  recallTimeoutMs: Schema.number().min(500).max(30000).default(5000),
  contextMaxChars: Schema.number().min(256).max(20000).default(4000),
  maxItems: Schema.number().step(1).min(1).max(12).default(5),
  workerIntervalMs: Schema.number().min(500).max(60000).default(2000),
  viewerEnabled: Schema.boolean().default(true),
  viewerPort: Schema.number().step(1).min(1).max(65535).default(18181),
  logLevel: Schema.union(['silent', 'warn', 'info']).default('warn'),
})

/** 剔除值为 undefined 的键：DSH 会做严格 JSON 快照，undefined 可能导致校验失败。 */
function compact(value) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文。
 * @param {object} config 已按 Config 填好默认值的配置。
 * @returns {Promise<Function>} 清理函数。
 */
export async function apply(ctx, config) {
  if (config.enabled === false) {
    ctx.logger?.info?.('dafa-fish-memory: 已按配置禁用')
    return () => undefined
  }

  const settings = resolveSettings(config)
  const state = { startedAt: Date.now(), recallCount: 0, lastRecallAt: null }

  let store = null
  let startupError = null
  try {
    store = openStore(settings)
  } catch (error) {
    startupError = error instanceof Error ? error : new Error(String(error))
    ctx.logger?.warn?.(`dafa-fish-memory: 数据库打开失败，降级为空操作：${startupError.message}`)
  }

  ctx.tools.register(defineTool({
    name: 'memory_doctor',
    description: [
      '检查本地记忆插件是否正常工作：密钥是否被正确插值、向量接口是否可用、数据库可写性、',
      '记忆与向量条数、向量模型是否与配置一致、当前作用域与预算。',
      '排障时先调用它；加 probe=true 会真的请求一次 embeddings 接口确认 key 有效。'
    ].join(''),
    parameters: {
      probe: {
        type: 'boolean',
        description: '是否实测一次向量接口（会消耗一次免费额度，约 1 秒）。默认 false。',
      },
    },
    output: {
      // 注意：output.schema 里任何 required 都会让宿主启动失败，这里一律不写。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'string' },
          report: { type: 'string' },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.report ?? '') }],
    },
    async execute(args) {
      const result = await buildDoctor({
        settings,
        store,
        startupError,
        state,
        probe: args?.probe === true,
      })
      return compact(result)
    },
  }))

  ctx.logger?.info?.(
    `dafa-fish-memory: ready（db=${settings.storagePath}，scope=${settings.scopeMode}，`
    + `recall=${settings.autoRecall}，capture=${settings.autoCapture}，model=${settings.embeddingModel}@${settings.embeddingDim}）`
  )

  if (settings.problems.length > 0) {
    ctx.logger?.warn?.(`dafa-fish-memory: 启动自检发现 ${settings.problems.length} 个问题：${settings.problems.join('；')}`)
  }

  // ---- M1：采集 ----
  const disposers = []
  let worker = null
  let viewer = null
  if (store !== null) {
    try {
      const capture = createCapture({ settings, db: store, logger: ctx.logger })
      disposers.push(ctx.on('session/event', (session, event) => {
        capture.onSessionEvent(session, event)
      }))
      state.capture = capture.state

      // 诊断事件流：下次卡顿时能直接看出卡在哪一步
      const diag = createDiag({ path: settings.diagPath, logger: ctx.logger })
      state.diag = diag

      // 记忆规模分档：决定向量怎么存（float32 / int8）、召回怎么扫（全量 / 预筛）
      const vectorCount = Number(
        store.prepare('select count(*) c from vec where model = ?').get(settings.embeddingModel)?.c ?? 0
      )
      const tier = resolveTier(vectorCount, settings.scaleTier)
      state.tier = tier

      // 向量缓存：条数多时读一遍要几秒，放进内存后只剩纯计算。
      // 关键：预热放到下一个 tick，请求路径上只读内存、绝不触发全量加载
      const cache = createVectorCache(store, settings, { logger: ctx.logger, tier })
      state.vectorCache = cache
      cache.warmup()

      // ---- M2：后台 worker（抽取 + 嵌入），双端只允许一个写者 ----
      if (settings.autoCapture) {
        const lease = createLease({ path: settings.lockPath, logger: ctx.logger })
        worker = createWorker({ settings, db: store, logger: ctx.logger, lease, cache })
        worker.start()
        state.worker = worker.state
        state.lease = lease
      }

      // ---- M5：只读看板 ----
      viewer = startViewer({ settings, db: store, logger: ctx.logger })
      if (viewer !== null) state.viewerUrl = viewer.url

      // ---- M3：召回与注入 ----
      if (settings.autoRecall) {
        const recaller = createRecaller({ settings, db: store, logger: ctx.logger, state, cache, diag, tier })
        disposers.push(ctx.on('agent/pre-step', (payload, next) => recaller.beforeStep(payload, next)))
      }
    } catch (error) {
      // 采集/worker 起不来也不能让插件崩，宿主优先
      ctx.logger?.warn?.(`dafa-fish-memory: 采集层启动失败，插件降级为只读：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- 统计工具 ----
  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: '查看本地记忆的规模与构成：条数、类型分布、可信度分布、作用域分布、队列积压、最近写入的几条。'
      + '想回答「你记住了我多少东西」时用它。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.report ?? '') }],
    },
    async execute() {
      return buildStats({ settings, db: store, state })
    },
  }))

  // ---- 检索工具 ----
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: '在本地长期记忆里检索相关内容。每条结果带可信度标记：'
      + 'basis=direct_report 表示用户本人说过的话；derived_summary 表示这是总结，不能当作用户原话复述。'
      + '用户问「你记得我之前说过什么」时用它，不要凭对话上下文猜。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '检索词。用用户的原话或关键词效果最好；端口、错误码、文件名会走精确匹配。',
      },
      limit: {
        type: 'number',
        description: '最多返回几条，默认 5，上限 12。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'number' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.report ?? '') }],
    },
    async execute(args, exec) {
      if (store === null) return { ok: false, count: 0, report: '记忆库不可用，先跑 memory_doctor。' }
      const query = String(args?.query ?? '').trim()
      if (query === '') return { ok: false, count: 0, report: '缺少 query。' }
      const limit = Math.min(Math.max(Number(args?.limit ?? settings.maxItems), 1), 12)
      try {
        const cwd = exec?.agent?.session?.header?.cwd
        const scope = resolveScope(settings, cwd)
        const toolSettings = { ...settings, maxItems: limit }
        // 显式检索要能查到全部类型（含流程类 convention），所以 kinds 传 null
        const { hits, trace } = await retrieve({
          settings: toolSettings, db: store, query, scope, cache: state.vectorCache,
          kinds: null, tier: state.tier ?? null,
        })
        if (hits.length === 0) {
          return { ok: true, count: 0, report: `没有找到与「${query}」相关的记忆。（检索 ${trace.ms}ms）` }
        }
        const lines = [`找到 ${hits.length} 条（${trace.ms}ms，rerank=${trace.reranked ? '是' : '否'}）：`]
        hits.forEach((hit, index) => {
          const day = new Date(hit.createdAt).toISOString().slice(0, 10)
          lines.push(`${index + 1}. [${hit.basis} · ${day} · ${hit.kind}] ${hit.text}`)
        })
        return { ok: true, count: hits.length, report: lines.join('\n') }
      } catch (error) {
        return { ok: false, count: 0, report: `检索失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))

  // ---- 写入工具 ----
  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: '把一条值得长期记住的事实/偏好/决策显式保存到本地记忆。'
      + '只在用户明确要求记住、或给出明确长期偏好与决定时使用；不要用它保存临时状态或聊天摘要。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '要记住的内容。用用户的原话或精炼后的一句话，保留路径、端口、数字等字面值。',
      },
      kind: {
        type: 'string',
        enum: ['preference', 'decision', 'fact', 'convention'],
        description: '类型：preference 偏好、decision 决定、fact 事实、convention 约定。默认 fact。',
      },
      importance: {
        type: 'number',
        description: '重要度 0~1，默认 0.8。用户强调过、影响后续行为的给高一些。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'number' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.report ?? '') }],
    },
    async execute(args, exec) {
      if (store === null) return { ok: false, report: '记忆库不可用。' }
      const text = String(args?.text ?? '').trim()
      if (text === '') return { ok: false, report: 'text 不能为空。' }
      try {
        const cwd = exec?.agent?.session?.header?.cwd
        const scope = resolveScope(settings, cwd)
        const result = writeClaim(store, {
          scope,
          kind: String(args?.kind ?? 'fact'),
          text,
          importance: Number(args?.importance ?? 0.8),
          sessionId: String(exec?.agent?.session?.id ?? ''),
          turn: 0,
          nowTs: Date.now(),
        })
        if (!result.ok) return { ok: false, report: `保存失败：${result.error}` }
        return {
          ok: true,
          id: result.id,
          report: result.duplicate
            ? `这条记忆已经存在（id=${result.id}），没有重复写入。`
            : `已保存（id=${result.id}）：${text}`,
        }
      } catch (error) {
        return { ok: false, report: `保存失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))

  // ---- 遗忘 / 纠正 ----
  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: '删除或纠正一条记忆。**只有用户在当前会话里明确要求时才可调用**——'
      + '工具会核对用户最新一条消息，含「删掉/忘掉/改成」并指明目标（id 或关键词）才执行，否则拒绝。',
    parameters: {
      id: {
        type: 'number',
        required: true,
        description: '要处理的记忆 id（用 memory_search 拿到的编号）。',
      },
      mode: {
        type: 'string',
        enum: ['delete', 'revise'],
        description: 'delete 删除；revise 改成新的说法（需要同时给 new_text）。',
      },
      new_text: {
        type: 'string',
        description: 'mode=revise 时的新内容。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.report ?? '') }],
    },
    async execute(args, exec) {
      if (store === null) return { ok: false, report: '记忆库不可用。' }
      const id = Number(args?.id)
      if (!Number.isInteger(id) || id <= 0) return { ok: false, report: 'id 必须是正整数。' }
      const mode = String(args?.mode ?? 'delete')
      const userText = lastUserText(exec?.agent)
      const targetRow = store.prepare('select id, text from claim where id = ? and deleted_at is null').get(id)
      if (targetRow === undefined) return { ok: false, report: `没有找到 id=${id} 的记忆。` }

      const guard = confirmDeletion(userText, { id, text: String(targetRow.text) })
      if (!guard.allowed) return { ok: false, report: `已拒绝：${guard.reason}` }

      try {
        if (mode === 'revise') {
          if (String(args?.new_text ?? '').trim() === '') return { ok: false, report: 'revise 需要给出 new_text。' }
          const result = reviseClaim(store, { id, text: String(args?.new_text ?? ''), nowTs: Date.now() })
          if (!result.ok) return { ok: false, report: `纠正失败：${result.error}` }
          return { ok: true, report: `已改成新版本（新 id=${result.newId}），旧版本保留为历史。` }
        }
        const removed = softDeleteClaim(store, id, Date.now())
        if (!removed.ok) return { ok: false, report: `删除失败：${removed.error}` }
        return { ok: true, report: `已删除 id=${id}。原文仍保留在原文表里，但不再参与召回。` }
      } catch (error) {
        return { ok: false, report: `操作失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))

  // ---- 技能：教模型什么时候写、怎么写、结果怎么用 ----
  try {
    ctx.skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      // source 必须是字符串，否则真正加载技能正文时会报
      // `loaded skill "xxx" source must be a string`
      source: `plugin:${name}`,
      content: SKILL_BODY,
    })
  } catch (error) {
    ctx.logger?.warn?.(`dafa-fish-memory: 技能注册失败（不影响记忆功能）：${error instanceof Error ? error.message : String(error)}`)
  }

  return () => {
    try {
      viewer?.close()
    } catch {
      /* 看板关闭失败不影响退出 */
    }
    try {
      worker?.stop()
    } catch {
      /* 停表失败不影响退出 */
    }
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载失败不影响进程退出 */
      }
    }
    try {
      store?.close()
    } catch {
      /* 关闭失败不影响进程退出 */
    }
  }
}
