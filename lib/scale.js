/**
 * 记忆规模分档：按库里的向量条数自动切换召回策略。
 *
 * 为什么要分档：不同规模下「一次召回」的瓶颈完全不同。
 *
 * | 档位 | 规模 | 内存占用（1024 维） | 存储 | 召回策略 |
 * |---|---|---|---|---|
 * | A 小 | ≤ 2 万 | 约 80 MB | float32 | 全量暴力扫 |
 * | B 中 | 2 万–10 万 | 约 200–400 MB | float32 | **SQL 预筛**（重要度/时间窗）后再扫 |
 * | C 大 | > 10 万 | 约 100–200 MB | int8 | 预筛 + 量化，内存减到 1/4 |
 *
 * 实测结论（详见 `scripts/scale-bench.js`）：
 * - 2 万条以内全量扫只要约 80ms，完全不需要索引；
 * - **int8 并不能提速**——V8 对 Int8Array 没有向量化，整数乘加和 float 差不多，
 *   它的价值只在**省内存**（1/4）；
 * - 所以真正能压住延迟的是**减少参与比较的条数**（预筛），而不是换存储格式。
 *
 * 档位按当前实际条数自动判断，不需要用户配置。想强制指定可设置 `scaleTier` 为 `"A"`/`"B"`/`"C"`。
 */

/** 各档位的条数上限。 */
export const TIER_LIMITS = {
  A: 20_000,
  B: 100_000,
}

/**
 * 判断当前应该用哪个档位。
 * @param {number} vectorCount 库里的向量条数。
 * @param {'auto'|'A'|'B'|'C'} [forced] 强制档位（排障/压测用）。
 * @returns {{id:string, label:string, strategy:string, count:number,
 *            nextAt:number|null, memoryHint:string}} 档位描述。
 */
export function resolveTier(vectorCount, forced = 'auto') {
  const count = Math.max(0, Number(vectorCount) || 0)

  if (forced === 'A' || forced === 'B' || forced === 'C') {
    return describe(forced, count)
  }
  if (count <= TIER_LIMITS.A) return describe('A', count)
  if (count <= TIER_LIMITS.B) return describe('B', count)
  return describe('C', count)
}

/**
 * 生成档位描述。
 * @param {'A'|'B'|'C'} id 档位。
 * @param {number} count 当前条数。
 * @returns {object} 档位描述。
 */
function describe(id, count) {
  if (id === 'A') {
    return {
      id,
      label: '全量扫描',
      strategy: 'bruteforce',
      count,
      nextAt: TIER_LIMITS.A,
      memoryHint: `约 ${Math.round((count * 1024 * 4) / 1024 / 1024)} MB（float32）`,
    }
  }
  if (id === 'B') {
    return {
      id,
      label: '预筛 + 全量',
      strategy: 'prefilter',
      count,
      nextAt: TIER_LIMITS.B,
      memoryHint: `约 ${Math.round((count * 1024 * 4) / 1024 / 1024)} MB（float32）`,
    }
  }
  return {
    id,
    label: '预筛 + 量化',
    strategy: 'tiered',
    count,
    nextAt: null,
    memoryHint: `约 ${Math.round((count * 1024) / 1024 / 1024)} MB（int8）`,
  }
}

/**
 * 把归一化后的 float 向量压成 int8。
 *
 * 做法：按该向量的最大绝对值缩放到 [-127, 127]，再四舍五入。
 * 因为 embedding 已经归一化（模长≈1），每个分量的绝对值通常 < 0.3，
 * 所以这个缩放对排序几乎没有影响，但内存和带宽都降到 1/4。
 * @param {Float32Array|number[]} vector 原始向量。
 * @returns {{data:Int8Array, scale:number}} 量化结果与反缩放系数。
 */
export function quantizeVector(vector) {
  const length = vector.length
  let maxAbs = 0
  for (let i = 0; i < length; i++) {
    const abs = Math.abs(vector[i])
    if (abs > maxAbs) maxAbs = abs
  }
  const scale = maxAbs === 0 ? 1 : 127 / maxAbs
  const data = new Int8Array(length)
  for (let i = 0; i < length; i++) {
    const value = Math.round(vector[i] * scale)
    data[i] = value > 127 ? 127 : value < -127 ? -127 : value
  }
  return { data, scale: maxAbs === 0 ? 1 : 1 / scale }
}

/**
 * 用 float 查询向量对 int8 存储向量做点积（近似余弦）。
 *
 * 注意：这是**混合类型**版本，V8 需要把 int8 提升成 float 再乘，实测并不比纯 float 快，
 * 只用于兼容场景。热路径请用 {@link dotInt8}。
 * @param {Float32Array|number[]} query 查询向量（float）。
 * @param {Int8Array} data 存储的 int8 向量。
 * @param {number} scale 反缩放系数。
 * @returns {number} 点积近似值。
 */
export function dotQuantized(query, data, scale) {
  const length = Math.min(query.length, data.length)
  let sum = 0
  for (let i = 0; i < length; i++) sum += query[i] * data[i]
  return sum * scale
}

/**
 * 纯整数点积：查询向量与存储向量都已是 int8。
 *
 * 实测这是 int8 方案能真正提速的关键——Int8Array × Int8Array 全程整数运算，
 * V8 可以做向量化优化；而 float × int8 的混合乘法反而比纯 float 更慢。
 * @param {Int8Array} queryData 查询的 int8 向量。
 * @param {number} queryScale 查询的反缩放系数。
 * @param {Int8Array} data 存储的 int8 向量。
 * @param {number} scale 存储的反缩放系数。
 * @returns {number} 点积近似值。
 */
export function dotInt8(queryData, queryScale, data, scale) {
  const length = queryData.length < data.length ? queryData.length : data.length
  let sum = 0
  for (let i = 0; i < length; i++) sum += queryData[i] * data[i]
  return sum * queryScale * scale
}

/**
 * 判断某个档位是否需要把向量压成 int8 存储。
 * @param {string} strategy 策略名。
 * @returns {boolean} 是否量化。
 */
export function usesQuantizedStorage(strategy) {
  return strategy === 'tiered'
}

/**
 * 判断某个档位是否需要在扫描前做 SQL 预筛。
 * @param {string} strategy 策略名。
 * @returns {boolean} 是否预筛。
 */
export function usesPrefilter(strategy) {
  return strategy === 'prefilter' || strategy === 'tiered'
}
