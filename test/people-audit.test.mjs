/**
 * 1.1.0 审计（2026-11-24，用户 m05065「再检查一下这个关系和认识人的功能」）。
 *
 * 这三条都是实测里真跑出来的偏差，不是假想：
 *  ① 两个不同的人各说一句、都带否定词、句子又短，全句相似度轻松过线，
 *     于是被当成「她对同一件事前后矛盾」断言出来——而那其实是两个人。
 *  ② 身份段里「最近见过的那个陌生人」把后面真写过判断的人挡掉了。
 *  ③ 桥只给名字时 her_people 认得这个人，体检却一个都不算。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectTensions } from '../lib/derive.js'
import { peopleOf, peopleSection, renderPerson } from '../lib/people.js'
import { examine } from '../lib/health.js'

const DAY = 86_400_000
const T0 = Date.parse('2026-11-01T12:00:00+08:00')
const at = (d) => new Date(T0 + d * DAY).toISOString()

const belief = (id, text, d, who) => ({
  id,
  text,
  since: at(d),
  confidence: 0.5,
  status: 'active',
  verdict: null,
  topic: '',
  who,
})

const ev = (o) => ({
  id: o.id,
  v: 1,
  ts: o.ts,
  day: o.day ?? 1,
  stage: 1,
  type: o.type,
  source: o.source ?? 'tool',
  text: o.text ?? '',
  ...(o.who ? { who: o.who } : {}),
  ...(o.scene ? { scene: o.scene } : {}),
  ...(o.topic ? { topic: o.topic } : {}),
  ...(o.flags ? { flags: o.flags } : {}),
})

test('对不上：两个人各说一句、方向相反，不许配成一对', () => {
  const two = [
    belief('a1', '老王不喜欢热闹。', 0, { id: 'bili:1', name: '老王' }),
    belief('a2', '小周喜欢热闹。', 3, { id: 'bili:2', name: '小周' }),
  ]
  assert.equal(detectTensions(two, { limit: 10 }).length, 0)
})

test('对不上：同一个人、方向相反，隔得近是「对不上」，隔得远是「改了口」', () => {
  const near = [
    belief('b1', '老王不喜欢人多的地方。', 0, { id: 'bili:1', name: '老王' }),
    belief('b2', '老王喜欢人多的地方。', 3, { id: 'bili:1', name: '老王' }),
  ]
  const nearHits = detectTensions(near, { limit: 10 })
  assert.equal(nearHits.length, 1)
  assert.equal(nearHits[0].kind, 'clash')

  const far = [
    belief('c1', '老王不喜欢人多的地方。', 0, { id: 'bili:1', name: '老王' }),
    belief('c2', '老王喜欢人多的地方。', 40, { id: 'bili:1', name: '老王' }),
  ]
  const farHits = detectTensions(far, { limit: 10 })
  assert.equal(farHits.length, 1)
  assert.equal(farHits[0].kind, 'drift')
})

test('身份段：最近见过但没写过判断的人，不会挡住后面写过判断的人', () => {
  const events = [
    ev({ id: 'e1', ts: at(0), type: 'utterance', text: '你好', who: { id: 'owner', name: '' }, flags: ['uncommitted'] }),
    ev({ id: 'e2', ts: at(1), type: 'voice', text: '这个好玩吗', who: { id: 'bili:9', name: '阿蓝' } }),
    ev({ id: 'e3', ts: at(2), type: 'voice', text: '我也在', who: { id: 'bili:8', name: '小周' } }),
    ev({ id: 'e4', ts: at(3), type: 'utterance', text: '小周看事情很稳。', topic: '小周' }),
    // 最新的这个没写过判断，排在 rest 第一位
    ev({ id: 'e5', ts: at(4), type: 'voice', text: '我先走了', who: { id: 'bili:7', name: '阿强' } }),
  ]
  const model = { people: peopleOf(events), day: 5, firstMetAt: at(0), recentHeard: [] }
  const section = peopleSection(model, { others: true })
  assert.match(section, /小周/)
  assert.doesNotMatch(section, /阿强/)
  assert.doesNotMatch(section, /阿蓝/)
})

test('体检：只给名字的人也进「另外见过几个人」', () => {
  const events = [
    ev({ id: 'f1', ts: at(0), type: 'voice', text: '在吗', scene: 'group', who: { id: '', name: '张三' } }),
    ev({ id: 'f2', ts: at(1), type: 'voice', text: '我也在', scene: 'group', who: { id: 'bili:1', name: '老王' } }),
  ]
  const r = examine(events)
  assert.equal(r.people.met, 2)
})

/**
 * 2026-11-24（用户 m05215「放行同对象」）：同一个人的两种描述，方向相同也要能摆出来。
 * 以前极性闸在对象判定之后，两句都不带否定词就永远进不来——而「他总是半夜回话」→
 * 「他作息挺规律」正是「发现这个人是什么样」最常见的一类。
 * 代价用户已经认了：同一个人两句互不冲突的描述也会被问一句，所以只进「说法变过」并标 suspect。
 */
