/**
 * bridge-claim.test.mjs —— 桥显式点名认领（1.1.1）
 *
 * 三类桥（Derpyu520/qq-bridge、qq-bridge-plus、NoMindSama/qq-dsh-bridge 等）都自己
 * 建会话，cwd 不一定在 `~/.dsh-fish/home`。1.0.9 的「第一封外面来的信」看不见它们，
 * 身份段就永远挂不上。这里钉的是显式口子 `/claim` 的四道闸门与 /release 的边界。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  agentFor, equipClaimed, rememberAgent, resetClaimWaiters, whenClaimed, whenHers,
} from '../lib/claim.js'
import { registerToolRestrict, isHerSessionId, resetHerSessions } from '../lib/restrict.js'
import { registerIdentity } from '../lib/identity.js'
import { claimBridgeSession, releaseBridgeSession, CLAIM_MAX_AGE_MS, readBridgeRecord } from '../lib/bridgeclaim.js'
import { normalizeConfig } from '../lib/settings.js'
import { paths } from '../lib/store.js'

function fakeCtx() {
  const listeners = new Map()
  return {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
      return () => {}
    },
    emit(ev, ...args) {
      for (const fn of listeners.get(ev) ?? []) fn(...args)
    },
  }
}

function agentOf(sid, cwd, createdAt = Date.now()) {
  const calls = []
  const guards = []
  const sections = []
  const agent = {
    session: { header: { id: sid, cwd, createdAt } },
    ctx: {
      tools: {
        restrict: (filter) => { calls.push(filter); return () => {} },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
      systemPrompt: { section: (o) => { sections.push(o); return () => {} }, context: (o) => { sections.push(o); return () => {} } },
      effect: () => {},
    },
  }
  return { agent, calls, guards, sections }
}

test('显式认领的账：agent 能按 id 找回，装备只跑一次', () => {
  resetClaimWaiters()
  const a = agentOf('session-claim-1', 'D:\\bridge\\room')
  rememberAgent('session-claim-1', a.agent)
  assert.equal(agentFor('session-claim-1'), a.agent)
  assert.equal(agentFor('claim-1'), a.agent, 'session- 前缀两边都能对上')

  let n = 0
  whenClaimed('claim-1', () => { n += 1 })
  whenClaimed('claim-1', () => { n += 10 })
  assert.equal(equipClaimed('claim-1'), 2)
  assert.equal(n, 11)
  assert.equal(equipClaimed('claim-1'), 0, '认过一次就清掉，不重复装备')

  // 显式认领的账不能被 whenHers 的自动路吃掉。
  let auto = 0
  whenHers('claim-2', 'D:\\fish\\home', () => { auto += 1 })
  whenClaimed('claim-2', () => { n += 100 })
  assert.equal(auto, 0)
  assert.equal(equipClaimed('claim-2'), 1)
  assert.equal(n, 111)
  resetClaimWaiters()
})

test('配置：bridge.dirs 去重去空、claim 只认 true、token 去空白', () => {
  const c = normalizeConfig({
    bridge: {
      port: 17800,
      dirs: [' D:\\bridge\\one ', 'd:\\bridge\\one', '', 42, 'D:\\bridge\\two'],
      claim: 'yes',
      token: '  s3cret  ',
    },
  })
  // 非字符串（42）直接被当成坏值丢掉，不写成 "42" 这种半截目录。
  assert.deepEqual(c.bridge.dirs, ['D:\\bridge\\one', 'D:\\bridge\\two'])
  assert.equal(c.bridge.claim, false, '字符串 yes 不算开，必须显式 true')
  assert.equal(c.bridge.token, 's3cret')
  assert.deepEqual(normalizeConfig({}).bridge, { port: 0, dirs: [], claim: false, token: '' })
})

test('bridge.dirs 里的会话：建时不挂，点名才挂身份并收窄', async () => {
  resetHerSessions()
  resetClaimWaiters()
  const root = await mkdtemp(join(tmpdir(), 'fish-bridge-claim-'))
  const her = paths(root).herDir
  const bridgeDir = join(root, 'qq-bridge')
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { root, herDir: her, log: () => {}, bridgeDirs: [bridgeDir] })
  registerIdentity(ctx, { root, herDir: her, log: () => {}, bridgeDirs: [bridgeDir] })

  const { agent, calls, guards, sections } = agentOf('session-qq-new-1', join(bridgeDir, 'room'))
  ctx.emit('agent/created', { agent })
  assert.equal(calls.length, 0, '建会话时一个工具都不收：目录只是登记条件')
  assert.equal(sections.length, 0, '建会话时身份一段都不挂')

  const r = claimBridgeSession({ root, sessionId: 'session-qq-new-1', herDir: her })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.code, 'ok')
  assert.equal(isHerSessionId('qq-new-1', her), true)
  assert.ok(calls.length >= 1, '认领后收一次工具面')
  assert.ok(guards.length >= 1, '认领后挂上兜底守卫')
  assert.ok(sections.length >= 7, `认领后补挂身份段（实挂 ${sections.length}）`)

  const again = claimBridgeSession({ root, sessionId: 'session-qq-new-1', herDir: her })
  assert.equal(again.code, 'already', '同一条会话再点名一次是 already，不重复挂')

  const rec = readBridgeRecord(root)
  assert.equal(rec.sessions['qq-new-1'].via, 'claim')
  assert.ok(rec.sessions['qq-new-1'].claimedAt > 0)
  resetHerSessions()
  resetClaimWaiters()
})

test('不满足闸门的点名叫不动：不在这一趟 / 太旧 / 本来就在册', async () => {
  resetHerSessions()
  resetClaimWaiters()
  const root = await mkdtemp(join(tmpdir(), 'fish-bridge-gate-'))
  const her = paths(root).herDir
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { root, herDir: her, log: () => {}, bridgeDirs: [root] })
  registerIdentity(ctx, { root, herDir: her, log: () => {}, bridgeDirs: [root] })

  const missing = claimBridgeSession({ root, sessionId: 'session-not-here-1', herDir: her })
  assert.equal(missing.code, 'not_live')

  const stale = agentOf('session-old-bridge-1', her, Date.now() - CLAIM_MAX_AGE_MS - 1)
  ctx.emit('agent/created', { agent: stale.agent })
  const tooOld = claimBridgeSession({ root, sessionId: 'session-old-bridge-1', herDir: her })
  assert.equal(tooOld.code, 'too_old')
  assert.equal(isHerSessionId('old-1', her), false)

  const weird = claimBridgeSession({ root, sessionId: '../etc/passwd', herDir: her })
  assert.equal(weird.code, 'unknown_session', '不是宿主形状的 id 直接拒')

  // release：拆身份段、摘台账；同一 agent 的工具面收不回来（文档写清）。
  const { agent, sections } = agentOf('session-qq-new-2', her)
  ctx.emit('agent/created', { agent })
  assert.equal(claimBridgeSession({ root, sessionId: 'session-qq-new-2', herDir: her }).ok, true)
  const rel = await releaseBridgeSession({ root, sessionId: 'session-qq-new-2', herDir: her })
  assert.equal(rel.ok, true, JSON.stringify(rel))
  assert.ok(rel.removed >= 1, '身份段要拆掉')
  assert.equal(sections.length >= 7, true, '曾经挂过（挂的段数只增不减是宿主的 section 记录）')
  assert.equal(isHerSessionId('qq-new-2', her), false, '台账里摘掉了')
  resetHerSessions()
  resetClaimWaiters()
})


