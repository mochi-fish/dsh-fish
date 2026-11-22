/**
 * people-others.test.mjs —— 群里别人说的话（认识人 S2-b，2026-11-23，用户 m03903）
 *
 * S2-b 原计划挂起，用户改主意：做成**默认关的开关**，谁想开谁自己测。
 * 这一组守六件事：
 *   ① 默认关，关着时一条都不留（和以前一模一样）；
 *   ② 不知道是谁说的就不记——记下来挂不到人身上，还白占一个位置；
 *      `events.jsonl` 只能追加，写错了删不掉，宁可这一条不记；
 *   ③ 落的是 `voice`（别人的说法），不是 `heard`（他本人说的话）——
 *      后者会进「他说过的话」与冲突检测，前者永远进不了判断；
 *   ④ 太短的不记（「嗯」「好」）；
 *   ⑤ 量闸是硬的：一天 5 条、一条 160 字、同一个人一天 1 条；
 *   ⑥ 落下来的东西不进信念——别人的话不能改她的人格。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, readEvents } from '../lib/store.js'
import { deriveSelf } from '../lib/derive.js'
import { rememberGroupMemberWord } from '../lib/hear.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-pother-'))
}

async function seed(root) {
  await appendEvent({ type: 'seed', text: '你不是助手。' }, { day: 1, stage: 1, source: 'system' }, root)
}

async function config(root, others) {
  await writeFile(join(root, 'config.json'), JSON.stringify({ people: { others } }), 'utf8')
}

const who = (id, name = '') => ({ id, name })

test('默认关：开关没开时一条都不留', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, {})
    const r = await rememberGroupMemberWord(root, {
      text: '今天这天真够闷的，一点风都没有',
      who: who('bili:1', '甲'),
      day: 3,
    })
    assert.equal(r.written, false)
    assert.equal(r.why, 'off')
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'voice').length, 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('开着、也知道是谁：落一条 voice，场次是群聊，来源是宿主', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { rememberOthers: true })
    const text = '今天这天真够闷的，一点风都没有'
    const r = await rememberGroupMemberWord(root, { text, who: who('bili:1', '甲'), day: 3, sessionId: 's-room-1' })
    assert.equal(r.written, true)
    const { events } = await readEvents(root)
    const v = events.find((e) => e.type === 'voice')
    assert.ok(v, '应该落了一条 voice')
    assert.equal(v.text, text)
    assert.equal(v.scene, 'group')
    assert.equal(v.source, 'system', '这类事件只能由宿主写')
    assert.equal(v.who.id, 'bili:1')
    assert.equal(v.who.name, '甲')
    assert.equal(v.sessionId, 's-room-1')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('不知道是谁说的：不记（写进去删不掉，宁可这一条不记）', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { rememberOthers: true })
    const r = await rememberGroupMemberWord(root, { text: '今天这天真够闷的，一点风都没有', who: null, day: 3 })
    assert.equal(r.written, false)
    assert.equal(r.why, 'unknown-speaker')
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'voice').length, 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('太短的不记：「嗯」「好」这种不值得占一个位置', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { rememberOthers: true })
    const r = await rememberGroupMemberWord(root, { text: '嗯', who: who('bili:1', '甲'), day: 3 })
    assert.equal(r.written, false)
    assert.equal(r.why, 'too-short')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('一天 5 条封顶：第 6 个人说的就丢', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { rememberOthers: true })
    for (let i = 1; i <= 5; i += 1) {
      const r = await rememberGroupMemberWord(root, {
        text: `第 ${i} 个人说的一句话，长度够了吧`,
        who: who(`bili:${i}`, `甲${i}`),
        day: 3,
      })
      assert.equal(r.written, true, `第 ${i} 条应该记下`)
    }
    const sixth = await rememberGroupMemberWord(root, {
      text: '第 6 个人说的一句话，长度也够了吧',
      who: who('bili:6', '甲6'),
      day: 3,
    })
    assert.equal(sixth.written, false)
    assert.equal(sixth.why, 'per-day')
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'voice').length, 5)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('同一个人一天一条：他再说就丢，换个人还能记', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { rememberOthers: true })
    const first = await rememberGroupMemberWord(root, { text: '甲说的第一句话，长度够了', who: who('bili:1', '甲'), day: 3 })
    assert.equal(first.written, true)
    const again = await rememberGroupMemberWord(root, { text: '甲说的第二句话，长度也够了', who: who('bili:1', '甲'), day: 3 })
    assert.equal(again.written, false)
    assert.equal(again.why, 'per-person')
    const other = await rememberGroupMemberWord(root, { text: '乙说的一句话，长度也够了', who: who('bili:2', '乙'), day: 3 })
    assert.equal(other.written, true, '换个人不该被上一个人的额度挡住')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('超过 160 字截断，末尾留一个省略号', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { rememberOthers: true })
    const long = '这'.repeat(200)
    const r = await rememberGroupMemberWord(root, { text: long, who: who('bili:1', '甲'), day: 3 })
    assert.equal(r.written, true)
    assert.ok(r.text.length <= 160, `截断后应该不超过 160 字，实际 ${r.text.length}`)
    assert.ok(r.text.endsWith('…'), '截断了就该看得出截断了')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('落下来的别人的话不进信念：它只能被翻到，不能改她的人格', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    await config(root, { rememberOthers: true })
    const text = '我觉得你这条鱼写的东西根本不像人写的'
    await rememberGroupMemberWord(root, { text, who: who('bili:1', '甲'), day: 3 })
    const { events } = await readEvents(root)
    const model = deriveSelf(events, {})
    assert.equal(model.beliefs.some((b) => String(b.text).includes('不像人写的')), false, '别人的话不能变成她的判断')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})
