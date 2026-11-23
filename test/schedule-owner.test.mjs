/**
 * schedule-owner.test.mjs —— 宿主的闹钟不是她的，她不改（2026-11-24）
 *
 * 事故（`E:\QQ聊天记录\...\阿留-闹钟指错会话-事故记录-20261123.md`）：
 * 装了两条鱼的人，她那边的会话用 `schedule_edit` + `target:"this_session"`
 * 把另一位（廿八）的读书闹钟一起改指到了自己窗口，到点宿主把写给廿八的
 * 指令原样投进她的会话。宿主任务没有 owner 字段、改 target 也不校验归属。
 *
 * 插件只守一层：改之前核一次「这条是不是我的」——
 *   ① 她建过的（本子记了 id）→ 放行；
 *   ② 目录里这条的 target 是她的会话 → 放行；
 *   ③ 目录里没有 / 读不到 → 放行（宁可偶尔放过，不因读不到把她的手锁死）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ledgerSessionOf, readScheduleLedger, rememberSchedule, scheduleIdOf,
  targetSessionOf, isHerSchedule, scheduleLedgerFile,
} from '../lib/schedules.js'
import { rememberHerSession, resetHerSessions, isHerSessionId, registerToolRestrict } from '../lib/restrict.js'
import { paths } from '../lib/store.js'

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'fish-sched-'))
  await mkdir(paths(root).root, { recursive: true })
  return root
}

test('归属本子：记过才认，坏了当空', async () => {
  const root = await tempRoot()
  assert.equal(ledgerSessionOf(root, 'schedule-a'), undefined)
  rememberSchedule(root, 'schedule-a', 'session-her-1')
  assert.equal(ledgerSessionOf(root, 'schedule-a'), 'session-her-1')
  assert.equal(ledgerSessionOf(root, 'schedule-b'), undefined)

  await writeFile(scheduleLedgerFile(root), '{ 坏掉的 json', 'utf8')
  assert.deepEqual(readScheduleLedger(root), {}, '读坏了当空，不抛')
})

test('判据：本子 / target / 读不到', async () => {
  const root = await tempRoot()
  const her = paths(root).herDir
  const isMine = (sid) => sid === 'session-her-1'
  const svc = (entries) => ({ catalog: async () => entries })

  rememberSchedule(root, 'schedule-noted', '')
  assert.equal(await isHerSchedule({ root, id: 'schedule-noted', herDir: her, service: undefined, isHerSessionId: isMine }), true, '本子里记过 → 放行')

  assert.equal(await isHerSchedule({
    root, id: 'schedule-other', herDir: her,
    service: svc([{ id: 'schedule-other', target: { kind: 'session', sessionId: 'session-other' } }]),
    isHerSessionId: isMine,
  }), false, '目录里是别人的会话 → 挡')

  assert.equal(await isHerSchedule({
    root, id: 'schedule-mine', herDir: her,
    service: svc([{ id: 'schedule-mine', target: { kind: 'session', sessionId: 'session-her-1' } }]),
    isHerSessionId: isMine,
  }), true, '目录里是她的会话 → 放行')

  assert.equal(await isHerSchedule({
    root, id: 'schedule-gone', herDir: her, service: svc([]), isHerSessionId: isMine,
  }), true, '目录里找不到 → 放行（别把她的手锁死）')

  assert.equal(await isHerSchedule({
    root, id: 'schedule-x', herDir: her,
    service: { catalog: async () => { throw new Error('boom') } },
    isHerSessionId: isMine,
  }), true, '宿主读不到 → 放行')
})

test('返回值里把 id / target 拿出来', () => {
  assert.equal(scheduleIdOf({ id: 'schedule-a' }), 'schedule-a')
  assert.equal(scheduleIdOf({ task: { id: 'schedule-b' } }), 'schedule-b')
  assert.equal(scheduleIdOf(null), '')
  assert.equal(targetSessionOf({ target: { kind: 'new_once', sessionId: 'session-1' } }), 'session-1')
  assert.equal(targetSessionOf({}), '')
})

test('会话 id 只认她的台账；他没被写进别的家', () => {
  resetHerSessions()
  const her = 'C:\\her-home'
  rememberHerSession('session-her-1', her)
  assert.equal(isHerSessionId('session-her-1', her), true)
  assert.equal(isHerSessionId('session-her-1', 'C:\\other-home'), false, '别的家不认这条')
  assert.equal(isHerSessionId('session-other', her), false)
  resetHerSessions()
})

test('她真去改别人的闹钟：pre-execute 直接挡住', async () => {
  resetHerSessions()
  const root = await tempRoot()
  const her = paths(root).herDir
  rememberHerSession('session-her-1', her)

  const listeners = new Map()
  const ctx = {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
      return () => {}
    },
    emit(ev, ...args) { for (const fn of listeners.get(ev) ?? []) fn(...args) },
    get(name) {
      if (name !== 'schedule') return undefined
      return { catalog: async () => [{ id: 'schedule-other', target: { kind: 'session', sessionId: 'session-other' } }] }
    },
  }
  registerToolRestrict(ctx, { root, herDir: her, extra: ['schedule_edit', 'schedule_create'], log: () => {} })

  const pre = []
  const agent = {
    session: { header: { id: 'session-her-1', cwd: her } },
    ctx: {
      tools: { restrict: () => () => {}, guard: () => () => {}, view: () => null },
      on(ev, fn) { if (ev === 'tools/pre-execute') pre.push(fn); return () => {} },
      effect: () => {},
    },
  }
  ctx.emit('agent/created', { agent })
  assert.equal(pre.length, 1, '她的 agent 上要挂一条 pre-execute')

  let nexted = 0
  const next = () => { nexted += 1; return { kind: 'continue' } }
  const denied = await pre[0]({ name: 'schedule_edit', arguments: { id: 'schedule-other' }, agent }, next)
  assert.equal(denied?.kind, 'deny')
  assert.equal(denied?.reason, '这条不在我这儿，我改不了。')
  assert.equal(nexted, 0, '挡住就不该往下走')

  const passed = await pre[0]({ name: 'schedule_edit', arguments: { id: 'schedule-unknown' }, agent }, next)
  assert.equal(passed?.kind, 'continue', '目录里没有的照旧放行')
  assert.equal(nexted, 1)

  const untouched = await pre[0]({ name: 'schedule_create', arguments: {}, agent }, next)
  assert.equal(untouched?.kind, 'continue', '建任务不经过这道门')
  assert.equal(nexted, 2)
  resetHerSessions()
})
