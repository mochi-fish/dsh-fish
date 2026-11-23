/**
 * claim.test.mjs —— 桥自建的会话，等一封外面来的信才认（2026-11-23）
 *
 * 病根：1.0.8 起按会话 id 认她。桥用自己起的会话把 QQ / Telegram 的话 prompt 进来，
 * 那条会话 id 不在我们的台账里，cwd 却和她的屋子一样。只按 cwd 认会把他本人开在
 * 同一个工作区的普通会话也当成她（1.0.7 的原误伤）；只按 id 认，桥的会话就永远
 * 挂不上身份、收不了工具面，像换了一条鱼。
 *
 * 所以钉四件事：
 *   ① 来信判据：群聊 / 群里的他 / 没有 clientTimeZone 的 human 才算桥；
 *   ② 登记本身：同一个会话只跑一次，两个家互不串；
 *   ③ 收窄：认领前不碰，认领后按她的白名单收；
 *   ④ 身份：认领前一段不挂，认领后补挂。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  whenHers, claimSession, isBridgeMessage, resetClaimWaiters, pendingClaimCount,
} from '../lib/claim.js'
import { registerToolRestrict, resetHerSessions } from '../lib/restrict.js'
import { registerIdentity } from '../lib/identity.js'
import { registerTurns } from '../lib/turns.js'
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

function herAgent(sid, cwd, calls = [], guards = []) {
  return {
    session: { header: { id: sid, cwd } },
    ctx: {
      tools: {
        restrict: (filter) => { calls.push(filter); return () => {} },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
      effect: () => {},
    },
  }
}

test('来信判据：群聊 / 群里的他 / 没有时区的 human 才算桥', () => {
  assert.equal(isBridgeMessage('group', {}), true)
  assert.equal(isBridgeMessage('group-owner', { clientTimeZone: 'Asia/Shanghai' }), true, '群里的他也算外面来的')
  assert.equal(isBridgeMessage('human', {}), true, '桥 prompt 进来的话没有时区')
  assert.equal(isBridgeMessage('human', { clientTimeZone: 'Asia/Shanghai' }), false, '本地客户端打的字有时区')
  assert.equal(isBridgeMessage('plugin', {}), false, '插件自己的记账不算')
  assert.equal(isBridgeMessage('unknown', {}), false)
  assert.equal(isBridgeMessage('context', {}), false, '宿主上下文没有 source，不算')
})

test('登记只跑一次；两个家、两条会话互不串', () => {
  resetClaimWaiters()
  let a = 0
  let b = 0
  whenHers('session-a', 'C:\\fish-a\\home', () => { a += 1 })
  whenHers('session-a', 'C:\\fish-a\\home', () => { b += 1 })
  whenHers('session-b', 'C:\\fish-b\\home', () => { b += 10 })
  assert.equal(pendingClaimCount(), 3)

  assert.equal(claimSession('session-a', 'C:\\fish-b\\home'), false, 'B 家的信认不了 A 家的会话')
  assert.equal(a + b, 0)

  assert.equal(claimSession('a', 'C:/fish-a/home/'), true, '前缀、斜杠、大小写不该影响认领')
  assert.equal(a, 1)
  assert.equal(b, 1)
  assert.equal(claimSession('session-a', 'C:\\fish-a\\home'), false, '认过一次就清掉，不重复装备')
  assert.equal(a, 1)
  assert.equal(pendingClaimCount(), 1, '只剩 B 家那条会话在等')
  resetClaimWaiters()
})

test('收窄：cwd 是她的屋子但 id 不在册，认领前一下都不碰', () => {
  resetHerSessions()
  resetClaimWaiters()
  const her = 'C:\\her-home'
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: her, log: () => {} })

  const calls = []
  const guards = []
  const agent = herAgent('session-bridge-1', her, calls, guards)

  ctx.emit('agent/created', { agent })
  assert.equal(calls.length, 0, '认领前不许收窄：他本人也可能开在这个工作区')
  assert.equal(guards.length, 0, '兜底守卫也不许挂')

  claimSession('session-bridge-1', her)
  assert.equal(calls.length, 1, '认领后按她的白名单收一次')
  assert.equal(guards.length, 1, '认领后把兜底守卫挂上')
  resetHerSessions()
  resetClaimWaiters()
})

test('身份：认领前一段不挂，认领后补挂', async () => {
  resetHerSessions()
  resetClaimWaiters()
  const root = await mkdtemp(join(tmpdir(), 'fish-claim-'))
  const her = paths(root).herDir
  const ctx = fakeCtx()
  registerIdentity(ctx, { root, herDir: her, log: () => {} })

  const sections = []
  const agent = {
    session: { header: { id: 'session-bridge-2', cwd: her } },
    ctx: { systemPrompt: { section: (o) => { sections.push(o); return () => {} } } },
  }
  ctx.emit('agent/created', { agent })
  assert.equal(sections.length, 0, '桥还没来信，先不挂她的身份')

  claimSession('session-bridge-2', her)
  assert.ok(sections.length >= 7, `第一封外面来的信到了，身份段补挂上（实挂 ${sections.length} 段）`)
  resetClaimWaiters()
})

test('桥接全链路：群里的话进来才认领，本地客户端的字不算', async () => {
  resetHerSessions()
  resetClaimWaiters()
  const root = await mkdtemp(join(tmpdir(), 'fish-claim-turn-'))
  const her = paths(root).herDir
  const ctx = fakeCtx()
  registerTurns(ctx, { root, log: () => {} })

  let claimed = 0
  whenHers('session-bridge-3', her, () => { claimed += 1 })
  const session = { id: 'session-bridge-3', header: { cwd: her } }
  const msg = (source) => ({
    type: 'user/message',
    data: { id: `m-${Math.random()}`, role: 'user', content: [{ type: 'text', text: '在吗' }], source },
  })

  ctx.emit('session/event', session, msg({ kind: 'user', clientTimeZone: 'Asia/Shanghai' }))
  assert.equal(claimed, 0, '他自己打的字永远等不到那封信之外的东西，不许认领')

  ctx.emit('session/event', session, msg({ kind: 'qq', form: 'relay' }))
  assert.equal(claimed, 1, '桥转进来的话没有时区，第一封到就认')
  resetClaimWaiters()
})
