/**
 * SQLite 存储层（`node:sqlite`，零原生依赖）。
 *
 * 设计要点：
 * 1. **原文是资产，向量是派生物** —— `message`/`claim` 永久保留文本，`vec` 可随时重建。
 * 2. **向量按 `(claim_id, model)` 共存** —— 换模型不覆盖旧向量，支持渐进式重嵌。
 * 3. **中文关键词用 bigram 物化列** —— FTS5 的 trigram 对 2 字查询 0 命中（已实测）。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const SCHEMA_VERSION = 1

const SCHEMA = `
create table if not exists meta (
  k text primary key,
  v text not null
);

create table if not exists message (
  id          integer primary key autoincrement,
  scope       text    not null,
  session_id  text    not null,
  turn        integer not null,
  message_id  text    not null unique,
  role        text    not null,
  text        text    not null,
  created_at  integer not null
);
create index if not exists idx_message_scope on message(scope, created_at desc);

create table if not exists claim (
  id                integer primary key autoincrement,
  scope             text    not null,
  kind              text    not null,
  text              text    not null,
  basis             text    not null,
  origin            text,
  claim_state       text    not null default 'active',
  temporal          text    not null default 'current',
  importance        real    not null default 0.5,
  superseded_by     integer,
  source_message_id text,
  created_at        integer not null,
  updated_at        integer not null,
  last_used_at      integer,
  use_count         integer not null default 0,
  deleted_at        integer,
  content_hash      text    not null unique
);
create index if not exists idx_claim_scope on claim(scope, claim_state, created_at desc);
create index if not exists idx_claim_kind on claim(kind);

create table if not exists evidence (
  id         integer primary key autoincrement,
  claim_id   integer not null,
  message_id text,
  ref_type   text    not null,
  quote      text,
  created_at integer not null
);
create index if not exists idx_evidence_claim on evidence(claim_id);

create table if not exists vec (
  claim_id integer not null,
  model    text    not null,
  dim      integer not null,
  vec      blob    not null,
  primary key (claim_id, model)
);

create virtual table if not exists claim_fts using fts5(
  bg,
  tokenize='unicode61'
);

create table if not exists page (
  id         integer primary key autoincrement,
  scope      text    not null,
  name       text    not null,
  tier       text    not null,
  content    text,
  updated_at integer,
  unique(scope, name)
);

create table if not exists job (
  id          integer primary key autoincrement,
  kind        text    not null,
  dedupe_key  text,
  payload     text    not null,
  attempts    integer not null default 0,
  next_at     integer not null,
  claimed_by  text,
  lease_until integer,
  created_at  integer not null
);
`

/**
 * 索引单独建：老库补列之后才能建（列不存在时建索引会直接报错）。
 * `job.dedupe_key` 用**部分唯一索引**而不是列级 UNIQUE——SQLite 的
 * `alter table add column` 不支持 UNIQUE，用索引才能让老库平滑升级。
 */
const INDEXES = `
create index if not exists idx_message_scope on message(scope, created_at desc);
create index if not exists idx_claim_scope on claim(scope, claim_state, created_at desc);
create index if not exists idx_claim_kind on claim(kind);
create index if not exists idx_evidence_claim on evidence(claim_id);
create index if not exists idx_job_due on job(kind, next_at);
create unique index if not exists idx_job_dedupe on job(dedupe_key) where dedupe_key is not null;
`

/**
 * 增量迁移：给已存在的表补列。幂等，可重复执行。
 * @param {DatabaseSync} db 连接。
 */
