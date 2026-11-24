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
import { peopleOf, peopleSection } from '../lib/people.js'
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
