/**
 * 只读看板：`http://127.0.0.1:<port>`。
 *
 * 三条原则：
 * 1. **只读** —— 不提供任何写/删入口，写操作只走工具（那里有「用户明确要求」的校验）。
 * 2. **fail-open** —— 端口被占、启动失败都只记日志，绝不影响宿主。
 * 3. **不走模型** —— 搜索只用本地 FTS + LIKE，不调用任何外部接口（快、且不花钱）。
 */

import { createServer } from 'node:http'
import { makeFtsQuery } from './store.js'

/** HTML 转义，防止记忆正文里的标签破坏页面。 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ))
}

function fmtDate(timestamp) {
  try {
    return new Date(Number(timestamp)).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return '?'
  }
}

const BASIS_LABEL = {
  direct_report: '用户原话',
  derived_summary: '我的总结',
  observed: '工具所见',
  inferred: '推断',
}

const KIND_LABEL = {
  preference: '偏好',
  decision: '决定',
  fact: '事实',
  convention: '约定',
  turn_summary: '轮次摘要',
}

/**
 * 查列表。
 * @param {object} db 连接。
 * @param {{query?:string, scope?:string, limit?:number}} options 条件。
 * @returns {Array<object>} 记忆列表。
 */
function listClaims(db, options) {
  const limit = Math.min(Math.max(Number(options.limit ?? 50), 1), 200)
  const query = String(options.query ?? '').trim()
  const scope = String(options.scope ?? '').trim()

  if (query !== '') {
    const match = makeFtsQuery(query)
    if (match !== null) {
      try {
        return db.prepare(
          'select c.id, c.kind, c.basis, c.text, c.scope, c.importance, c.created_at, c.claim_state'
          + ' from claim_fts join claim c on c.id = claim_fts.rowid'
          + ' where claim_fts match ? and c.deleted_at is null order by bm25(claim_fts) limit ?'
        ).all(match, limit)
      } catch {
        /* 落到下面的 LIKE */
      }
    }
    return db.prepare(
      'select id, kind, basis, text, scope, importance, created_at, claim_state'
      + ' from claim where deleted_at is null and text like ? order by id desc limit ?'
    ).all(`%${query}%`, limit)
  }

  if (scope !== '') {
    return db.prepare(
      'select id, kind, basis, text, scope, importance, created_at, claim_state'
      + ' from claim where deleted_at is null and scope = ? order by id desc limit ?'
    ).all(scope, limit)
  }

  return db.prepare(
    'select id, kind, basis, text, scope, importance, created_at, claim_state'
    + ' from claim where deleted_at is null order by id desc limit ?'
  ).all(limit)
}

/**
 * 生成页面。
 * @param {object} db 连接。
 * @param {URLSearchParams} params 查询参数。
 * @param {object} settings 运行时设置。
 * @returns {string} HTML。
 */
