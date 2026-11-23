/**
 * schedules.js —— 宿主闹钟的归属（2026-11-24）
 *
 * 为什么要有：宿主的 `schedule_list` 列的是**全部**任务，任务记录里也没有
 * 「这条属于谁」的字段；`schedule_edit` 只认 id，改 target 时不校验归属。
 * 2026-11-23 的事故就是这么来的——一位装了两条鱼的用户，她那边的会话把
 * 另一位「廿八」的读书闹钟一起改指到了自己窗口（`this_session`），到点后
 * 宿主把写给廿八的指令原样投进了她的会话。
 *
 * 插件管不到宿主的调度器，但可以管住她伸出去的那只手：
 *   - `schedule_create` 成功时，把新任务的 id 与当时的 target 记进本子；
 *   - `schedule_edit` 之前先问一句「这条是不是我的」：本子里有、或者当前
 *     target 是她的会话，才放行。
 *
 * 本子是 `schedules.json`（在 root，不在她的房间里），只存 id → 会话 id：
 * 不是她的记录工具，也不进事件流。读坏了当空，永不抛。
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './store.js'

const FILE = 'schedules.json'

export function scheduleLedgerFile(root) {
  return join(paths(root || undefined).root, FILE)
}

/** 读归属本子；坏了/没有都当空。 */
export function readScheduleLedger(root) {
  try {
    const raw = JSON.parse(readFileSync(scheduleLedgerFile(root), 'utf8'))
    const map = raw?.schedules ?? raw
    if (map && typeof map === 'object' && !Array.isArray(map)) return map
  } catch { /* 坏了当空 */ }
  return {}
}

/** 记一条「这条是她建的」。写不进去也不影响主流程（还有按 target 判那一道）。 */
export function rememberSchedule(root, id, sessionId) {
  const key = String(id ?? '')
  if (!key) return
  try {
    const map = readScheduleLedger(root)
    map[key] = String(sessionId ?? '')
    const file = scheduleLedgerFile(root)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ schedules: map }, null, 2))
    renameSync(tmp, file)
  } catch { /* ignore */ }
}

/** 本子里有没有这条；有就返回当时记的 target（可能为空串）。 */
export function ledgerSessionOf(root, id) {
  const map = readScheduleLedger(root)
  const key = String(id ?? '')
  return Object.prototype.hasOwnProperty.call(map, key) ? String(map[key] ?? '') : undefined
}

/** 宿主任务条目里的目标会话（两种 target 都有 sessionId）。 */
export function targetSessionOf(entry) {
  return String(entry?.target?.sessionId ?? '')
}

/**
 * 这条闹钟是不是她的。
 *
 * 判据顺序：
 *   ① 本子里记过 → 是（她建的；`new_once` 的保留会话还没出现在台账里也认）；
 *   ② 问宿主要目录，找到这条 → 看 target 是不是她的会话；
 *   ③ 目录里没有 / 宿主没给服务 / 问的时候出错 → 放行。
 *
 * ③ 是刻意的：宁可让她偶尔改到一条别人的（宿主到点也不会因此串台），
 * 也不因为她自己的任务在目录里暂时读不到就把她的手锁死。
 */
export async function isHerSchedule({ root, id, herDir, service, isHerSessionId }) {
  const key = String(id ?? '')
  if (!key) return true
  if (typeof isHerSessionId !== 'function') return true
  if (ledgerSessionOf(root, key) !== undefined) return true
  let entries
  try {
    entries = await service?.catalog?.()
  } catch { return true }
  if (!Array.isArray(entries)) return true
  const hit = entries.find((entry) => String(entry?.id ?? '') === key)
  if (!hit) return true
  const target = targetSessionOf(hit)
  if (!target) return false
  return isHerSessionId(target, herDir)
}

/** 宿主 schedule_create 的返回值里把 id 拿出来（不同版本字段位置略有差异）。 */
export function scheduleIdOf(value) {
  return String(value?.id ?? value?.task?.id ?? value?.value?.id ?? '')
}

