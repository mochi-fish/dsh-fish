// @ts-check
/**
 * reset-pending.test.mjs —— 「重开一局」先排好、启动时再搬（2026-11-28 外部报告）
 *
 * 报告里的真机序列：设置页点「确定，重开」→ 按钮 RESTORE、数据没动、日志一个字没有、
 * 页面也没报错。根因是运行中 root 里一直有文件被开着（日志 / 压力缓存 / 心跳 / 备份），
 * Windows 上父目录 rename 会 EPERM，而失败既没落日志、回执又在页顶（那张卡在页尾）。
 *
 * 这里守的是新的契约：
 *   · 点下去**先写意向书**（必须在数据目录之外），当场试一次；
 *   · 试不成 → 意向书留在 armed、attempts+1、不抛；下次 boot 再搬；
 *   · 搬之前写 running；下一次启动看见 running 说明上次半路断了 → failed，不自动重试；
 *   · 别的数据目录的意向书一律不碰。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MOD = '../lib/reset-pending.js'

/** 每个用例一个临时宇宙：root 在 tmp 下，意向书在 root **外面**。 */
async function world() {
  const tmp = await mkdtemp(join(tmpdir(), 'fish-reset-pending-'))
  const root = join(tmp, 'data')
  const marker = join(tmp, 'pending.json')
  const prev = process.env.DSH_FISH_RESET_PENDING
  process.env.DSH_FISH_RESET_PENDING = marker
  return {
    tmp,
    root,
    marker,
    async done() {
      if (prev === undefined) delete process.env.DSH_FISH_RESET_PENDING
      else process.env.DSH_FISH_RESET_PENDING = prev
      await rm(tmp, { recursive: true, force: true })
    },
  }
}

async function seedRoot(root) {
  await mkdir(join(root, 'home'), { recursive: true })
  await writeFile(join(root, 'events.jsonl'), '{"type":"seed"}\n', 'utf8')
  await writeFile(join(root, 'owner.json'), '{"mid":1}', 'utf8')
  await writeFile(join(root, 'config.json'), '{"a":1}', 'utf8')
  await writeFile(join(root, 'home', 'x.md'), '她的屋子\n', 'utf8')
}

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

test('armPending 只写意向书，数据目录一个字节都不动', async () => {
  const w = await world()
  try {
    const { armPending, readPending } = await import(MOD)
    await seedRoot(w.root)
    const before = await readFile(join(w.root, 'events.jsonl'), 'utf8')
    const r = armPending({ root: w.root, expect: { events: 1 }, retire: { wsId: 'ws_1', sessionId: 's_1' } })
    assert.equal(r.ok, true)
    assert.equal(r.already, false)
    assert.equal(await readFile(join(w.root, 'events.jsonl'), 'utf8'), before)
    const m = readPending()
    assert.equal(m?.phase, 'armed')
    assert.equal(m?.expect?.events, 1)
    assert.equal(m?.retire?.sessionId, 's_1')
    assert.equal(m?.attempts, 0)
  } finally { await w.done() }
})

test('重复 arm 同一目录：already，armedAt 不被刷新', async () => {
  const w = await world()
  try {
    const { armPending, readPending } = await import(MOD)
    const first = armPending({ root: w.root, now: new Date('2026-11-28T10:00:00Z') })
    const second = armPending({ root: w.root, now: new Date('2026-11-28T11:00:00Z') })
    assert.equal(second.already, true)
    assert.equal(readPending()?.armedAt, first.marker.armedAt)
  } finally { await w.done() }
})

test('attemptPending 真把目录搬走：旧档还在、钥匙抄回来、意向书收成 done', async () => {
  const w = await world()
  try {
    const { armPending, attemptPending, readPending } = await import(MOD)
    await seedRoot(w.root)
    armPending({ root: w.root, retire: { wsId: 'ws_1', sessionId: 's_1' } })
    const r = await attemptPending({ root: w.root, retryDelays: [0] })
    assert.equal(r.ok, true)
    assert.ok(r.movedTo && await exists(r.movedTo), `封存目录：${r.movedTo}`)
    assert.match(await readFile(join(r.movedTo, 'events.jsonl'), 'utf8'), /seed/)
    assert.ok(await exists(join(w.root, 'owner.json')), '钥匙要抄回新状态库')
    assert.ok(await exists(join(w.root, 'config.json')))
    assert.equal(readPending()?.phase, 'done')
  } finally { await w.done() }
})

test('搬不动：意图留在 armed、attempts+1、不抛异常（启动不能被带垮）', async () => {
  const w = await world()
  try {
    const { armPending, attemptPending, readPending } = await import(MOD)
    const calls = []
    const reset = async () => { calls.push(1); return { ok: false, code: 'EPERM', why: '这一刻有文件正被读写' } }
    armPending({ root: w.root })
    const r = await attemptPending({ root: w.root, reset, retryDelays: [0, 0, 0] })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'EPERM')
    assert.equal(calls.length, 3, '默认重试三档（0/150/400），这里用 0 代替')
    const m = readPending()
    assert.equal(m?.phase, 'armed')
    assert.equal(m?.attempts, 1)
    assert.equal(m?.lastRun?.ok, false)
  } finally { await w.done() }
})

