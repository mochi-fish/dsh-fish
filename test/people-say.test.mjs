/**
 * people-say.test.mjs —— 她在这间房说的话也落一笔（认识人 S2-a，2026-11-23）
 *
 * 要守住的是五件事，缺一条这个功能就不该开：
 *   1. **关着的时候一条都不留。** 开关管的是落盘，不只是展示——
 *      默认关，那么多人只有书房，开着也是空的。
 *   2. **落的是她自己的话**，不是别人的。群友说的话一条都不进（那是 S2-b，没做）。
 *   3. **同一个 people 当天最多一条。** 她要的是「今天和这人说过话」，不是十句流水账。
 *   4. **`uncommitted` 语义一个字不改**：只留证，不进信念、不算成长。
 *      这条最容易被后来的改动弄丢——一旦进了 beliefs，群聊噪音就开始改她的人格。
 *   5. **出口脱敏之后才落盘**：她叫主人的名字不能进群聊记忆。
 *
 * 另外守一条老行为：书房（desk）里说话，即使开关开着，也不走这条路——
 * 书房那条路是 `lib/turns.js` 的补写，两者不能重复记同一条。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, readEvents } from '../lib/store.js'
import { deriveSelf } from '../lib/derive.js'
import { sayToHer } from '../lib/say.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-psay-'))
}

async function seed(root) {
  await appendEvent({ type: 'seed', text: '你不是助手。' }, { day: 1, stage: 1, source: 'system' }, root)
}

async function config(root, others) {
  await writeFile(join(root, 'config.json'), JSON.stringify({ people: { others } }), 'utf8')
}

/**
 * 假宿主：能建会话、能改名、能投递，并且有一条 `session/event` 总线。
 * `prompt` 里自己 emit `assistant/message` 再 emit `turn/end`——
 * say.js 是先投递再等 turn/end，同步 emit 会被漏掉。
 */
function fakeCtx() {
  const calls = []
  const handlers = new Map()
  const ws = { id: 'ws-house', path: 'X:\\fake\\home', title: '大肥鱼的家', sessionIds: ['s-house'], archivedSessionIds: [] }
  const sc = {
    async create(o = {}) {
      calls.push({ op: 'create', ...o })
      if (!o.workspaceId) return {}
      const n = calls.filter((c) => c.op === 'create' && c.workspaceId).length
      return { sessionId: n === 1 ? 's-house' : `s-room-${n - 1}` }
    },
    async rename(p) { calls.push({ op: 'rename', ...p }) },
    async prompt(req, signal) { calls.push({ op: 'prompt', req, signal }) },
  }
  const workspaceRegistry = {
    list: () => [ws],
    get: (id) => (id === ws.id ? ws : null),
    create: async () => ws,
    update: async () => {},
  }
  const ctx = {
    sessionController: sc,
    calls,
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, new Set())
      handlers.get(ev).add(fn)
      return () => handlers.get(ev)?.delete(fn)
    },
    get: (k) => (k === 'workspaceRegistry' ? workspaceRegistry : undefined),
  }
  const emit = (sessionId, event) => {
    for (const fn of handlers.get('session/event') ?? []) fn({ header: { id: sessionId } }, event)
  }
  return { ctx, calls, emit }
}

/** 让她「真的说出几句」：assistant/message 才是正文，工具参数不算。 */
function speak(ctx, emit, ...texts) {
  ctx.sessionController.prompt = async (req) => {
    for (const text of texts) {
      emit(req?.sessionId, { type: 'assistant/message', data: { message: { id: 'm-1', content: [{ type: 'text', text }] } } })
    }
    emit(req?.sessionId, { type: 'turn/end' })
  }
}

async function groupLines(root) {
  const { events } = await readEvents(root)
  return events.filter((e) => e.type === 'utterance' && e.scene === 'group')
}

test('开关关着：群里说的话一条都不留', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { enabled: false })
    const { ctx, emit } = fakeCtx()
    speak(ctx, emit, '听得见。')
    const r = await sayToHer(ctx, '在吗', { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '张三' })
    assert.equal(r.ok, true)
    assert.equal(r.said.length, 1, '返回值照旧要带回来')
    assert.deepEqual(await groupLines(root), [], '关着就不许往硬盘写')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('打开后：落一条她的话，带 who、带 scene、标 uncommitted', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { enabled: true })
    const { ctx, emit } = fakeCtx()
    speak(ctx, emit, '听得见，你说。')
    const r = await sayToHer(ctx, '在吗', { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '张三' })
    assert.equal(r.ok, true)

    const lines = await groupLines(root)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].text, '听得见，你说。')
    assert.equal(lines[0].scene, 'group')
    assert.equal(lines[0].who.name, '张三')
    assert.equal(lines[0].who.id, '', '桥只给名字，不给 id，按名字归并')
    assert.deepEqual(lines[0].flags, ['uncommitted'], '只留证：不进信念、不算成长')
    assert.equal(lines[0].source, 'system', '宿主写的，不是她写的——换成 tool 会被 schema 拒掉')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// 桥给了 id 就按 id 记：群里有两个人同名时，没有 id 会并成一个人。
