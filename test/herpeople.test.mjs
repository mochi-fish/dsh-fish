/**
 * herpeople.test.mjs —— `her_people` 这一扇窄窗（1.1.0 S3-c）
 *
 * 这一组守五件事：
 *   ① 不给名字就回一份名单；给名字就回那一个人（也能用名字里的几个字）；
 *   ② **不收路径**：`../`、绝对路径都没有入口（参数只有名字）；
 *   ③ 名单为空时说人话，**不返回空字符串**——空串她会以为「翻成功了，但是空的」；
 *   ④ 找不到那个人时，把认识的人列出来给她看；
 *   ⑤ 开关关着时，别人一个都翻不出来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerHerPeople } from '../lib/herpeople.js'

const OWNER = { id: 'owner', name: '' }
const WANG = { id: 'bili:1001', name: '老王' }

const T1 = '2026-11-01T10:00:00.000Z'
const T2 = '2026-11-02T10:00:00.000Z'

async function tmpRoot(events = [], config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fish-herpeople-'))
  const lines = events.map((e) => JSON.stringify(e)).join('\n')
  await writeFile(join(dir, 'events.jsonl'), lines ? `${lines}\n` : '', 'utf8')
  await writeFile(join(dir, 'config.json'), JSON.stringify(config), 'utf8')
  return dir
}

function toolFor(root) {
  let def = null
  const ctx = { tools: { register: (d) => ((def = d), d) } }
  registerHerPeople(ctx, { root })
  return def
}

const EVENTS = [
  { id: 'ev_01AAAAAAAAAAAAAAAAAAAAAAAA', type: 'heard', ts: T1, text: '今天有点累。', who: OWNER },
  { id: 'ev_01BBBBBBBBBBBBBBBBBBBBBBBB', type: 'voice', ts: T2, text: '我一般两点才睡。', who: WANG },
  { id: 'ev_01CCCCCCCCCCCCCCCCCCCCCCCC', type: 'utterance', ts: T2, text: '老王是个能熬夜的人。', who: WANG },
]

test('给名字就回那一个人；不给名字就回一份名单', async () => {
  const root = await tmpRoot(EVENTS, { people: { others: { enabled: true } } })
  try {
    const t = toolFor(root)

    const one = await t.execute({ name: '老王' })
    assert.equal(one.found, true)
    assert.match(one.text, /老王/)
    assert.match(one.text, /能熬夜/)

    const like = await t.execute({ name: '王' })
    assert.equal(like.found, true, '名字里的几个字也要认')

    const list = await t.execute({ list: true })
    assert.equal(list.found, true)
    assert.match(list.text, /你现在认识 2 个人/)
    assert.match(list.text, /老王/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('只收名字，不收路径——../ 传进来也只会被当成「找不到这个人」', async () => {
  const root = await tmpRoot(EVENTS, { people: { others: { enabled: true } } })
  try {
    const t = toolFor(root)
    const out = await t.execute({ name: '../../etc/passwd' })
    assert.equal(out.found, false)
    assert.match(out.text, /没找到/)
    // 没有 path 这个参数：传了也不认
    const out2 = await t.execute({ path: 'C:\\Windows\\win.ini' })
    assert.equal(out2.found, true, 'path 不是参数，等于没给名字 → 回名单')
    assert.match(out2.text, /你现在认识/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('名单为空时说人话，不返回空字符串', async () => {
  const root = await tmpRoot([], { people: { others: { enabled: true } } })
  try {
    const t = toolFor(root)
    const out = await t.execute({})
    assert.equal(out.found, false)
    assert.ok(out.text.length > 0, '绝不能返回空串')
    assert.match(out.text, /还没往谁名下写过什么/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('找不到那个人时，把认识的人列出来', async () => {
  const root = await tmpRoot(EVENTS, { people: { others: { enabled: true } } })
  try {
    const t = toolFor(root)
    const out = await t.execute({ name: '张阿姨' })
    assert.equal(out.found, false)
    assert.match(out.text, /没找到「张阿姨」/)
    assert.match(out.text, /老王/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('开关关着：别人一个都翻不出来', async () => {
  const root = await tmpRoot(EVENTS, { people: { others: { enabled: false } } })
  try {
    const t = toolFor(root)
    const out = await t.execute({ list: true })
    assert.equal(out.found, true)
    assert.doesNotMatch(out.text, /老王/, '开关关着时她的世界里只有一个人')
    assert.match(out.text, /你现在认识 1 个人/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

/**
 * 2026-11-24 审计：从前这里自己调 `peopleOf(events)`，不传她给{T}起的称呼，
 * 于是三件事同时错——主人那一行没名字、靠 `topic` 写称呼的判断挂不上、
 * 她按名单里写的字去查还查不到。身份段里摆着「你对猫有过一句准话」，
 * 翻出来却是空的；名单写着「主人」，查「主人」却「没找到」。
 */
test('她怎么称呼{T}，这一页就怎么写：判断挂得上、名单里是那个称呼、能查得到', async () => {
  const named = [
    { id: 'ev_01DDDDDDDDDDDDDDDDDDDDDDDD', type: 'heard', ts: T1, text: '我叫阿明。', who: OWNER },
    { id: 'ev_01EEEEEEEEEEEEEEEEEEEEEEEE', type: 'utterance', ts: T1, text: '以后叫你猫。' },
    { id: 'ev_01FFFFFFFFFFFFFFFFFFFFFFFF', type: 'utterance', ts: T2, text: '猫这人嘴硬心软。', topic: '猫' },
  ]
  const root = await tmpRoot(named, { people: { others: { enabled: false } } })
  try {
    const t = toolFor(root)

    const one = await t.execute({ name: '猫' })
    assert.equal(one.found, true, '名单里写的是哪个字，就得能用那个字查到')
    assert.match(one.text, /^## 猫/m, '标题跟着称呼走，不再退回代词')
    assert.match(one.text, /嘴硬心软/, '身份段里摆着的那条判断，翻出来也要在')

    const list = await t.execute({ list: true })
    assert.match(list.text, /猫/)
    assert.doesNotMatch(list.text, /主人/, '不写死「主人」——他和大肥鱼是什么关系是他们自己定的')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})