function renderPage(db, params, settings) {
  const query = params.get('q') ?? ''
  const scope = params.get('scope') ?? ''
  const rows = listClaims(db, { query, scope, limit: 80 })

  const one = (sql) => Number(db.prepare(sql).get()?.c ?? 0)
  const total = one('select count(*) c from claim where deleted_at is null')
  const messages = one('select count(*) c from message')
  const vectors = one(`select count(*) c from vec where model = '${settings.embeddingModel.replace(/'/g, "''")}'`)
  const pending = one('select count(*) c from job')
  const scopes = db.prepare(
    'select scope, count(*) c from claim where deleted_at is null group by scope order by c desc limit 12'
  ).all()

  const rowsHtml = rows.length === 0
    ? '<tr><td colspan="6" class="empty">没有匹配的记忆</td></tr>'
    : rows.map(row => `
      <tr>
        <td class="id">${row.id}</td>
        <td><span class="tag k-${escapeHtml(row.kind)}">${escapeHtml(KIND_LABEL[row.kind] ?? row.kind)}</span></td>
        <td><span class="tag b-${escapeHtml(row.basis)}">${escapeHtml(BASIS_LABEL[row.basis] ?? row.basis)}</span></td>
        <td class="text">${escapeHtml(String(row.text).slice(0, 220))}${String(row.text).length > 220 ? '…' : ''}</td>
        <td class="scope">${escapeHtml(String(row.scope).replace('workspace:', ''))}</td>
        <td class="time">${escapeHtml(fmtDate(row.created_at))}</td>
      </tr>`).join('')

  const scopeHtml = scopes.map(row => {
    const label = String(row.scope).replace('workspace:', '')
    return `<a class="chip${scope === row.scope ? ' on' : ''}" href="/?scope=${encodeURIComponent(row.scope)}">${escapeHtml(label)} · ${row.c}</a>`
  }).join('')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>记忆看板 · dafa-fish-memory</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e3e7ec;--ink:#1b2026;--mute:#6d7683;--accent:#1e6b52}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:26px 20px 60px}
h1{font-size:20px;margin:0 0 4px;letter-spacing:.5px}
.sub{color:var(--mute);font-size:12.5px;margin-bottom:18px}
.stats{display:flex;gap:10px;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;flex:1}
.stat b{display:block;font-size:19px;color:var(--accent)}
.stat span{font-size:12px;color:var(--mute)}
form{display:flex;gap:8px;margin-bottom:12px}
input[type=search]{flex:1;padding:9px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--card)}
button{padding:9px 16px;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;cursor:pointer;font-size:14px}
.chips{margin-bottom:14px;line-height:2.1}
.chip{display:inline-block;font-size:12px;padding:3px 9px;margin-right:6px;border:1px solid var(--line);border-radius:999px;color:var(--mute);text-decoration:none;background:var(--card)}
.chip.on{border-color:var(--accent);color:var(--accent)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th{text-align:left;font-size:12px;color:var(--mute);font-weight:400;padding:9px 10px;border-bottom:1px solid var(--line);background:#fafbfc}
td{padding:9px 10px;border-bottom:1px solid #f1f3f6;vertical-align:top;font-size:13px}
td.id{font-family:Consolas,monospace;color:var(--mute);width:46px}
td.text{line-height:1.65}
td.scope{font-size:11.5px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px}
td.time{font-size:11.5px;color:var(--mute);white-space:nowrap}
.tag{font-size:11px;padding:1px 7px;border-radius:999px;white-space:nowrap}
.b-direct_report{background:#e6f4ec;color:#1a6b45}
.b-derived_summary{background:#fdf3e3;color:#8a5a12}
.b-observed,.b-inferred{background:#eef1f6;color:#4a5566}
.k-preference{background:#eaf1fd;color:#25508f}
.k-decision{background:#f3ecfb;color:#5b3d8f}
.k-fact,.k-convention,.k-turn_summary{background:#f0f2f5;color:#4a5566}
.empty{text-align:center;color:var(--mute);padding:26px}
.foot{margin-top:16px;color:var(--mute);font-size:12px}
</style></head>
<body><div class="wrap">
<h1>记忆看板</h1>
<div class="sub">只读视图 · ${escapeHtml(settings.embeddingModel)} · ${escapeHtml(settings.scopeMode === 'global' ? '跨工作区共享' : '按工作区隔离')}</div>
<div class="stats">
  <div class="stat"><b>${total}</b><span>记忆条数</span></div>
  <div class="stat"><b>${messages}</b><span>原文消息</span></div>
  <div class="stat"><b>${vectors}</b><span>已有向量</span></div>
  <div class="stat"><b>${pending}</b><span>待处理任务</span></div>
</div>
<form method="get" action="/">
  <input type="search" name="q" placeholder="搜索记忆（中文 2 字也行）" value="${escapeHtml(query)}">
  <button type="submit">搜索</button>
</form>
<div class="chips">${scopeHtml}</div>
<table>
<thead><tr><th>#</th><th>类型</th><th>可信度</th><th>内容</th><th>作用域</th><th>写入时间</th></tr></thead>
<tbody>${rowsHtml}</tbody>
</table>
<div class="foot">只读页面，不提供删除入口；删除与纠正请通过对话里的 <code>memory_forget</code> 完成。</div>
</div></body></html>`
}

/**
 * 启动看板服务器。
 * @param {{settings:object, db:object, logger?:object}} deps 依赖。
 * @returns {{close:Function, url:string}|null} 句柄；启动失败返回 null。
 */
export function startViewer({ settings, db, logger }) {
  if (!settings.viewerEnabled) return null
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${settings.viewerPort}`)
      if (url.pathname === '/api/stats') {
        const body = JSON.stringify({
          claims: Number(db.prepare('select count(*) c from claim where deleted_at is null').get()?.c ?? 0),
          messages: Number(db.prepare('select count(*) c from message').get()?.c ?? 0),
          jobs: Number(db.prepare('select count(*) c from job').get()?.c ?? 0),
        })
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(body)
        return
      }
      if (url.pathname === '/api/list') {
        const rows = listClaims(db, {
          query: url.searchParams.get('q') ?? '',
          scope: url.searchParams.get('scope') ?? '',
          limit: url.searchParams.get('limit') ?? 50,
        })
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ count: rows.length, items: rows }))
        return
      }
      if (url.pathname !== '/') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(renderPage(db, url.searchParams, settings))
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`看板出错：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.on('error', error => {
    logger?.warn?.(`dafa-fish-memory: 看板启动失败（不影响记忆）：${error instanceof Error ? error.message : String(error)}`)
  })

  try {
    server.listen(settings.viewerPort, '127.0.0.1')
  } catch (error) {
    logger?.warn?.(`dafa-fish-memory: 看板监听失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  return {
    url: `http://127.0.0.1:${settings.viewerPort}`,
    close() {
      try {
        server.close()
      } catch {
        /* 关闭失败忽略 */
      }
    },
  }
}