test('给了 speakerId：落的是 id，同名的两个人各记一条', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { enabled: true })
    const { ctx, emit } = fakeCtx()
    speak(ctx, emit, '对第一个张三说的。')
    await sayToHer(ctx, '在吗', { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '张三', speakerId: 'qq:10001' })

    speak(ctx, emit, '对第二个张三说的。')
    await sayToHer(ctx, '我也在', { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '张三', speakerId: 'qq:10002' })

    const lines = await groupLines(root)
    assert.equal(lines.length, 2, '同名不同 id 是两个人，不该并成一条')
    assert.deepEqual(lines.map((l) => l.who.id), ['qq:10001', 'qq:10002'])
    assert.deepEqual(lines.map((l) => l.who.name), ['张三', '张三'])
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('同一个人当天只记一条；换了人各记一条', async () => {  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { enabled: true })
    const { ctx, emit } = fakeCtx()
    speak(ctx, emit, '第一句。')
    await sayToHer(ctx, '在吗', { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '张三' })

    speak(ctx, emit, '第二句。')
    await sayToHer(ctx, '又问一句', { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '张三' })
    assert.equal((await groupLines(root)).length, 1, '同一个人今天已经记过，就不再写')

    speak(ctx, emit, '对李四说的。')
    await sayToHer(ctx, '换人说话', { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '李四' })
    const lines = await groupLines(root)
    assert.equal(lines.length, 2, '另一个人有自己的一条')
    assert.deepEqual(lines.map((l) => l.who.name), ['张三', '李四'])
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('一天八条封顶：第九个人不再落', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { enabled: true, perDayMax: 8 })
    const { ctx, emit } = fakeCtx()
    for (let i = 1; i <= 9; i++) {
      speak(ctx, emit, `第 ${i} 个人。`)
      await sayToHer(ctx, '在吗', { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: `路人${i}` })
    }
    assert.equal((await groupLines(root)).length, 8, '8 × 300 字是这一档的上限，不是无底洞')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('一条超字数就截断，不整条丢', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { enabled: true, charMax: 50 })
    const { ctx, emit } = fakeCtx()
    speak(ctx, emit, '这句话一共有好多字。'.repeat(10))
    await sayToHer(ctx, '在吗', { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '张三' })
    const lines = await groupLines(root)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].text.length, 50)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('书房不落这条：开关开着也不重复记（书房走 turns.js 那条路）', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { enabled: true })
    const { ctx, emit } = fakeCtx()
    speak(ctx, emit, '书房里说的话。')
    await sayToHer(ctx, '在吗', { root, waitMs: 5_000 })
    assert.deepEqual(await groupLines(root), [])
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('落下的那条不进信念：uncommitted 只留证', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { enabled: true })
    const { ctx, emit } = fakeCtx()
    speak(ctx, emit, '张三这人挺有意思的。')
    await sayToHer(ctx, '在吗', { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '张三' })
    const lines = await groupLines(root)
    assert.equal(lines.length, 1)
    const { events } = await readEvents(root)
    const model = deriveSelf(events, {})
    assert.ok(model.beliefs.every((b) => b.text !== '张三这人挺有意思的。'), '群聊里的寒暄不许变成她的判断')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('出口脱敏在前：她叫主人的名字不进群聊记忆', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await appendEvent(
      { type: 'utterance', text: '以后叫他时梦尘。' },
      { day: 1, stage: 1, source: 'tool' },
      root,
    )
    await config(root, { enabled: true })
    const { ctx, emit } = fakeCtx()
    speak(ctx, emit, '时梦尘跟我说过这句话。')
    await sayToHer(ctx, '在吗', { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '张三' })
    const lines = await groupLines(root)
    assert.equal(lines.length, 1)
    assert.doesNotMatch(lines[0].text, /时梦尘/, '名字只留在私下')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
