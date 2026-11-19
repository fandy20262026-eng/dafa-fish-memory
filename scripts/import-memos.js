/**
 * 把 memos 的历史记忆导入 dafa-fish-memory。
 *
 * 重要设计：
 * 1. **只读**打开 memos 的库（`readOnly: true`），绝不修改它。
 * 2. 导入的东西**一律标 `derived_summary`** —— memos 的 summary / policy 都是它自己总结的，
 *    不是用户原话。标成 `direct_report` 会让新插件把二手结论当成用户说过的话。
 * 3. 按「来源 id + 文本」做 `content_hash` 去重，脚本可以重复跑而不会重复导入。
 * 4. 嵌入分批进行，失败不中断（没嵌进向量的条目仍可被关键词检索，之后 worker 会补）。
 *
 * 用法：
 *   node scripts/import-memos.js --source <memos.db> [--limit N] [--dry-run] [--scope global]
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

import { resolveSettings } from '../lib/config.js'
import { openStore, makeBigrams } from '../lib/store.js'
import { embedClaims } from '../lib/embed.js'

const argv = process.argv.slice(2)
function arg(name, fallback = undefined) {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

const sourcePath = arg('source', '')
const limit = Number(arg('limit', '0')) || 0
const dryRun = arg('dry-run', false) === true
const scope = String(arg('scope', 'global'))
const skipPolicies = arg('skip-policies', false) === true

if (sourcePath === '' || sourcePath === true) {
  console.error([
    '用法：node scripts/import-memos.js --source <memos.db> [--limit N] [--dry-run] [--scope global]',
    '',
    'memos.db 是旧插件 @memtensor/memos-local-plugin 的数据库，通常在：',
    '  <DSH_HOME>\\memos-plugin\\data\\memos.db',
    '这个脚本只读它，不会修改原库。',
  ].join('\n'))
  process.exit(2)
}

const settings = resolveSettings({ embeddingDim: 1024 })
console.log(`目标库：${settings.storagePath}`)
console.log(`来源库：${sourcePath}（只读）`)
console.log(`模式：${dryRun ? '演练（不写入）' : '实际写入'}｜scope=${scope}｜上限=${limit || '全部'}`)

const source = new DatabaseSync(sourcePath, { readOnly: true })
const target = dryRun ? null : openStore(settings)

function hashOf(...parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

const insertClaim = target?.prepare(
  'insert or ignore into claim(scope,kind,text,basis,origin,claim_state,temporal,importance,'
  + 'source_message_id,created_at,updated_at,content_hash)'
  + " values(?,?,?,?,'memos-import','active','current',?,?,?,?,?)"
)
const insertFts = target?.prepare('insert into claim_fts(rowid, bg) values(?, ?)')
const insertEvidence = target?.prepare(
  'insert into evidence(claim_id, message_id, ref_type, quote, created_at) values(?, ?, ?, ?, ?)'
)
const findId = target?.prepare('select id from claim where content_hash = ?')

let imported = 0
let skipped = 0
const created = []

function importOne({ kind, text, importance, refType, refId, quote, createdAt }) {
  const body = String(text ?? '').trim()
  if (body === '') {
    skipped++
    return
  }
  const hash = hashOf('memos', refType, refId, body.slice(0, 120))
  if (dryRun) {
    imported++
    return
  }
  const info = insertClaim.run(
    scope, kind, body, 'derived_summary', importance,
    `${refType}:${refId}`, createdAt, createdAt, hash,
  )
  if (Number(info.changes) === 0) {
    skipped++
    return
  }
  imported++
  const row = findId.get(hash)
  const claimId = Number(row?.id ?? info.lastInsertRowid)
  insertFts.run(claimId, makeBigrams(body))
  insertEvidence.run(claimId, `${refType}:${refId}`, refType, String(quote ?? body).slice(0, 400), createdAt)
  created.push({ id: claimId, text: body })
}

// ---- 1) traces → turn_summary ----
const traceSql = 'select id, ts, summary, user_text from traces where summary is not null order by ts asc'
const traces = limit > 0
  ? source.prepare(`${traceSql} limit ?`).all(limit)
  : source.prepare(traceSql).all()
console.log(`\ntraces 可导入：${traces.length} 条`)
for (const trace of traces) {
  const summary = String(trace.summary ?? '').trim()
  if (summary === '') {
    skipped++
    continue
  }
  // 含「决定/切换/禁止」这类词的摘要价值更高
  const importance = /决定|切换|禁止|必须|改用|确定|方案/.test(summary) ? 0.68 : 0.5
  importOne({
    kind: 'turn_summary',
    text: summary,
    importance,
    refType: 'memos-trace',
    refId: String(trace.id),
    quote: summary,
    createdAt: Number(trace.ts) || Date.now(),
  })
}

// ---- 2) policies → convention ----
if (!skipPolicies) {
  const policySql = 'select id, title, trigger, procedure, verification, boundary, created_at from policies order by created_at asc'
  let policies = []
  try {
    policies = source.prepare(policySql).all()
  } catch (error) {
    console.log(`policies 跳过：${error.message}`)
  }
  console.log(`policies 可导入：${policies.length} 条`)
  for (const policy of policies) {
    const parts = []
    if (policy.trigger) parts.push(`触发：${policy.trigger}`)
    if (policy.procedure) parts.push(`做法：${policy.procedure}`)
    if (policy.verification) parts.push(`验证：${policy.verification}`)
    if (policy.boundary) parts.push(`边界：${policy.boundary}`)
    const text = `${policy.title ?? ''}｜${parts.join('；')}`.trim()
    importOne({
      kind: 'convention',
      text,
      importance: 0.7,
      refType: 'memos-policy',
      refId: String(policy.id),
      quote: text,
      createdAt: Number(policy.created_at) || Date.now(),
    })
  }
}

console.log(`\n写入：${imported} 条新增｜跳过（重复或空）：${skipped} 条`)
source.close()

if (dryRun) {
  console.log('（演练模式，未写入任何数据）')
  process.exit(0)
}

// ---- 3) 嵌入（分批，失败不中断）----
// 一次取全量待嵌条目：分页上限太小会导致「导入了但没向量」，用户以为记忆不可用
const missing = target.prepare(
  'select c.id, c.text from claim c left join vec v on v.claim_id = c.id and v.model = ?'
  + ' where v.claim_id is null and c.deleted_at is null limit 50000'
).all(settings.embeddingModel)

if (missing.length === 0) {
  console.log('没有待嵌入的条目。')
} else if (settings.apiKey === '') {
  console.log(`\n没有密钥，跳过嵌入（${missing.length} 条待补，后台 worker 会在配置密钥后补上）`)
} else {
  console.log(`\n开始嵌入 ${missing.length} 条…`)
  const CHUNK = 64
  let done = 0
  let failed = 0
  for (let i = 0; i < missing.length; i += CHUNK) {
    const batch = missing.slice(i, i + CHUNK).map(row => ({ id: Number(row.id), text: row.text }))
    const result = await embedClaims(target, settings, batch)
    if (result.ok) {
      done += result.embedded
      console.log(`  进度 ${Math.min(i + CHUNK, missing.length)}/${missing.length}`)
    } else {
      failed += batch.length
      console.log(`  批次失败（继续）：${result.error}`)
    }
  }
  console.log(`嵌入完成：${done} 条成功，${failed} 条失败`)
}

const summary = target.prepare('select count(*) c from claim where deleted_at is null').get()
console.log(`\n库内现在共有 ${summary.c} 条记忆。`)
target.close()