function migrateColumns(db) {
  const columns = db.prepare('pragma table_info(job)').all().map(row => row.name)
  if (!columns.includes('dedupe_key')) db.exec('alter table job add column dedupe_key text')
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const TOKEN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[A-Za-z0-9_][A-Za-z0-9_.#:@/\\-]*/g

/**
 * 把文本变成适合 FTS5 `unicode61` 的检索串：中文按 2 字滑窗，英文/数字按词。
 *
 * 为什么不用 trigram：实测 FTS5 trigram 对「记忆」「插件」这类 2 字中文查询返回 0 命中，
 * 而中文里 2 字词占绝大多数。bigram 物化后同样两个词都能命中。
 * @param {string} text 原文。
 * @returns {string} 空格分隔的检索串。
 */
export function makeBigrams(text) {
  if (typeof text !== 'string' || text === '') return ''
  const out = []
  for (const chunk of text.match(TOKEN) ?? []) {
    if (CJK.test(chunk)) {
      if (chunk.length === 1) out.push(chunk)
      else for (let i = 0; i < chunk.length - 1; i++) out.push(chunk.slice(i, i + 2))
    } else {
      const lowered = chunk.toLowerCase()
      if (lowered.length >= 2) out.push(lowered)
    }
  }
  return out.join(' ')
}

/**
 * 把用户查询编译成 FTS5 MATCH 表达式。
 *
 * 用 **OR** 而不是 AND：中文查询切出十几个 bigram，AND 要求全部同时出现，
 * 实际几乎必然 0 命中（实测「我应该怎么回答你」在 AND 下召回 0 条）。
 * OR 让任意词命中即可进来，再由 `bm25()` 排序和后面的 rerank 精排。
 * @param {string} query 查询文本。
 * @returns {string|null} MATCH 表达式，无可检索词时为 null。
 */
export function makeFtsQuery(query) {
  const terms = makeBigrams(query).split(' ').filter(Boolean).slice(0, 16)
  if (terms.length === 0) return null
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * 打开（必要时初始化）数据库。
 * @param {object} settings `resolveSettings()` 的返回值。
 * @returns {DatabaseSync} 已就绪的连接。
 */
export function openStore(settings) {
  mkdirSync(dirname(settings.storagePath), { recursive: true })
  const db = new DatabaseSync(settings.storagePath)
  try {
    db.exec('pragma journal_mode=WAL')
  } catch {
    /* 某些只读/网络盘不支持 WAL，退化为默认模式即可 */
  }
  try {
    db.exec('pragma busy_timeout=5000')
    db.exec('pragma synchronous=NORMAL')
  } catch {
    /* 同上：性能参数失败不影响可用性 */
  }
  db.exec(SCHEMA)
  migrateColumns(db)
  db.exec(INDEXES)
  setMeta(db, 'schema_version', String(SCHEMA_VERSION))
  setMeta(db, 'active_model', settings.embeddingModel)
  setMeta(db, 'active_dim', String(settings.embeddingDim))
  return db
}

/** 读一个 meta 值。 */
export function getMeta(db, key) {
  const row = db.prepare('select v from meta where k = ?').get(key)
  return row === undefined ? null : row.v
}

/** 写一个 meta 值。 */
export function setMeta(db, key, value) {
  db.prepare('insert into meta(k, v) values(?, ?) on conflict(k) do update set v = excluded.v').run(key, String(value))
}

/**
 * 库内计数（给 doctor / stats 用）。
 * @param {DatabaseSync} db 连接。
 * @returns {{messages:number, claims:number, vectors:number, jobs:number}} 计数。
 */
export function counts(db) {
  const one = sql => Number(db.prepare(sql).get()?.c ?? 0)
  return {
    messages: one('select count(*) c from message'),
    claims: one('select count(*) c from claim where deleted_at is null'),
    vectors: one('select count(*) c from vec'),
    jobs: one('select count(*) c from job'),
  }
}

/**
 * 做一次写入-读取往返，确认库真的可写（医生检查用）。
 * @param {DatabaseSync} db 连接。
 * @returns {{ok:boolean, error?:string}} 结果。
 */
export function pingWrite(db) {
  const stamp = String(Date.now())
  try {
    setMeta(db, 'last_ping', stamp)
    const readBack = getMeta(db, 'last_ping')
    return readBack === stamp ? { ok: true } : { ok: false, error: '写入后读回不一致' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
