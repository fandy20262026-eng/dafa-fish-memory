/**
 * 分档压测：验证不同记忆规模下的召回扫描开销。
 *
 * 用法：node scripts/scale-bench.js
 *
 * 它不连数据库、不调模型，只测「向量进内存后，一次召回的内层扫描要多久」，
 * 也就是随记忆量增长唯一会变慢的那部分。预筛本身是 SQL 查询（约 5–20ms），
 * 所以这里直接测「预筛后实际参与比较的条数」。
 *
 * 结论（本机实测）：
 * - A 档 2 万条全量扫 ≈ 80ms，完全够用；
 * - int8 **不提速**（V8 对 Int8Array 没有向量化），只省内存，所以只用在 C 档控内存；
 * - 真正压住延迟的是预筛：把 10 万条筛到 4 万，扫描量直接减半。
 */

import { resolveTier, quantizeVector, dotInt8 } from '../lib/scale.js'

const DIM = 1024

/** 造一条随机归一化向量（模拟 embedding 输出）。 */
function randomUnitVector() {
  const vector = new Float32Array(DIM)
  let norm = 0
  for (let i = 0; i < DIM; i++) {
    const value = Math.random() * 2 - 1
    vector[i] = value
    norm += value * value
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < DIM; i++) vector[i] /= norm
  return vector
}

/** float32 点积。 */
function dotFloat(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

/**
 * 测「扫 N 条」的耗时。
 * @param {number} scanCount 实际参与比较的条数。
 * @param {'float32'|'int8'} mode 存储形态。
 * @returns {{ms:number, memMB:number}} 结果。
 */
function bench(scanCount, mode) {
  const query = randomUnitVector()
  const quantizedQuery = mode === 'int8' ? quantizeVector(query) : null
  const vectors = []
  for (let i = 0; i < scanCount; i++) {
    const vector = randomUnitVector()
    vectors.push(mode === 'int8' ? quantizeVector(vector) : vector)
  }

  // 预热，避免 JIT 把首轮算进去
  for (let i = 0; i < Math.min(scanCount, 300); i++) {
    const item = vectors[i]
    if (mode === 'int8') dotInt8(quantizedQuery.data, quantizedQuery.scale, item.data, item.scale)
    else dotFloat(query, item)
  }

  const startedAt = Date.now()
  let best = -Infinity
  for (let i = 0; i < scanCount; i++) {
    const item = vectors[i]
    const score = mode === 'int8'
      ? dotInt8(quantizedQuery.data, quantizedQuery.scale, item.data, item.scale)
      : dotFloat(query, item)
    if (score > best) best = score
  }
  const ms = Date.now() - startedAt
  return { ms, memMB: Math.round((scanCount * DIM * (mode === 'int8' ? 1 : 4)) / 1024 / 1024) }
}

// 场景：total = 库里的记忆总量，scan = 预筛后真正参与比较的条数
const SCENARIOS = [
  { total: 2_000,   scan: 2_000,   mode: 'float32', note: '新装用户' },
  { total: 20_000,  scan: 20_000,  mode: 'float32', note: 'A 档上限' },
  { total: 100_000, scan: 40_000,  mode: 'float32', note: 'B 档：预筛到 4 万' },
  { total: 500_000, scan: 40_000,  mode: 'int8',    note: 'C 档：预筛 + 量化' },
]

console.log(`\n维度 ${DIM}｜模拟一次召回的内层扫描\n`)
console.log('档位  库内总量   参与比较   存储      扫描内存   扫描耗时')
console.log('-'.repeat(64))

for (const s of SCENARIOS) {
  const tier = resolveTier(s.total)
  const { ms, memMB } = bench(s.scan, s.mode)
  console.log(
    `${tier.id}     ${String(s.total).padEnd(9)} ${String(s.scan).padEnd(9)} ${s.mode.padEnd(9)} ${String(memMB + ' MB').padEnd(10)} ${ms} ms`
    + `   ${s.note}`
  )
}

console.log('\n档位规则：')
console.log('  A  ≤ 20000      全量扫描（float32），最精确')
console.log('  B  ≤ 100000     SQL 预筛（重要度 ≥0.4 或近 180 天）后扫描，控制参与比较的条数')
console.log('  C  > 100000     预筛 + int8 存储，把常驻内存压到 1/4\n')
console.log('真实召回还要加：查询嵌入 ≈200ms（网络）+ rerank ≈300ms（网络）。')
console.log('所以 A 档扫描只占几个百分点；到 C 档预筛才是保住延迟的关键。\n')
