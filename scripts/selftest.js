/**
 * 不依赖 DSH 的自检：验证配置解析、Schema 建表、bigram 检索、doctor 输出。
 * 用法：node scripts/selftest.js
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { interpolateEnv, isPaidModel, resolveSettings } from '../lib/config.js'
import {
  counts, getMeta, makeBigrams, makeFtsQuery, openStore, pingWrite, setMeta,
} from '../lib/store.js'
import { buildDoctor } from '../lib/doctor.js'

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'memory-sf-selftest-'))
console.log(`\n[1] 配置解析`)
{
  const expanded = interpolateEnv('${FOO}', { FOO: 'bar' })
  check('${FOO} 被展开', expanded.value === 'bar')
  const missing = interpolateEnv('${NOPE}', {})
  check('缺失变量被记录', missing.missing.length === 1 && missing.missing[0] === 'NOPE')
  check('Pro/ 被识别为付费档', isPaidModel('Pro/BAAI/bge-m3') === true)
  check('免费档不被误判', isPaidModel('BAAI/bge-m3') === false)

  const settings = resolveSettings({
    home: root,
    apiKey: '${TEST_KEY_DEFINED}',
    embeddingModel: 'Pro/whatever',
    embeddingDim: 1024,
  })
  check('付费模型被回退', settings.embeddingModel === 'BAAI/bge-m3', settings.embeddingModel)
  check('付费模型产生告警', settings.problems.some(p => p.includes('付费档')))
  check('存储路径落在 home/memory-sf 下', settings.storagePath === join(root, 'memory-sf', 'memory.db'))
  check('默认按工作区隔离', settings.scopeMode === 'workspace')
}

console.log(`\n[2] bigram 检索串`)
{
  const bg = makeBigrams('记忆插件的设计')
  check('中文按 2 字滑窗', bg === '记忆 忆插 插件 件的 的设 设计', bg)
  const q = makeFtsQuery('记忆')
  check('2 字查询生成 MATCH 表达式', q === '"记忆"', String(q))
  check('英文按词保留', makeBigrams('EADDRINUSE 3199').includes('eaddrinuse'))
}

console.log(`\n[3] 建库与写入`)
let settings
let db
{
  settings = resolveSettings({ home: root, apiKey: 'sk-test-123456789', embeddingDim: 1024 })
  db = openStore(settings)
  const ping = pingWrite(db)
  check('库可写并读回一致', ping.ok, ping.error ?? '')
  check('schema 版本写入', getMeta(db, 'schema_version') === '1')
  check('active_model 写入', getMeta(db, 'active_model') === 'BAAI/bge-m3')

  const now = Date.now()
  const row = db.prepare(
    'insert into claim(scope,kind,text,basis,origin,created_at,updated_at,content_hash) values(?,?,?,?,?,?,?,?)'
  ).run('workspace:C:\\x', 'preference', '用户要求回答优先给表格，少用表情', 'direct_report', 'human_direct', now, now, 'h1')
  const id = Number(row.lastInsertRowid)
  db.prepare('insert into claim_fts(rowid, bg) values(?, ?)').run(id, makeBigrams('用户要求回答优先给表格，少用表情'))

  const hit1 = db.prepare('select rowid from claim_fts where claim_fts match ?').all(makeFtsQuery('表格'))
  const hit2 = db.prepare('select rowid from claim_fts where claim_fts match ?').all(makeFtsQuery('用户'))
  const hit3 = db.prepare('select rowid from claim_fts where claim_fts match ?').all(makeFtsQuery('不存在的词'))
  check('2 字查询「表格」命中', hit1.length === 1)
  check('2 字查询「用户」命中', hit2.length === 1)
  check('无关查询不命中', hit3.length === 0)

  const c = counts(db)
  check('计数正确', c.claims === 1 && c.messages === 0, JSON.stringify(c))
}

console.log(`\n[4] doctor 输出（不探测）`)
{
  const report = await buildDoctor({ settings, store: db, startupError: null, state: {}, probe: false })
  check('status 为 ok 或 attention', report.status === 'ok' || report.status === 'attention', report.status)
  check('报告含关键行', report.report.includes('当前向量模型') && report.report.includes('作用域'))
  check('未探测时不报错', report.report.includes('探测：未执行'))
  console.log('  ── 报告预览 ──')
  for (const line of report.report.split('\n')) console.log(`  │ ${line}`)
}

console.log(`\n[5] doctor 输出（探测真实接口）`)
{
  const realKey = (process.env.SILICONFLOW_API_KEY ?? '').trim()
  if (realKey === '') {
    console.log('  · 跳过（没有 SILICONFLOW_API_KEY）')
  } else {
    const realSettings = resolveSettings({ home: root, apiKey: '', embeddingDim: 1024 })
    const report = await buildDoctor({ settings: realSettings, store: db, startupError: null, state: {}, probe: true, })
    const line = report.report.split('\n').find(item => item.includes('探测')) ?? ''
    console.log(`  │ ${line}`)
    check('探测结果被记录', line.length > 0)
  }
}

console.log(`\n[6] 采集：真实事件形状 + 去重 + 自污染防护`)
{
  const { createCapture } = await import('../lib/capture.js')
  const captureRoot = mkdtempSync(join(tmpdir(), 'memory-sf-capture-'))
  const captureSettings = resolveSettings({ home: captureRoot, apiKey: 'sk-test-123456789' })
  let captureDb = openStore(captureSettings)
  const cap = createCapture({ settings: captureSettings, db: captureDb })

  const session = { id: 'sess-1', header: { cwd: 'C:\\Users\\User\\system' } }
  const userEvent = (id, text, kind = 'user') => ({
    type: 'user/message',
    data: { id, source: { kind }, content: [{ type: 'text', text }] },
  })
  const assistantEvent = (turn, id, text) => ({
    type: 'assistant/message',
    data: { turn, message: { id, content: [{ type: 'text', text }] } },
  })

  cap.onSessionEvent(session, { type: 'turn/start', data: { turn: 3 } })
  cap.onSessionEvent(session, userEvent('m1', '记住：以后回答优先给表格'))
  cap.onSessionEvent(session, userEvent('m1', '重复投递，应当被忽略'))
  cap.onSessionEvent(session, userEvent('p1', '插件注入的上下文，不该被采', 'plugin:memos-local-memory'))
  cap.onSessionEvent(session, assistantEvent(3, 'a1', '好的，记下了。'))
  cap.onSessionEvent(session, { type: 'turn/end', data: { turn: 3 } })

  const rows = captureDb.prepare('select role, turn, scope, text from message order by id').all()
  check('只落用户与助手两条', rows.length === 2, rows.map(r => r.role).join(','))
  check('重复 message_id 被去重', rows.filter(r => r.text.includes('重复投递')).length === 0)
  check('插件注入被过滤', rows.filter(r => r.text.includes('插件注入')).length === 0)
  check('scope 按 cwd 归一', rows[0]?.scope === 'workspace:c:/users/user/system', rows[0]?.scope)
  check('turn 号正确', Number(rows[0]?.turn) === 3 && Number(rows[1]?.turn) === 3)

  const jobRows = captureDb.prepare('select kind, dedupe_key, payload from job').all()
  check('每轮排且只排一个抽取任务', jobRows.length === 1, JSON.stringify(jobRows))
  check('任务键含 scope 与轮次', String(jobRows[0]?.dedupe_key ?? '').includes('sess-1:3'))

  // 模拟进程重启：关库再开，任务仍在（证明不是内存队列）
  captureDb.close()
  captureDb = openStore(captureSettings)
  const afterRestart = captureDb.prepare('select count(*) c from job').get().c
  check('重启后任务不丢', Number(afterRestart) === 1, String(afterRestart))
  captureDb.close()
  rmSync(captureRoot, { recursive: true, force: true })
}

console.log(`\n[7] 规则抽取 + worker 消费队列`)
{
  const { extractByRules } = await import('../lib/extract.js')
  const { createCapture } = await import('../lib/capture.js')
  const { createWorker } = await import('../lib/worker.js')

  const candidates = extractByRules({
    scope: 'workspace:c:/x',
    messages: [
      { role: 'user', text: '记住：以后回答优先给表格。今天天气不错。我们决定暂不升级 DSH。' },
      { role: 'assistant', text: '好的，以后都用表格。' },
    ],
  })
  check('规则能识别显式交代/决策', candidates.length === 2, JSON.stringify(candidates.map(c => c.kind)))
  check('用户原话标为 direct_report', candidates.every(c => c.basis === 'direct_report'))
  check('助手的话不会变成 preference', candidates.every(c => c.kind !== 'preference' || c.origin === 'human_direct'))

  const root7 = mkdtempSync(join(tmpdir(), 'memory-sf-worker-'))
  const settings7 = resolveSettings({ home: root7, apiKey: 'sk-fake-for-test' })
  const db7 = openStore(settings7)
  const cap7 = createCapture({ settings: settings7, db: db7 })
  const session7 = { id: 'sess-7', header: { cwd: 'C:\\Users\\User\\system' } }
  cap7.onSessionEvent(session7, { type: 'turn/start', data: { turn: 1 } })
  cap7.onSessionEvent(session7, {
    type: 'user/message',
    data: { id: 'u7', source: { kind: 'user' }, content: [{ type: 'text', text: '记住：以后回答优先给表格。今天天气不错。' }] },
  })
  cap7.onSessionEvent(session7, {
    type: 'assistant/message',
    data: { turn: 1, message: { id: 'a7', content: [{ type: 'text', text: '好的。' }] } },
  })
  cap7.onSessionEvent(session7, { type: 'turn/end', data: { turn: 1 } })

  const worker7 = createWorker({ settings: settings7, db: db7 })
  await worker7.tick()
  const claims7 = db7.prepare('select kind, basis, scope from claim').all()
  check('worker 消费 extract 并写入 claim', claims7.length === 1, JSON.stringify(claims7))
  check('claim 落在正确的 scope', claims7[0]?.scope === 'workspace:c:/users/user/system')
  const jobs7 = db7.prepare('select kind, dedupe_key from job').all()
  check('自动排入 embed 任务', jobs7.some(row => row.kind === 'embed'), JSON.stringify(jobs7))
  db7.close()
  rmSync(root7, { recursive: true, force: true })
}

console.log(`\n[8] 租约：双端只允许一个写者`)
{
  const { createLease } = await import('../lib/lease.js')
  const leaseRoot = mkdtempSync(join(tmpdir(), 'memory-sf-lease-'))
  const lockPath = join(leaseRoot, 'worker.lock')
  const a = createLease({ path: lockPath })
  const b = createLease({ path: lockPath })
  check('第一个进程拿到租约', a.tryAcquire() === true)
  check('第二个进程拿不到', b.tryAcquire() === false)
  check('持有者信息显示是别人', b.holder()?.mine === false)
  a.release()
  check('释放后第二个可以拿到', b.tryAcquire() === true)
  b.release()
  // 心跳过期可接管
  const stale = createLease({ path: lockPath, now: () => Date.now() - 600_000 })
  stale.tryAcquire()
  const fresh = createLease({ path: lockPath })
  check('心跳过期的锁可被接管', fresh.tryAcquire() === true)
  fresh.release()
  rmSync(leaseRoot, { recursive: true, force: true })
}

console.log(`\n[9] 只看板：真实 HTTP 请求`)
{
  const { startViewer } = await import('../lib/viewer.js')
  const viewerRoot = mkdtempSync(join(tmpdir(), 'memory-sf-viewer-'))
  const viewerSettings = resolveSettings({ home: viewerRoot, apiKey: 'sk-test', viewerPort: 18191 })
  const viewerDb = openStore(viewerSettings)
  const nowTs = Date.now()
  const ins = viewerDb.prepare(
    'insert into claim(scope,kind,text,basis,created_at,updated_at,content_hash)'
    + " values(?,?,?,'direct_report',?,?,?)"
  )
  const fts = viewerDb.prepare('insert into claim_fts(rowid, bg) values(?, ?)')
  const info = ins.run('workspace:c:/users/user/system', 'preference', '用户要求回答优先给表格', nowTs, nowTs, 'vh1')
  fts.run(Number(info.lastInsertRowid), makeBigrams('用户要求回答优先给表格'))

  const viewer = startViewer({ settings: viewerSettings, db: viewerDb })
  check('看板已启动', viewer !== null && viewer.url.includes('18191'))
  await new Promise(resolve => setTimeout(resolve, 300))
  try {
    const page = await fetch(`http://127.0.0.1:18191/`).then(r => r.text())
    check('首页返回 HTML 且含记忆内容', page.includes('记忆看板') && page.includes('用户要求回答优先给表格'))
    check('首页含统计', page.includes('记忆条数'))
    const stats = await fetch(`http://127.0.0.1:18191/api/stats`).then(r => r.json())
    check('统计接口可用', stats.claims === 1, JSON.stringify(stats))
    const list = await fetch(`http://127.0.0.1:18191/api/list?q=${encodeURIComponent('表格')}`).then(r => r.json())
    check('搜索接口命中 2 字查询', list.count === 1, JSON.stringify(list.count))
  } catch (error) {
    check('看板 HTTP 可访问', false, String(error))
  }
  viewer?.close()
  await new Promise(resolve => setTimeout(resolve, 60))
  viewerDb.close()
  rmSync(viewerRoot, { recursive: true, force: true })
}

console.log(`\n[10] LLM 抽取：JSON 容错与逐字校验`)
{
  const { parseJsonLoose } = await import('../lib/llm-extract.js')
  check('能解析裸 JSON', parseJsonLoose('{"memories":[]}')?.memories?.length === 0)
  check('能解析 ```json 围栏', parseJsonLoose('```json\n{"memories":[{"kind":"fact","text":"x"}]}\n```')?.memories?.length === 1)
  check('能容忍前后废话', parseJsonLoose('好的，结果如下：{"memories":[]} 以上。')?.memories?.length === 0)
  check('坏 JSON 返回 null', parseJsonLoose('not json at all') === null)

  // 逐字校验的核心逻辑：squash 后子串匹配
  const squash = text => String(text).replace(/[\s\u3000]+/g, '').replace(/[，。；：、！？""''（）()《》【】]/g, '')
  const userText = '以后回答都用表格，别堆大段文字。'
  check('改写过的句子会被拒绝', !squash(userText).includes(squash('用户要求回答以表格呈现')))
  check('逐字片段会被接受', squash(userText).includes(squash('以后回答都用表格')))
}

try {
  db?.close()
} catch {
  /* ignore */
}
rmSync(root, { recursive: true, force: true })

console.log(`\n结果：${passed} 通过，${failed} 失败\n`)
process.exit(failed === 0 ? 0 : 1)
