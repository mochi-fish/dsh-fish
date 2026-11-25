/**
 * bridgeclaim.js —— 桥显式认领（1.1.1，用户 m03155 / m03165）
 *
 * 为什么要有：市面上的 QQ / OneBot 桥大多自己建会话、自己 followup，cwd 不在
 * `~/.dsh-fish/home`，也不一定走宿主 `prompt()`；1.0.9 的「第一封外面来的信」那条
 * 自动路看不见它们，身份段就永远挂不上。这里给桥一个**显式点名**的口子：
 * `POST /claim { sessionId }`，不猜来源、不靠 cwd 当身份。
 *
 * 四道闸门（少一道都不行）：
 *   ① `bridge.claim` 默认关，开了才认；
 *   ② 必须带 `bridge.token`（与 /say 同一个 token）；
 *   ③ 会话必须是**活着**的 agent，且创建不超过 10 分钟（`CLAIM_MAX_AGE_MS`）；
 *   ④ 群房 / 已在册的她的会话都不走这条路。
 *
 * 认领是**双向**的：`/release` 把 id 从台账里摘掉、拆掉身份段；但 `ctx.tools.restrict`
 * 收窄下去的工具面没法在同一个 agent 上还原（宿主没有「放宽」的口子），所以 release
 * 只保证「以后不再按她对待」，要连工具面一起恢复得让那条会话重开。这一点在文档里
 * 写清，不假装能热还原。
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { agentFor, equipClaimed, forgetClaimed, wasClaimed } from './claim.js'
import { forgetHerSession, isHerSessionId } from './restrict.js'
import { detachOutside } from './identity.js'
import { isChannelSession } from './channels.js'

/** 会话创建后多久内还接受认领。桥在会话刚建好时点名，超时说明是旧窗口。 */
export const CLAIM_MAX_AGE_MS = 10 * 60_000

const SID_RE = /^[A-Za-z0-9_-]{8,}$/

export function bridgeRecordFile(root) {
  return join(root, 'bridge.json')
}

/** 认领记录只是账，不是权限来源；读坏了当空，永远不因为读盘失败挡住认领。 */
export function readBridgeRecord(root) {
  try {
    const raw = JSON.parse(readFileSync(bridgeRecordFile(root), 'utf8'))
    const sessions = raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
    return { version: 1, sessions: { ...sessions } }
  } catch {
    return { version: 1, sessions: {} }
  }
}

function writeBridgeRecord(root, record) {
  try {
    const file = bridgeRecordFile(root)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch { /* 记账失败不影响认领本身 */ }
}

function noteClaim(root, sid, patch) {
  const rec = readBridgeRecord(root)
  const prev = rec.sessions[sid] ?? {}
  rec.sessions[sid] = { ...prev, ...patch }
  // 只留最近 500 条，防一个坏桥每天刷爆文件。
  const keys = Object.keys(rec.sessions)
  if (keys.length > 500) {
    keys.sort((a, b) => Number(rec.sessions[a]?.claimedAt ?? 0) - Number(rec.sessions[b]?.claimedAt ?? 0))
    for (const k of keys.slice(0, keys.length - 500)) delete rec.sessions[k]
  }
  writeBridgeRecord(root, rec)
}

function createdAtOf(agent) {
  const header = agent?.session?.header ?? agent?.session ?? {}
  const n = Number(header?.createdAt ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function sidOf(sessionId) {
  return String(sessionId ?? '').trim().replace(/^session-/, '')
}

/**
 * 点名认领一条桥自建的会话。
 *
 * @param {{ root?: string, sessionId?: string, herDir?: string, now?: number, log?: (msg: string) => void }} [opts]
 * @returns {{ ok: boolean, code: string, sessionId: string, why?: string }}
 *   code: ok / already / unknown_session / not_live / too_old / refused / not_waiting
 */
export function claimBridgeSession({ root = '', sessionId = '', herDir = '', now = Date.now(), log } = {}) {
  const sid = sidOf(sessionId)
  if (!SID_RE.test(sid)) {
    return { ok: false, code: 'unknown_session', sessionId: sid, why: '会话 id 不像宿主给的形状' }
  }
  if (isHerSessionId(sid, herDir)) {
    return { ok: true, code: 'already', sessionId: sid }
  }
  const agent = agentFor(sid)
  if (!agent) {
    return { ok: false, code: 'not_live', sessionId: sid, why: '这条会话不在这一趟里（插件启动前建的，或已经关了）' }
  }
  const born = createdAtOf(agent)
  if (born && now - born > CLAIM_MAX_AGE_MS) {
    return { ok: false, code: 'too_old', sessionId: sid, why: '这条会话建好太久了，桥应该在刚建好时认领' }
  }
  const ran = equipClaimed(sid)
  if (!ran) {
    return { ok: false, code: 'not_waiting', sessionId: sid, why: '这条会话没有可认领的装备（可能本来就是她，或宿主先于插件建了它）' }
  }
  const good = isHerSessionId(sid, herDir)
  noteClaim(root, sid, { claimedAt: now, via: 'claim', cwd: String(agent?.session?.header?.cwd ?? '') })
  log?.(`[dsh-fish] 桥点名认领了一条会话：${sid}${born ? '' : '（没有 createdAt，按新会话处理）'}`, 'debug')
  return good
    ? { ok: true, code: 'ok', sessionId: sid }
    : { ok: false, code: 'refused', sessionId: sid, why: '认领跑完了，但台账里还是没有这条会话' }
}

/**
 * 撤回一次显式认领。群房不归这条路（群房有自己的台账），返回 refused。
 * 工具面在这个 agent 上收不回来，只能保证以后不再按她对待——文档写清。
 */
export async function releaseBridgeSession({ root = '', sessionId = '', herDir = '', now = Date.now() } = {}) {
  const sid = sidOf(sessionId)
  if (!SID_RE.test(sid)) return { ok: false, code: 'unknown_session', sessionId: sid }
  if (await isChannelSession(root, sid)) {
    return { ok: false, code: 'refused', sessionId: sid, why: '群房不归 /release 管' }
  }
  const known = isHerSessionId(sid, herDir) || wasClaimed(sid)
  const agent = agentFor(sid)
  forgetHerSession(sid, herDir)
  forgetClaimed(sid)
  let removed = 0
  if (agent) {
    try { removed = detachOutside(agent).removed ?? 0 } catch { /* 已经拆过就算了 */ }
  }
  noteClaim(root, sid, { releasedAt: now })
  if (!known) return { ok: false, code: 'unknown_session', sessionId: sid }
  return { ok: true, code: 'ok', sessionId: sid, removed }
}

