/**
 * 验证向量缓存在「worker 持续写入」时不再反复全量重载。
 *
 * 复现的是 2026-11-18 那次卡死的场景：库里有几千条向量，worker 每轮嵌入新记忆，
 * 旧实现用 `pragma data_version` 判断失效，于是每次写入都触发 35 MB 同步重读，
 * 全部压在 pre-step 的请求路径上。
 *
 * 用法：node scripts/vecache-perf.js
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveSettings } from '../lib/config.js'
import { openStore, makeBigrams } from '../lib/store.js'
import { createVectorCache } from '../lib/vecache.js'
import { contentHash } from '../lib/extract.js'
import { toBlob } from '../lib/embed.js'

const COUNT = 2000
const DIM = 1024

const root = mkdtempSync(join(tmpdir(), 'memory-sf-vecache-'))
const settings = resolveSettings({ home: root, apiKey: '' })
const db = openStore(settings)

console.log(`造数据：${COUNT} 条 × ${DIM} 维…`)
const insertClaim = db.prepare(
  'insert into claim(scope,kind,text,basis,created_at,updated_at,content_hash)'
  + " values(?,?,?,'direct_report',?,?,?)"
)
const insertVec = db.prepare('insert into vec(claim_id, model, dim, vec) values(?,?,?,?)')
const insertFts = db.prepare('insert into claim_fts(rowid, bg) values(?,?)')
const now = Date.now()

db.exec('begin')
for (let i = 0; i < COUNT; i++) {
  const text = `测试记忆第 ${i} 条，关于端口 ${10000 + i} 与配置项`
  const info = insertClaim.run('workspace:c:/x', 'fact', text, now, now, contentHash('workspace:c:/x', 'fact', text))
  const id = Number(info.lastInsertRowid)
  insertVec.run(id, settings.embeddingModel, DIM, toBlob(new Float32Array(DIM).map(() => Math.random() * 2 - 1)))
  insertFts.run(id, makeBigrams(text))
}
db.exec('commit')
console.log('数据就绪\n')

const cache = createVectorCache(db, settings)
const t0 = Date.now()
cache.reload()
const loadMs = Date.now() - t0
console.log(`首次全量加载：${loadMs}ms（${cache.count()} 条）`)

// 模拟：worker 每轮写入一条，召回紧接着执行
const query = new Float32Array(DIM).map(() => Math.random() * 2 - 1)
const { retrieve } = await import('../lib/retrieve.js')

const samples = []
console.log('\n轮次  写入后召回耗时')
for (let i = 0; i < 12; i++) {
  // 模拟 worker 嵌入新记忆（会写 vec 表）
  const text = `新增记忆 ${i} 号`
  const info = insertClaim.run('workspace:c:/x', 'fact', text, now, now, contentHash('workspace:c:/x', 'fact', text))
  const id = Number(info.lastInsertRowid)
  const vector = new Float32Array(DIM).map(() => Math.random() * 2 - 1)
  insertVec.run(id, settings.embeddingModel, DIM, toBlob(vector))
  insertFts.run(id, makeBigrams(text))
  cache.put(id, vector) // worker 增量更新

  const startedAt = Date.now()
  await retrieve({ settings, db, query: '端口 10005 的配置', scope: 'workspace:c:/x', cache })
  const ms = Date.now() - startedAt
  samples.push(ms)
  console.log(`  ${String(i + 1).padStart(2)}   ${ms}ms`)
}

samples.sort((a, b) => a - b)
const median = samples[Math.floor(samples.length / 2)]
const max = samples[samples.length - 1]
console.log(`\n延迟：中位 ${median}ms｜最大 ${max}ms`)
console.log(max < loadMs ? `✓ 没有出现接近全量重载（${loadMs}ms）的尖峰` : `✗ 出现尖峰，可能仍在重载`)

db.close()
rmSync(root, { recursive: true, force: true })
process.exit(max < loadMs ? 0 : 1)
