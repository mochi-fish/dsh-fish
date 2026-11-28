/**
 * person-registry.test.mjs —— 「人」这个实体（1.1.4，issue #183）
 *
 * 这一组守五件事：
 *   ① 人可以由她自己显式记下来（`person_add`），名字、是哪一种人、一句这是谁；
 *   ② 判断按 `about` 挂到那个人身上，`topic` 写名字也能挂，别名绑在具体 id 上；
 *   ③ 同名命中多个时**不猜**——宁可不挂，也不把她的话安到错的人头上；
 *   ④ 身份段分三栏：在场的人 / 听{T}提起过的人 / 你读过的作品里的人；
 *      她自己（self）和没有名字的人（anonymous）不进这一节；
 *   ⑤ 记重了能并掉（`person_merge`），并完以后判断都算到一个 id 上。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateEvent } from '../lib/schema.js'
import { peopleOf, peopleSection } from '../lib/people.js'
import { registerHerPerson } from '../lib/herperson.js'
import { normalizePid, newPersonId } from '../lib/person.js'

const T1 = '2026-11-01T10:00:00.000Z'
const T2 = '2026-11-02T10:00:00.000Z'

function ev(o) {
  return {
    id: o.id,
    type: o.type,
    ts: o.ts,
    text: o.text,
    who: o.who,
    pid: o.pid,
    name: o.name,
    nature: o.nature,
    about: o.about,
    topic: o.topic,
    // 记重了能并掉：`into` 不能丢，不然合并事件看起来像「并到自己身上」。
    into: o.into,
    alias: o.alias,
    refs: o.refs,
  }
}

const ZHOU = 'p_zhou001'
const ZHOU2 = 'p_zhou002'

async function tmpRoot(events = [], config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fish-person-'))
  const lines = events.map((e) => JSON.stringify(e)).join('\n')
  await writeFile(join(dir, 'events.jsonl'), lines ? `${lines}\n` : '', 'utf8')
  await writeFile(join(dir, 'config.json'), JSON.stringify(config), 'utf8')
  return dir
}

function toolFor(root) {
  let def = null
  const ctx = { tools: { register: (d) => ((def = d), d) } }
  registerHerPerson(ctx, { root })
  return def
}

// ------------------------------------------------------------------ 事件口径

test('人事件的 id 是 p_ 开头；三种人事件缺字段都拒', () => {
  assert.match(newPersonId(1700000000000, () => 0.5), /^p_[0-9a-z]{4,20}$/)
  assert.equal(normalizePid(' p_zhou001 '), ZHOU)
  assert.equal(normalizePid('name:老王'), '')

  const add = (o) => () => validateEvent({ type: 'person_add', ts: T1, source: 'tool', ...o })
  assert.throws(add({ text: '他朋友，嘴硬', name: '小周', nature: 'real' }), (e) => e.code === 'PERSON_NO_ID')
  assert.throws(add({ text: '他朋友，嘴硬', pid: ZHOU, nature: 'real' }), (e) => e.code === 'PERSON_NO_NAME')
  assert.throws(add({ text: '嗯', pid: ZHOU, name: '小周', nature: 'real' }), (e) => e.code === 'PERSON_NO_NOTE')

  const ok = validateEvent({
    type: 'person_add',
    ts: T1,
    source: 'tool',
    pid: ZHOU,
    name: '小周',
    nature: 'real',
    text: '他朋友，嘴硬',
  })
  assert.equal(ok.pid, ZHOU)
  assert.equal(ok.name, '小周')
  assert.equal(ok.nature, 'real')

  // 别名就是正文；空的先撞上「text 不能为空」，两条都算回绝。
  assert.throws(() => validateEvent({ type: 'person_alias', ts: T1, source: 'tool', pid: ZHOU, text: '' }), (e) => e.code === 'PERSON_NO_ALIAS' || e.code === 'EMPTY_TEXT')
  assert.throws(() => validateEvent({ type: 'person_merge', ts: T1, source: 'tool', pid: ZHOU, text: '并' }), (e) => e.code === 'PERSON_NO_INTO')
  assert.throws(() => validateEvent({ type: 'person_merge', ts: T1, source: 'tool', pid: ZHOU, into: ZHOU, text: '并' }), (e) => e.code === 'PERSON_MERGE_SELF')
  assert.throws(() => validateEvent({ type: 'utterance', ts: T1, source: 'tool', text: '小周嘴硬', about: '小周' }), (e) => e.code === 'BAD_ABOUT')
})

// ------------------------------------------------------------------ 派生

const EVENTS = [
  ev({ id: 'ev_01PERSON000000000000000A', type: 'person_add', ts: T1, text: '他朋友，嘴硬', pid: ZHOU, name: '小周', nature: 'real' }),
  ev({ id: 'ev_01SAY00000000000000000001', type: 'utterance', ts: T2, text: '小周这人嘴硬。', about: ZHOU }),
  ev({ id: 'ev_01SAY00000000000000000002', type: 'utterance', ts: T2, text: '小周好像不太爱说话。', topic: '小周' }),
]

test('登记的人出现在名单里，判断按 about / topic 都挂得到', () => {
  const people = peopleOf(EVENTS)
  const zhou = people.find((p) => p.id === ZHOU)
  assert.ok(zhou, '登记过的人要出现')
  assert.equal(zhou.nature, 'real')
  assert.equal(zhou.registered, true)
  assert.equal(zhou.note, '他朋友，嘴硬')
  assert.equal(zhou.judgments.length, 2, 'about 一条、topic 一条')
  assert.equal(zhou.ambiguous, false)
})

test('别名绑在具体 id 上：写「周哥」也挂到小周', () => {
  const events = [
    ...EVENTS,
    ev({ id: 'ev_01ALIAS00000000000000000A', type: 'person_alias', ts: T2, text: '周哥', pid: ZHOU }),
    ev({ id: 'ev_01SAY00000000000000000003', type: 'utterance', ts: T2, text: '周哥其实挺软的。', topic: '周哥' }),
  ]
  const zhou = peopleOf(events).find((p) => p.id === ZHOU)
  assert.equal(zhou.judgments.length, 3)
})

test('同名两个不猜：名字对不上具体的人时，两条判断都不挂', () => {
  const events = [
    ev({ id: 'ev_01PERSON000000000000000B', type: 'person_add', ts: T1, text: '楼下那位老王', pid: 'p_wang01', name: '老王', nature: 'real' }),
    ev({ id: 'ev_01PERSON000000000000000C', type: 'person_add', ts: T1, text: '网上那个老王', pid: 'p_wang02', name: '老王', nature: 'author' }),
    ev({ id: 'ev_01SAY00000000000000000004', type: 'utterance', ts: T2, text: '老王说话直。', topic: '老王' }),
  ]
  const people = peopleOf(events)
  const w1 = people.find((p) => p.id === 'p_wang01')
  const w2 = people.find((p) => p.id === 'p_wang02')
  assert.equal(w1.ambiguous, true)
  assert.equal(w2.ambiguous, true)
  assert.equal(w1.judgments.length + w2.judgments.length, 0, '宁可不挂，也不安到错的人头上')
})

test('并人：from 的判断并进 into，from 不再出现', () => {
  const events = [
    ...EVENTS,
    ev({ id: 'ev_01PERSON000000000000000D', type: 'person_add', ts: T1, text: '记重的那一条', pid: ZHOU2, name: '周兄弟', nature: 'real' }),
    ev({ id: 'ev_01SAY00000000000000000005', type: 'utterance', ts: T2, text: '周兄弟最近很忙。', about: ZHOU2 }),
    ev({ id: 'ev_01MERGE0000000000000000001', type: 'person_merge', ts: T2, text: '并到 p_zhou001', pid: ZHOU2, into: ZHOU }),
  ]
  const people = peopleOf(events)
  assert.equal(people.some((p) => p.id === ZHOU2), false, '被并掉的 id 不再出现')
  const zhou = people.find((p) => p.id === ZHOU)
  assert.equal(zhou.judgments.length, 3, '两个人的判断都算到这一个 id 上')
})

// ------------------------------------------------------------------ 身份段

test('身份段分三栏：在场的人 / 听{T}提起过的人 / 作品里的人', () => {
  const events = [
    ...EVENTS,
    ev({ id: 'ev_01PERSON000000000000000E', type: 'person_add', ts: T1, text: '她读到的作者', pid: 'p_auth01', name: '写鱼的人', nature: 'author' }),
    ev({ id: 'ev_01PERSON000000000000000F', type: 'person_add', ts: T1, text: '电影里的角色', pid: 'p_fict01', name: '阿甘', nature: 'fictional' }),
    ev({ id: 'ev_01PERSON000000000000000G', type: 'person_add', ts: T1, text: '我自己', pid: 'p_self01', name: '大肥鱼', nature: 'self' }),
  ]
  const model = { day: 10, firstMetAt: T1, name: '猫', people: peopleOf(events) }
  const section = peopleSection(model, { others: true })
  assert.match(section, /## 你认识的猫/)
  assert.match(section, /## 听猫提起过的人/)
  assert.match(section, /## 你读过的作品里的人/)
  assert.match(section, /阿甘/)
  assert.doesNotMatch(section, /大肥鱼/, '她自己不进「你认识的人」')
})

// ------------------------------------------------------------------ 工具

test('her_person：记一个人、看名单、加叫法、并掉记重的', async () => {
  const root = await tmpRoot()
  try {
    const t = toolFor(root)

    const add = await t.execute({ action: 'add', name: '小周', nature: 'real', note: '他朋友，嘴硬' })
    assert.equal(add.ok, true)
    assert.match(add.id, /^p_/)

    const list = await t.execute({ action: 'list' })
    assert.equal(list.ok, true)
    assert.match(list.note, /小周/)
    assert.match(list.note, /现实里的人/)

    const dup = await t.execute({ action: 'add', name: '小周', nature: 'real', note: '又记一次同一个人' })
    assert.equal(dup.ok, false, '同名不重复建')
    assert.match(dup.note, /已经记过/)

    const short = await t.execute({ action: 'add', name: '老王', nature: 'real', note: '嗯' })
    assert.equal(short.ok, false, '只说名字不够，得说清这是谁')

    const alias = await t.execute({ action: 'alias', id: add.id, alias: '周哥' })
    assert.equal(alias.ok, true)

    const again = await t.execute({ action: 'add', name: '周兄弟', nature: 'real', note: '记重的那一条' })
    assert.equal(again.ok, true)
    const merge = await t.execute({ action: 'merge', id: again.id, into: add.id })
    assert.equal(merge.ok, true)

    const tail = await t.execute({ action: 'list' })
    assert.equal((tail.note.match(/小周/g) || []).length >= 1, true)
    assert.doesNotMatch(tail.note, /周兄弟/, '并掉的那条不再列出来')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('her_person：名单为空时说人话，不返回空字符串', async () => {
  const root = await tmpRoot()
  try {
    const out = await toolFor(root).execute({ action: 'list' })
    assert.equal(out.ok, true)
    assert.ok(out.note.length > 0)
    assert.match(out.note, /还没单独记过谁/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
