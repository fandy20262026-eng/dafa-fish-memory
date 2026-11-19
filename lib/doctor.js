/**
 * 自检：把「记忆到底有没有在工作」拆成可读的检查项。
 *
 * 三态定义（借 scope-recall）：
 * - `ok`        没有需要处理的问题；
 * - `attention` 有告警但可用（例如模型名被回退过）；
 * - `degraded`  必须处理（没有 key、库不可写、配置非法）。
 */

import { statSync } from 'node:fs'
import { maskKey, probeEmbedding } from './api.js'
import { counts, getMeta, pingWrite } from './store.js'
import { SCHEMA_VERSION } from './store.js'

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 生成记忆统计（给 `memory_stats` 工具）。
 * @param {{settings:object, db:object, state:object}} input 输入。
 * @returns {{ok:boolean, report:string}} 统计。
 */
export function buildStats(input) {
  const { settings, db, state } = input
  if (db === null) return { ok: false, report: '数据库不可用，先跑 memory_doctor。' }
  try {
    const lines = []
    const one = (sql, ...args) => Number(db.prepare(sql).get(...args)?.c ?? 0)

    const totalClaims = one('select count(*) c from claim where deleted_at is null')
    const totalMessages = one('select count(*) c from message')
    const totalVectors = one('select count(*) c from vec where model = ?', settings.embeddingModel)
    lines.push(`记忆：${totalClaims} 条｜原文：${totalMessages} 条｜向量：${totalVectors} 条（${settings.embeddingModel}）`)

    const kinds = db.prepare(
      'select kind, count(*) c from claim where deleted_at is null group by kind order by c desc'
    ).all()
    if (kinds.length > 0) {
      lines.push(`类型：${kinds.map(row => `${row.kind} ${row.c}`).join(' / ')}`)
    }

    const bases = db.prepare(
      'select basis, count(*) c from claim where deleted_at is null group by basis order by c desc'
    ).all()
    if (bases.length > 0) {
      lines.push(`可信度：${bases.map(row => `${row.basis} ${row.c}`).join(' / ')}`)
    }

    const scopes = db.prepare(
      'select scope, count(*) c from claim where deleted_at is null group by scope order by c desc limit 8'
    ).all()
    if (scopes.length > 0) {
      lines.push('作用域：')
      for (const row of scopes) lines.push(`  ${row.scope} → ${row.c}`)
    }

    const pending = one('select count(*) c from job')
    const deadNote = state?.worker?.lastError ? `，最近错误：${state.worker.lastError}` : ''
    lines.push(`队列：${pending} 个待处理${deadNote}`)

    const recent = db.prepare(
      'select kind, basis, text, created_at from claim where deleted_at is null order by id desc limit 5'
    ).all()
    if (recent.length > 0) {
      lines.push('最近写入：')
      for (const row of recent) {
        const day = new Date(Number(row.created_at)).toISOString().slice(0, 10)
        lines.push(`  · [${row.kind}/${row.basis}] ${String(row.text).slice(0, 60)}（${day}）`)
      }
    }

    return { ok: true, report: lines.join('\n') }
  } catch (error) {
    return { ok: false, report: `统计失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 生成自检报告。
 * @param {{settings:object, store:object|null, startupError:Error|null, state:object, probe?:boolean, signal?:AbortSignal}} input 输入。
 * @returns {Promise<{ok:boolean,status:string,report:string,hint:string}>} 报告。
 */
export async function buildDoctor(input) {
  const { settings, store, startupError, state, probe = false, signal } = input
  const lines = []
  const fatal = []
  const attention = []

  // 1) 启动问题
  for (const problem of settings.problems ?? []) {
    fatal.push(problem)
    lines.push(`✗ 配置：${problem}`)
  }
  if ((settings.problems ?? []).length === 0) lines.push('✓ 配置：密钥已插值，模型为免费档')

  // 2) 库
  if (startupError) {
    fatal.push(`数据库打开失败：${startupError.message}`)
    lines.push(`✗ 数据库：${startupError.message}`)
  } else if (store === null) {
    fatal.push('数据库未初始化')
    lines.push('✗ 数据库：未初始化')
  } else {
    const ping = pingWrite(store)
    if (!ping.ok) {
      fatal.push(`数据库不可写：${ping.error}`)
      lines.push(`✗ 数据库：不可写（${ping.error}）`)
    } else {
      const c = counts(store)
      lines.push(`✓ 数据库：${settings.storagePath}（${mb(fileSize(settings.storagePath))}）`)
      lines.push(`  schema v${getMeta(store, 'schema_version') ?? '?'}（期望 v${SCHEMA_VERSION}）｜原文 ${c.messages} 条｜记忆 ${c.claims} 条｜向量 ${c.vectors} 条｜任务 ${c.jobs} 条`)
      const activeModel = getMeta(store, 'active_model')
      const activeDim = getMeta(store, 'active_dim')
      lines.push(`  当前向量模型：${activeModel}（${activeDim} 维）`)
      if (activeModel !== settings.embeddingModel) {
        attention.push('库里的向量模型与配置不一致，需要重嵌（memory_reembed）')
        lines.push(`  ⚠ 配置是 ${settings.embeddingModel}，与库里的 ${activeModel} 不一致 → 需要重嵌`)
      }
      // 规模档位：告诉用户现在用的是哪种召回策略、离下一档还有多远
      const tier = state?.tier
      if (tier) {
        const storage = state?.vectorCache?.storageMode?.() ?? '?'
        const nextText = tier.nextAt === null ? '已是最高档' : `到 ${tier.nextAt} 条升 B 档`
        lines.push(`  规模档位：${tier.id} 档（${tier.label}，${storage}，${tier.memoryHint}）｜${nextText}`)
      }
    }
  }

  // 3) 模式
  lines.push(`✓ 作用域：${settings.scopeMode}${settings.scopeMode === 'workspace' ? '（按工作区隔离）' : '（跨工作区共享）'}`)
  lines.push(`✓ 召回：${settings.autoRecall ? `开启，超时 ${settings.recallTimeoutMs}ms，最多 ${settings.maxItems} 条 / ${settings.contextMaxChars} 字符` : '关闭'}`)
  lines.push(`✓ 采集：${settings.autoCapture ? '开启' : '关闭'}｜抽取：${settings.extraction}`)
  lines.push(`✓ 看板：${settings.viewerEnabled ? `http://127.0.0.1:${settings.viewerPort}` : '关闭'}`)
  lines.push(`✓ 模型：${settings.embeddingModel}（${settings.embeddingDim} 维）+ ${settings.rerankModel}`)
  lines.push(`✓ 密钥：${maskKey(settings.apiKey)}`)

  // 4) 可选：真的打一次 API
  if (probe) {
    if (!settings.apiKey) {
      lines.push('✗ 探测：跳过（没有 key）')
    } else {
      const result = await probeEmbedding(settings, { signal, timeoutMs: 8000 })
      if (result.ok) {
        lines.push(`✓ 探测：embeddings 返回 200，${result.dim} 维（${result.ms}ms）`)
        if (result.dim !== settings.embeddingDim) {
          attention.push(`接口返回 ${result.dim} 维，与配置的 ${settings.embeddingDim} 不符`)
          lines.push(`  ⚠ 接口维度 ${result.dim} ≠ 配置维度 ${settings.embeddingDim}`)
        }
      } else {
        fatal.push(`embeddings 不可用：${result.error}`)
        lines.push(`✗ 探测：${result.error}（${result.ms}ms）`)
      }
    }
  } else {
    lines.push('· 探测：未执行（加 probe=true 可实测接口）')
  }

  // 5) 运行态
  if (state && Number.isFinite(state.recallCount)) {
    lines.push(`· 本次运行：注入 ${state.recallCount} 次，最近一次 ${state.lastRecallAt ? new Date(state.lastRecallAt).toLocaleString() : '无'}`)
  }
  if (state?.capture) {
    lines.push(`· 本次运行：采集 ${state.capture.messages} 条原文，排入 ${state.capture.turnsQueued} 轮抽取任务`)
  }

  const status = fatal.length > 0 ? 'degraded' : attention.length > 0 ? 'attention' : 'ok'
  const hint = status === 'ok'
    ? '一切正常。'
    : status === 'attention'
      ? `可用，但有需要注意的地方：\n- ${attention.join('\n- ')}`
      : `不可用，先修这些：\n- ${fatal.join('\n- ')}`

  return {
    ok: status !== 'degraded',
    status,
    report: lines.join('\n'),
    hint,
  }
}
