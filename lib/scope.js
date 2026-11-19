/**
 * 作用域（scope）解析：按工作区隔离，支持搬迁时的路径映射。
 *
 * scope 的形态：`workspace:<规范化绝对路径>` 或 `global`。
 * 规范化 = 正斜杠、盘符小写、去尾斜杠，保证 web 与 desktop 在同一个目录下算出同一个 scope。
 */

/**
 * 规范化路径：统一成 `c:/users/x/...` 形态。
 *
 * Windows 路径大小写不敏感，所以整体小写——否则 `C:\Users\User\system` 与
 * `c:\users\user\system` 会被算成两个 scope，记忆就分家了。
 * @param {string} input 原始路径。
 * @returns {string} 规范化后的路径。
 */
export function normalizePath(input) {
  let value = String(input ?? '').trim().replace(/\\/g, '/')
  if (value === '') return ''
  const looksWindows = /^[A-Za-z]:/.test(value) || value.startsWith('//')
  if (looksWindows) value = value.toLowerCase()
  value = value.replace(/\/+$/, '')
  return value
}

/**
 * 按配置的 `scopeMap` 做前缀替换（搬迁用）。
 * @param {Record<string,string>} scopeMap 旧前缀 → 新前缀。
 * @param {string} path 已规范化的路径。
 * @returns {string} 映射后的路径。
 */
export function applyScopeMap(scopeMap, path) {
  if (scopeMap === null || typeof scopeMap !== 'object') return path
  let best = null
  for (const [from, to] of Object.entries(scopeMap)) {
    const normalizedFrom = normalizePath(from)
    if (normalizedFrom === '' || typeof to !== 'string') continue
    if (path === normalizedFrom || path.startsWith(`${normalizedFrom}/`)) {
      if (best === null || normalizedFrom.length > best.from.length) best = { from: normalizedFrom, to }
    }
  }
  if (best === null) return path
  const rest = path.slice(best.from.length)
  return normalizePath(best.to) + rest
}

/**
 * 计算一条消息的 scope。
 * @param {{scopeMode:string, scopeMap:Record<string,string>}} settings 运行时设置。
 * @param {string|undefined} cwd 会话工作区。
 * @returns {string} scope 字符串。
 */
export function resolveScope(settings, cwd) {
  if (settings.scopeMode === 'global') return 'global'
  const normalized = normalizePath(cwd)
  if (normalized === '') return 'workspace:unknown'
  return `workspace:${applyScopeMap(settings.scopeMap, normalized)}`
}

/**
 * 判断某个 scope 是否在当前设置下可见（召回时用）。
 * @param {{scopeMode:string}} settings 运行时设置。
 * @param {string} current 当前会话的 scope。
 * @param {string} candidate 候选记忆的 scope。
 * @returns {boolean} 是否可见。
 */
export function isScopeVisible(settings, current, candidate) {
  if (candidate === 'global') return true
  if (settings.scopeMode === 'global') return true
  return candidate === current
}
