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

test('身份段：who 出现得比第一次说话晚，日期不跳到今天（issue #181）', () => {
  // 2026-11-27 真机：`firstAt` 只认带 `who` 的事件，而 `who` 是 1.0.9 才写的。
  // 于是 11 月 1 日见面、11 月 27 日才有第一条带 who 的记录，身份段就写成
  // 「第一次说话：11 月 27 日，到今天第 31 天」——两行自相矛盾。
  const late = '2026-11-27T02:00:00.000Z'
  const model = {
    day: 31,
    firstMetAt: T1,
    recentHeard: [{ text: '我回来了，感觉怎么样。' }],
    people: peopleOf([
      ev({ id: 'e1', type: 'utterance', ts: late, text: '我回来了，感觉怎么样。', who: OWNER }),
    ]),
  }
  const section = peopleSection(model)
  assert.match(section, /第一次说话：11 月 1 日/)
  assert.doesNotMatch(section, /11 月 27 日/)
  // 反过来：账本里的 who 比 firstMetAt 更早（导进来的旧事件）时，取更早的那个
  const earlier = peopleOf([ev({ id: 'e1', type: 'heard', ts: '2026-10-20T10:00:00.000Z', text: '在，今天有点累。', who: OWNER })])
  const back = peopleSection({ day: 3, firstMetAt: T1, people: earlier })
  assert.match(back, /第一次说话：10 月 20 日/)
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

// ---- 只有名字的人（桥只报了 speaker、没报 id）----
// 跳过等于「接桥的人打开 her_people 一个外人都看不见」，所以按名字建人，但必须标出来。

test('没有 id 的人也要出现，并如实标「同名可能不止一个人」', () => {
  const people = peopleOf([ev({ id: 'e1', type: 'voice', ts: T1, text: '我叫张三。', who: { id: '', name: '张三' } })])
  assert.equal(people.length, 1)
  assert.equal(people[0].id, 'name:张三')
  assert.equal(people[0].name, '张三')
  assert.equal(people[0].nameOnly, true)
  assert.match(renderPerson(people[0]), /这个名字对上的可能不止一个人/)
})

test('有 id 的张三和有名字的张三算两个人，不并', () => {
  const people = peopleOf([
    ev({ id: 'e1', type: 'voice', ts: T1, text: '在。', who: { id: 'bili:9', name: '张三' } }),
    ev({ id: 'e2', type: 'voice', ts: T2, text: '我也在。', who: { id: '', name: '张三' } }),
  ])
  assert.equal(people.length, 2)
  assert.equal(people.filter((p) => p.nameOnly).length, 1)
})

test('refs 指向「只有名字的人」时，判断也挂得上去', () => {
  const people = peopleOf([
    ev({ id: 'e1', type: 'voice', ts: T1, text: '我一般两点才睡。', who: { id: '', name: '张三' } }),
    ev({ id: 'e2', type: 'utterance', ts: T2, text: '他说自己两点才睡。', refs: ['e1'] }),
  ])
  const zhang = people.find((p) => p.nameOnly)
  assert.equal(zhang.judgments.length, 1)
})

// ---- 「只数不写」----
// 只摆材料、不下结论；三个门槛（次数 / 跨度 / 夜里次数）都是为了不让她拿两三次当习惯。
// 时间用本地时刻构造，免得在别的时区跑测试时「夜里」不成立。

const at = (day, hour) => new Date(2026, 10, day, hour, 0).toISOString()

test('次数要够、跨度要够，才摆「记下来过几次」', () => {
  const enough = peopleOf(
    [1, 3, 5, 7, 9].map((d, i) => ev({ id: `e${i}`, type: 'heard', ts: at(d, 12), text: '在。', who: OWNER })),
  )
  assert.equal(enough[0].times, 5)
  assert.match(renderPerson(enough[0]), /你们之间记下来过 5 次，跨了 8 天/)

  const few = peopleOf([1, 3, 5].map((d, i) => ev({ id: `f${i}`, type: 'heard', ts: at(d, 12), text: '在。', who: OWNER })))
  assert.equal(few[0].times, 3)
  assert.doesNotMatch(renderPerson(few[0]), /记下来过/, '三次就写成经常，那是噪声')
})

test('夜里那几次也要够数才摆，且说清是「记下来过」不是「出现过」', () => {
  const night = peopleOf(
    [1, 3, 5, 7, 9].map((d, i) => ev({ id: `n${i}`, type: 'heard', ts: at(d, 23), text: '在。', who: OWNER })),
  )
  assert.equal(night[0].nightTimes, 5)
  const text = renderPerson(night[0])
  assert.match(text, /其中 5 次在夜里/)
  assert.doesNotMatch(text, /出现过/)

  const mixed = peopleOf([
    ev({ id: 'm1', type: 'heard', ts: at(1, 23), text: '在。', who: OWNER }),
    ev({ id: 'm2', type: 'heard', ts: at(3, 12), text: '在。', who: OWNER }),
    ev({ id: 'm3', type: 'heard', ts: at(5, 12), text: '在。', who: OWNER }),
    ev({ id: 'm4', type: 'heard', ts: at(7, 12), text: '在。', who: OWNER }),
    ev({ id: 'm5', type: 'heard', ts: at(9, 12), text: '在。', who: OWNER }),
  ])
  assert.equal(mixed[0].nightTimes, 1)
  assert.doesNotMatch(renderPerson(mixed[0]), /在夜里/, '只有一次在夜里，不能当习惯摆出来')
})

test('主人的称呼进了名字表：topic 写称呼也挂得上，标题跟着称呼走（用户 m05827）', () => {
  const events = [
    ev({ id: 'e1', type: 'heard', ts: T1, text: '以后叫你猫。', who: OWNER }),
    ev({ id: 'e2', type: 'utterance', ts: T2, text: '猫这人嘴硬心软。', topic: '猫' }),
  ]
  // 不给别名时挂不上——主人那一行的 name 永远是空串，名字表里从来没有主人
  assert.equal(peopleOf(events)[0].judgments.length, 0, '这是修之前的坑，别退回')

  const people = peopleOf(events, { ownerNames: ['猫'] })
  assert.equal(people[0].id, 'owner', '主人永远第一行')
  assert.equal(people[0].name, '猫', '称呼成了主人的名字')
  assert.deepEqual(people[0].judgments.map((j) => j.id), ['e2'])

  const section = peopleSection({ name: '猫', people, firstMetAt: T1 }, { others: true })
  assert.match(section, /## 你认识的猫/, '标题用的是她给他的称呼，不是「他」')
  assert.doesNotMatch(section, /\{T\}/)
})

test('改了口，那个人不会从身份段消失：revise 从 refs 继承归属（用户 m05827）', () => {
  const events = [
    ev({ id: 'e1', type: 'voice', ts: T1, text: '我一般两点才睡。', who: WANG }),
    ev({ id: 'e2', type: 'utterance', ts: T2, text: '老王爱在半夜回话。', topic: '老王' }),
    // revise 不带 who、不带 topic，只拿 refs 指着旧那句
    { id: 'e3', type: 'revise', ts: T3, text: '老王其实作息挺规律，是那阵子忙。', refs: ['e2'], verdict: 'refined' },
  ]
  const wang = peopleOf(events).find((p) => p.id === WANG.id)
  assert.ok(wang, '老王还在名单里')
  assert.deepEqual(wang.judgments.map((j) => j.id), ['e3'], '新说法挂到了旧句那个人身上')
  assert.equal(wang.judgments[0].changedFrom, '老王爱在半夜回话。')
  assert.equal(wang.changed.length, 1, '旧句退场但留痕')
  assert.equal(wang.changed[0].text, '老王爱在半夜回话。')

  const section = peopleSection({ people: peopleOf(events) }, { others: true })
  assert.match(section, /老王/, '改了口的人不会被整段抹掉')
})

