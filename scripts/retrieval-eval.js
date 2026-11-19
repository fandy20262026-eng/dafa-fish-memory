/**
 * 召回质量回放：造一批贴近真实的记忆，用真实 query 检索，看目标条目是否进 top3。
 * 用法：node scripts/retrieval-eval.js
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveSettings } from '../lib/config.js'
import { openStore, makeBigrams } from '../lib/store.js'
import { embedClaims } from '../lib/embed.js'
import { contentHash } from '../lib/extract.js'
import { retrieve } from '../lib/retrieve.js'

const MEMORIES = [
  { key: 'pref-table', kind: 'preference', text: '用户要求回答优先给表格，少用表情符号' },
  { key: 'mem-rollback', kind: 'decision', text: '记忆插件暂不切换，11 月底再复查一次' },
  { key: 'dsh-ver', kind: 'fact', text: 'DSH 当前版本是 0.2.1-rc.2，构建号 687f282' },
  { key: 'db-size', kind: 'fact', text: 'memos 数据库 214 MB，hindsight 数据目录 988 MB' },
  { key: 'bypass', kind: 'fact', text: '旁路验证实例跑在端口 18199' },
  { key: 'stock-acct', kind: 'decision', text: '股票库同步必须用 stock_rw 账号，禁止使用 root' },
  { key: 'bili-dep', kind: 'fact', text: 'bilibili 视频插件需要 yt-dlp 和 ffmpeg 两个外部依赖' },
  { key: 'theme', kind: 'preference', text: '用户偏好深色主题，不要浅色背景' },
  { key: 'profiles', kind: 'fact', text: 'web profile 装了 memos，desktop profile 装了 hindsight' },
  { key: 'sandbox', kind: 'fact', text: '沙箱拒绝写工作区之外的路径时，需要申请更大权限' },
]

const CASES = [
  { query: '我应该怎么回答你', expect: 'pref-table' },
  { query: '记忆插件什么时候复查', expect: 'mem-rollback' },
  { query: '现在 DSH 什么版本', expect: 'dsh-ver' },
  { query: '股票数据库用哪个账号', expect: 'stock-acct' },
  { query: '18199', expect: 'bypass' },
  { query: '两个数据库各占多大空间', expect: 'db-size' },
  { query: '装视频插件缺什么依赖', expect: 'bili-dep' },
  { query: '你记得我喜欢什么界面风格', expect: 'theme' },
]

const root = mkdtempSync(join(tmpdir(), 'memory-sf-eval-'))
const settings = resolveSettings({ home: root, embeddingDim: 1024 })
const db = openStore(settings)
const scope = 'workspace:c:/users/user/system'
const now = Date.now()

console.log(`\n建库：${settings.storagePath}`)
console.log(`密钥：${settings.apiKey ? '已配置' : '缺失（会退化为纯关键词）'}`)

// 1) 写入记忆
const insert = db.prepare(
  'insert into claim(scope,kind,text,basis,origin,claim_state,temporal,importance,created_at,updated_at,content_hash)'
  + " values(?,?,?,'direct_report','human_direct','active','current',?,?,?,?)"
)
const insertFts = db.prepare('insert into claim_fts(rowid, bg) values(?, ?)')
const ids = new Map()
for (const memory of MEMORIES) {
  const info = insert.run(scope, memory.kind, memory.text, 0.7, now - Math.random() * 30 * 86_400_000, now, contentHash(scope, memory.kind, memory.text))
  const id = Number(info.lastInsertRowid)
  ids.set(memory.key, id)
  insertFts.run(id, makeBigrams(memory.text))
}

// 2) 嵌入
const claims = db.prepare('select id, text from claim').all().map(row => ({ id: Number(row.id), text: row.text }))
const embedResult = await embedClaims(db, settings, claims)
console.log(`嵌入：${embedResult.ok ? `${embedResult.embedded} 条` : `失败 ${embedResult.error}`}`)

// 3) 回放
console.log('\n查询回放：')
let hit = 0
let mrr = 0
for (const testCase of CASES) {
  const { hits, trace } = await retrieve({ settings, db, query: testCase.query, scope })
  const position = hits.findIndex(item => item.id === ids.get(testCase.expect))
  const ok = position >= 0 && position < 3
  if (ok) {
    hit++
    mrr += 1 / (position + 1)
  }
  const top = hits[0]?.text?.slice(0, 26) ?? '(空)'
  console.log(
    `  ${ok ? '✓' : '✗'} 「${testCase.query}」→ 目标第 ${position < 0 ? '—' : position + 1} 位`
    + ` ｜ top1: ${top}｜ 通道 ${JSON.stringify(trace.channels)}${trace.reranked ? ' +rerank' : ''}｜ ${trace.ms}ms`
  )
}

console.log(`\n结果：top3 命中 ${hit}/${CASES.length}（${Math.round((hit / CASES.length) * 100)}%），MRR ${(mrr / CASES.length).toFixed(3)}`)
db.close()
rmSync(root, { recursive: true, force: true })
