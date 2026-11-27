/**
 * quota.js —— 配额类拒绝留一行可查的日志（2026-11-28，issue #179 后续）
 *
 * 起因：外部报告（aiyouniganma6767）说撞每日上限时回给使用者的话够用，但排障时
 * 只知道「满了」，不知道是**哪一项**满了、**今天用了多少**。写入口分散在 works /
 * letter / dream / appoint / 群友旁听这几处，每处的配额算法都不一样，只靠那句文案
 * 反推很费劲。
 *
 * 所以这里只做一件事：把 kind 与当日计数写进运行日志（`~/.dsh-fish/logs/`）。
 * **不改任何返回值、不改给使用者看的文案**——配额是防刷屏的，不该变成她脑子里
 * 的一条限制；日志是给人看的东西。
 *
 * 日志走 info 级：这不是错误，是预期内的拦住。
 */

import { logLine } from './log.js'

/**
 * 记一行「配额满了，这一步没写」。
 *
 * @param {string} kind   哪一项配额（work / letter / dream / appoint / others-voice …）
 * @param {{ used?: number, cap?: number, root?: string, note?: string }} [o]
 * @returns {boolean} 写没写进去（永不抛）
 */
export function logQuotaSkip(kind, { used = 0, cap = 0, root, note = '' } = {}) {
  const n = Math.max(0, Math.trunc(Number(used) || 0))
  const c = Math.max(0, Math.trunc(Number(cap) || 0))
  const why = String(note ?? '').replace(/\s+/g, ' ').trim()
  return logLine(
    'info',
    ['配额满了，这一步没写：', `kind=${String(kind || '?')}`, `today=${n}/${c}`, ...(why ? [`why=${why}`] : [])],
    root,
  )
}