test('第一次失败、第二次成功：仍算搬成', async () => {
  const w = await world()
  try {
    const { armPending, attemptPending, readPending } = await import(MOD)
    let n = 0
    const reset = async () => {
      n += 1
      return n < 2 ? { ok: false, code: 'EBUSY', why: '忙' } : { ok: true, movedTo: join(w.tmp, 'backup'), why: '' }
    }
    armPending({ root: w.root })
    const r = await attemptPending({ root: w.root, reset, retryDelays: [0, 0] })
    assert.equal(r.ok, true)
    assert.equal(n, 2)
    assert.equal(readPending()?.phase, 'done')
  } finally { await w.done() }
})

test('上一次停在 running：转 failed，不自动再搬', async () => {
  const w = await world()
  try {
    const { readPending, attemptPending } = await import(MOD)
    await writeFile(w.marker, JSON.stringify({
      version: 1, phase: 'running', root: w.root, armedAt: '2026-11-28T10:00:00Z', attempts: 1,
    }), 'utf8')
    let called = 0
    const r = await attemptPending({ root: w.root, reset: async () => { called += 1; return { ok: true } } })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'dirty')
    assert.equal(called, 0, 'running 残留不能自动重试')
    assert.equal(readPending()?.phase, 'failed')
  } finally { await w.done() }
})

test('意向书是另一个数据目录的：一律不碰', async () => {
  const w = await world()
  try {
    const { readPending, attemptPending } = await import(MOD)
    await writeFile(w.marker, JSON.stringify({
      version: 1, phase: 'armed', root: join(w.tmp, 'other'), armedAt: '2026-11-28T10:00:00Z',
    }), 'utf8')
    const r = await attemptPending({ root: w.root, reset: async () => { throw new Error('不该被调用') } })
    assert.equal(r.skipped, true)
    assert.equal(r.code, 'other_root')
    assert.equal(readPending()?.phase, 'armed')
  } finally { await w.done() }
})

test('坏 JSON / 空文件 / 相对路径：当成没有，且不挡启动', async () => {
  const w = await world()
  try {
    const { readPending, attemptPending } = await import(MOD)
    for (const body of ['{oops', '', JSON.stringify({ version: 1, phase: 'armed', root: 'data' })]) {
      await writeFile(w.marker, body, 'utf8')
      assert.equal(readPending(), null, `内容：${body.slice(0, 20)}`)
      const r = await attemptPending({ root: w.root, reset: async () => { throw new Error('不该被调用') } })
      assert.equal(r.skipped, true)
    }
  } finally { await w.done() }
})

test('cancelPending：删掉意向书；running 时拒绝', async () => {
  const w = await world()
  try {
    const { armPending, cancelPending, readPending } = await import(MOD)
    armPending({ root: w.root })
    assert.equal(cancelPending({ root: w.root }).removed, true)
    assert.equal(readPending(), null)
    assert.equal(await exists(w.marker), false)

    await writeFile(w.marker, JSON.stringify({ version: 1, phase: 'running', root: w.root, armedAt: '' }), 'utf8')
    const r = cancelPending({ root: w.root })
    assert.equal(r.ok, false)
    assert.ok(readPending(), 'running 的意向书不能删')
  } finally { await w.done() }
})

test('归档用意向书里的 home 快照：home.json 已经跟着搬走了也照样归档', async () => {
  const w = await world()
  try {
    const { armPending, attemptPending } = await import(MOD)
    await seedRoot(w.root)
    const archived = []
    const reg = { list: () => [{ id: 'ws_1', sessionIds: ['s_1', 's_2'] }], archiveSession: async (sid) => { archived.push(sid) } }
    const ctx = { get: (name) => (name === 'workspaceRegistry' ? reg : undefined) }
    armPending({ root: w.root, retire: { wsId: 'ws_1', sessionId: 's_1' } })
    const r = await attemptPending({ root: w.root, ctx, retryDelays: [0] })
    assert.equal(r.ok, true)
    assert.ok(r.retired?.ok, r.retired?.why)
    assert.deepEqual(archived.sort(), ['s_1', 's_2'])
  } finally { await w.done() }
})

test('另一个活着的实例正拿着锁：这一回跳过，不搬', async () => {
  const w = await world()
  try {
    const { armPending, attemptPending, readPending } = await import(MOD)
    armPending({ root: w.root })
    await writeFile(`${w.marker}.lock`, JSON.stringify({ pid: process.ppid, at: Date.now() }), 'utf8')
    let called = 0
    const r = await attemptPending({ root: w.root, reset: async () => { called += 1; return { ok: true } } })
    assert.equal(r.skipped, true)
    assert.equal(r.code, 'locked')
    assert.equal(called, 0)
    assert.equal(readPending()?.phase, 'armed')
  } finally { await w.done() }
})

test('runPendingReset 吞掉异常：reset 抛错也只回一句，不往外扔', async () => {
  const w = await world()
  try {
    const { armPending, runPendingReset, readPending } = await import(MOD)
    armPending({ root: w.root })
    const r = await runPendingReset(null, w.root, { reset: async () => { throw new Error('炸了') }, })
    assert.equal(r.ok, false)
    assert.equal(readPending()?.phase, 'armed', '抛错也不能把意向弄丢')
  } finally { await w.done() }
})