test('说法变过：同一个人的两种描述，方向相同、隔开一周以上才算', () => {
  const far = [
    belief('g1', '老王总是半夜才回话。', 0, { id: 'bili:1', name: '老王' }),
    belief('g2', '老王作息挺规律的，十一点就睡。', 8, { id: 'bili:1', name: '老王' }),
  ]
  const hits = detectTensions(far, { limit: 10 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].kind, 'drift')
  assert.equal(hits[0].severity, 'suspect')

  // 隔三天：多半只是这次说的角度不同，不当成「看法变了」。
  const near = [
    belief('h1', '老王总是半夜才回话。', 0, { id: 'bili:1', name: '老王' }),
    belief('h2', '老王作息挺规律的，十一点就睡。', 3, { id: 'bili:1', name: '老王' }),
  ]
  assert.equal(detectTensions(near, { limit: 10 }).length, 0)
})

/**
 * 2026-11-24（用户 m05215）：对人的认知要跟判断、立场一样能改口。
 * 她写一条 revise、refs 指着旧那句，旧的就退场（进 changed），不是两句并排摆着。
 */
test('改口：被 revise 改掉的旧判断退场，改过口的留痕', () => {
  const events = [
    ev({ id: 'k1', ts: at(0), type: 'utterance', text: '老王这人挺急的。', who: { id: 'bili:9', name: '老王' } }),
    ev({
      id: 'k2',
      ts: at(10),
      type: 'revise',
      text: '老王比我先前想的沉得住气。',
      who: { id: 'bili:9', name: '老王' },
    }),
  ]
  // ev() 不带 refs/verdict，这里补上（真实事件里 revise 必须带 refs）。
  events[1].refs = ['k1']
  events[1].verdict = 'refined'
  const p = peopleOf(events)[0]
  assert.deepEqual(p.judgments.map((j) => j.id), ['k2'])
  assert.equal(p.changed.length, 1)
  assert.equal(p.changed[0].text, '老王这人挺急的。')
  assert.equal(p.judgments[0].changedFrom, '老王这人挺急的。')
  const page = renderPerson(p, { pronoun: '你' })
  assert.match(page, /改的口/)
  assert.match(page, /以前不是这么说的/)
  assert.match(page, /refs 填那条的 id/)
})


/**
 * 2026-11-24 第二轮审计：她关于{T}的判断多数不带 `who`（靠 topic 写称呼挂到人身上），
 * 体检从前按事件数，于是身份段里摆着「你对猫有过一句准话」，观测台却说 0 条。
 */
test('体检：靠称呼挂到{T}名下的判断也算数，不只看带 who 的事件', () => {
  const events = [
    ev({ id: 'h1', ts: at(0), type: 'heard', text: '我叫阿明。', who: { id: 'owner', name: '' } }),
    ev({ id: 'h2', ts: at(1), type: 'utterance', text: '以后叫你猫。' }),
    ev({ id: 'h3', ts: at(2), type: 'utterance', text: '猫这人嘴硬心软。', topic: '猫' }),
  ]
  const out = examine(events)
  assert.equal(out.people.ownerJudged, 1, '身份段摆着一条，体检就得数到一条')
})

/**
 * 2026-11-24 第二轮审计：预算从前按换称呼**之前**的 `{T}` 算，称呼一长这段就悄悄超了
 * `PEOPLE_SECTION_MAX`——而它现在是核心段，超出来的那部分从别处扣。
 */
test('身份段：称呼再长，这一段也不会超过自己的上限', () => {
  const people = [
    {
      id: 'owner',
      name: '一只特别特别长的称呼一只特别特别长的称呼',
      nameOnly: false,
      firstAt: T0,
      lastAt: T0,
      times: 3,
      nightTimes: 0,
      spanDays: 0,
      judgmentIds: [],
      judged: 0,
      judgments: [{ id: 'j1', at: T0, text: '猫这人嘴硬心软。', guess: false, verdict: null, changedFrom: '' }],
      changed: [],
      said: [],
      didTo: [],
    },
  ]
  const model = { name: people[0].name, people, day: 20, firstMetAt: T0 }
  const body = peopleSection(model, { others: true, maxChars: 120 })
  assert.ok(body.length <= 120, `实际 ${body.length} 字，超过 120`)
})
