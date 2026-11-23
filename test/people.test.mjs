/**
 * people.test.mjs —— 「她认识哪些人」怎么从事件流算出来（1.1.0 S3-a）
 *
 * 这一组守六件事：
 *   ① 判断挂到人身上只有三条路：`who.id`、`topic` 命中一个**已知的人名**、`refs` 指到那个人的事件；
 *   ② 三样都没写就**不挂人**——她自己没说是关于谁的，宿主不能替她认；
 *   ③ `uncommitted`（群里说过的话）只是凭据，不是她认领的判断，不进这一层；
 *   ④ 没有判断的人不进身份段（空条目不摆）；
 *   ⑤ 开关关着时只有主人一个；
 *   ⑥ 预算超了就停，不硬塞。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { peopleOf, peopleSection, renderPerson, findPerson, PEOPLE_SECTION_MAX } from '../lib/people.js'

const OWNER = { id: 'owner', name: '' }
const WANG = { id: 'bili:1001', name: '老王' }
const LI = { id: 'bili:1002', name: '小李' }

function ev(o) {
  return { id: o.id, type: o.type, ts: o.ts, text: o.text, who: o.who, topic: o.topic, refs: o.refs, flags: o.flags }
}

const T1 = '2026-11-01T10:00:00.000Z'
const T2 = '2026-11-02T10:00:00.000Z'
const T3 = '2026-11-03T10:00:00.000Z'
const T4 = '2026-11-04T10:00:00.000Z'

test('三条判据各能挂一条判断：who.id / topic 命中人名 / refs 指过去', () => {
  const events = [
    ev({ id: 'e1', type: 'heard', ts: T1, text: '今天有点累。', who: OWNER }),
    ev({ id: 'e2', type: 'voice', ts: T2, text: '我一般两点才睡。', who: WANG }),
    // ① who.id 直接写
    ev({ id: 'e3', type: 'utterance', ts: T2, text: '老王是个能熬夜的人。', who: WANG }),
    // ② topic 命中已知人名
    ev({ id: 'e4', type: 'utterance', ts: T3, text: '老王说话直。', topic: '老王' }),
    // ③ refs 指到那个人的事件
    ev({ id: 'e5', type: 'utterance', ts: T4, text: '他说自己两点才睡。', refs: ['e2'] }),
  ]
  const people = peopleOf(events)
  assert.equal(people.length, 2, '主人 + 老王')
  assert.equal(people[0].id, 'owner', '主人永远第一行')
  const wang = people.find((p) => p.id === WANG.id)
  assert.equal(wang.judgments.length, 3, '三条判据各挂上一条')
  assert.deepEqual(
    wang.judgments.map((j) => j.id),
    ['e5', 'e4', 'e3'],
    '按时间倒序',
  )
  assert.equal(wang.name, '老王')
})

test('三样都没写就不挂人——宿主不替她认', () => {
  const events = [
    ev({ id: 'e1', type: 'voice', ts: T1, text: '我一般两点才睡。', who: WANG }),
    // topic 是个「事」，不是任何一个已知的人名
    ev({ id: 'e2', type: 'utterance', ts: T2, text: '熬夜不好。', topic: '熬夜' }),
    // 什么也没有
    ev({ id: 'e3', type: 'utterance', ts: T3, text: '人还是得睡够。' }),
  ]
  const wang = peopleOf(events).find((p) => p.id === WANG.id)
  assert.equal(wang.judgments.length, 0, 'topic 不命中人名、refs 为空，就不挂')
})

test('uncommitted 只是凭据，不是她认领的判断', () => {
  const events = [
    ev({ id: 'e1', type: 'voice', ts: T1, text: '哈哈哈', who: WANG }),
    ev({ id: 'e2', type: 'utterance', ts: T2, text: '我回了老王一句。', who: WANG, flags: ['uncommitted'] }),
  ]
  const wang = peopleOf(events).find((p) => p.id === WANG.id)
  assert.equal(wang.judgments.length, 0, '群里说过的话不变成对人的判断')
})

test('猜的会被标出来，不跟准话混在一起', () => {
  const events = [
    ev({ id: 'e1', type: 'voice', ts: T1, text: '随便吧。', who: WANG }),
    ev({ id: 'e2', type: 'utterance', ts: T2, text: '我猜老王其实不太在意。', who: WANG }),
  ]
  const wang = peopleOf(events).find((p) => p.id === WANG.id)
  assert.equal(wang.judgments[0].guess, true)
  assert.match(renderPerson(wang), /（猜的）/)
})

test('身份段：没有判断的人不摆；开关关着只有主人', () => {
  const model = {
    day: 10,
    firstMetAt: T1,
    recentHeard: [{ text: '今天有点累。' }],
    people: peopleOf([
      ev({ id: 'e1', type: 'heard', ts: T1, text: '今天有点累。', who: OWNER }),
      ev({ id: 'e2', type: 'voice', ts: T2, text: '在吗', who: LI }),
      ev({ id: 'e3', type: 'voice', ts: T3, text: '我一般两点才睡。', who: WANG }),
      ev({ id: 'e4', type: 'utterance', ts: T4, text: '老王是个能熬夜的人。', who: WANG }),
    ]),
  }
  const closed = peopleSection(model, { others: false })
  assert.match(closed, /## 你认识的\{T\}/)
  assert.match(closed, /第一次说话/)
  assert.doesNotMatch(closed, /老王/, '开关关着时只有主人一个')
  assert.doesNotMatch(closed, /想细看谁/)

  const open = peopleSection(model, { others: true })
  assert.match(open, /老王/, '有判断的人要摆出来')
  assert.doesNotMatch(open, /小李/, '一条判断都没有的人不摆')
  assert.match(open, /想细看谁，可以自己翻。/, '有这个工具就得让她知道自己有')
})

test('老账本兜底：一条 who 都没有时，S0 那几行照旧出现', () => {
  const model = { day: 7, firstMetAt: T1, recentHeard: [{ text: '今天有点累。' }], people: [] }
  const section = peopleSection(model, { others: true })
  assert.match(section, /第一次说话/)
  assert.match(section, /你记着\{T\}说过的一句/)
  assert.deepEqual(peopleSection({ day: 7, people: [] }), '', '什么都没有就整段不出现')
})

test('预算：超了就停，不硬塞', () => {
  const people = peopleOf([
    ev({ id: 'e1', type: 'heard', ts: T1, text: '在。', who: OWNER }),
    ev({ id: 'e2', type: 'voice', ts: T2, text: '在吗', who: WANG }),
    ev({ id: 'e3', type: 'utterance', ts: T3, text: '老王这个人挺直的。', who: WANG }),
    ev({ id: 'e4', type: 'voice', ts: T4, text: '在吗', who: LI }),
    ev({ id: 'e5', type: 'utterance', ts: T4, text: '小李比老王细心。', who: LI }),
  ])
  const wide = peopleSection({ day: 3, firstMetAt: T1, people }, { others: true })
  assert.ok(wide.length <= PEOPLE_SECTION_MAX, `宽度超了：${wide.length}`)
  const narrow = peopleSection({ day: 3, firstMetAt: T1, people }, { others: true, maxChars: 40 })
  assert.ok(narrow.length <= 40, `窄预算超了：${narrow.length}`)
  assert.doesNotMatch(narrow, /小李/, '预算不够时后面的人不摆')
})

test('找人：全名优先，也认名字里的几个字；不认路径', () => {
  const people = peopleOf([
    ev({ id: 'e1', type: 'voice', ts: T1, text: '在吗', who: WANG }),
    ev({ id: 'e2', type: 'voice', ts: T2, text: '在吗', who: LI }),
  ])
  assert.equal(findPerson(people, '老王').length, 1)
  assert.equal(findPerson(people, '王').length, 1)
  assert.deepEqual(findPerson(people, '../etc/passwd'), [])
  assert.deepEqual(findPerson(people, ''), [])
})
