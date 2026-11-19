/**
 * 单写者租约：保证「web 与 desktop 同时开着」时，后台任务只被一个进程消费。
 *
 * 做法：一个 JSON 锁文件（`worker.lock`），内容是 pid + 主机名 + 心跳时间。
 * - 心跳新鲜（< ttl）→ 别人持有，本进程跳过轮询；
 * - 心跳过期（进程崩了）→ 可以接管；
 * - 写文件用「先写临时文件再 rename」保证原子，不会读到半个 JSON。
 *
 * 注意：这是**协作式**租约，不是安全边界。它的目的只是避免重复烧 API 额度，
 * 不是防恶意进程。
 */

import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

const DEFAULT_TTL_MS = 180_000
const DEFAULT_HEARTBEAT_MS = 60_000

/**
 * 创建租约对象。
 * @param {{path:string, logger?:object, now?:Function, ttlMs?:number}} options 选项。
 * @returns {{tryAcquire:Function, renew:Function, release:Function, isHeld:Function, holder:Function}} 租约。
 */
export function createLease({ path, logger, now = Date.now, ttlMs = DEFAULT_TTL_MS }) {
  // 每个租约实例一个唯一 id：不能用 pid 判断「是不是自己的锁」——
  // 同一进程里建两个实例（测试、或插件被重复 apply）时 pid 相同会互相误认。
  const instanceId = randomUUID()
  const identity = { pid: process.pid, host: hostname(), instanceId, since: now(), heartbeat: now() }
  let held = false

  function readLock() {
    try {
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return null
      return parsed
    } catch {
      return null
    }
  }

  function writeLock() {
    const temp = `${path}.${process.pid}.tmp`
    const fd = openSync(temp, 'w')
    try {
      writeFileSync(fd, JSON.stringify(identity))
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  }

  return {
    /** 是否由本进程持有。 */
    isHeld() {
      return held
    },

    /** 当前持有者信息（诊断用）。 */
    holder() {
      const lock = readLock()
      if (lock === null) return null
      return { pid: lock.pid, host: lock.host, heartbeat: lock.heartbeat, mine: held }
    },

    /**
     * 尝试获取或确认租约。
     * @returns {boolean} 是否由本进程持有。
     */
    tryAcquire() {
      const lock = readLock()
      if (lock === null) {
        try {
          writeLock()
          held = true
        } catch (error) {
          logger?.warn?.(`dafa-fish-memory: 租约写入失败：${String(error)}`)
          held = false
        }
        return held
      }
      // 自己的锁（按实例 id 判断）→ 续期
      if (String(lock.instanceId) === instanceId) {
        identity.heartbeat = now()
        try {
          writeLock()
          held = true
        } catch {
          held = false
        }
        return held
      }
      // 别人持有且心跳新鲜 → 让出去
      const age = now() - Number(lock.heartbeat ?? 0)
      if (Number.isFinite(age) && age < ttlMs) {
        held = false
        return false
      }
      // 心跳过期 → 接管
      identity.since = now()
      identity.heartbeat = now()
      try {
        writeLock()
        held = true
        logger?.info?.(`dafa-fish-memory: 接管后台任务租约（原持有者 ${lock.host}/${lock.pid} 心跳已过期）`)
      } catch {
        held = false
      }
      return held
    },

    /** 续期（仅在自己持有时）。 */
    renew() {
      if (!held) return false
      identity.heartbeat = now()
      try {
        writeLock()
        return true
      } catch {
        held = false
        return false
      }
    },

    /** 主动释放。 */
    release() {
      if (!held) return
      held = false
      try {
        unlinkSync(path)
      } catch {
        /* 文件可能已被别人接管，忽略 */
      }
    },
  }
}
