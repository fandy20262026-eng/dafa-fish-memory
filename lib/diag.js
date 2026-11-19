/**
 * 诊断事件流：一行一个事件，写到 `$DSH_HOME/memory-sf/diag.jsonl`。
 *
 * 为什么需要它：2026-11-18 那次「Web 失去响应」只能靠事后翻会话日志和数据库反推，
 * 因为插件当时什么都没记。有了这个文件，下次可以直接看出：
 * 召回花了多久、命中了几个通道、有没有超时、注入多长。
 *
 * 写入一律异步，且失败静默——诊断绝不能反过来影响主流程。
 */

import { appendFile } from 'node:fs'

/**
 * 创建诊断写入器。
 * @param {{path:string, maxBytes?:number, logger?:object}} options 选项。
 * @returns {{write:Function}} 写入器。
 */
export function createDiag({ path, logger }) {
  let pending = 0
  let muted = false

  return {
    /**
     * 写一个事件。
     * @param {object} event 事件负载（至少含 `event` 字段）。
     */
    write(event) {
      if (muted) return
      // 极端情况下（磁盘满/落盘失败）持续失败会拖慢进程，连续失败就静音
      if (pending > 64) return
      pending++
      let line
      try {
        line = `${JSON.stringify({ ts: Date.now(), ...event })}\n`
      } catch {
        pending--
        return
      }
      appendFile(path, line, error => {
        pending--
        if (error !== null && error !== undefined) {
          muted = true
          logger?.warn?.(`dafa-fish-memory: 诊断日志写入失败，已静音：${error.message}`)
        }
      })
    },
  }
}
