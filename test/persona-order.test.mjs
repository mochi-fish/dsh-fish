import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSections,
  assembleWithPlan,
  worldBeliefsOf,
  sectionRank,
  sectionLabel,
  SELF_DOC_BUDGET,
} from '../lib/persona.js'

// 2026-11-24（用户 m05523）：
// 三段改动各配一条测试 —— ①人的判断不许在三处重复印（bug）②可选段放不下时
// 不许整段消失（段内降级）③可选段的先后按「谁更是她这个人」重排。
// 三条都不是观感问题：①会让她以为自己对老王说了三遍同一句话，
// ②会让 361 字的「你对自己的说法」因为差 200 字一句不留。

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-24T12:00:00.000Z')

function model(extra = {}) {
  return {
    seed: '你是一条会自己长起来的鱼。',
    beliefs: [],
    solid: [],
    tensions: [],
    drifts: [],
    unsettled: [],
    faded: [],
    refusals: [],
    scars: [],
    selfmodAttempts: [],
    refuted: [],
    narrative: null,
    facts: { refused: 0, hurts: 0, scars: 0, scarsResolved: 0 },
    day: 20,
    growthDays: 30,
    stage: 2,
    ...extra,
  }
}

test('视图分开：topic 写了人名的判断，不算「世界」，也不在别处重复印', () => {
  // 这一条对应的真 bug：她按 S0.5 教的写「对某人的判断」是把人名写进 topic，
  // 事件上的 who 是空的；原来只认 who.id，于是这条判断既进「你认识的{T}」，
  // 又进「你自己说过的话」，还会被折进「更早以后」——同一句话摆三遍。
  const beliefs = [
    { id: 'p1', text: '老王这人心是软的，嘴上硬。', topic: '老王', who: null, since: '2026-11-20T00:00:00.000Z' },
    { id: 'w1', text: '写代码这件事，慢下来反而快。', topic: '', who: null, since: '2026-11-20T00:00:00.000Z' },
    { id: 'w2', text: '别人问你问题时，先说答案。', topic: '', who: null, since: '2026-11-20T00:00:00.000Z' },
  ]
  const people = [
    {
      id: 'bili:9',
      name: '老王',
      firstAt: NOW - 10 * DAY,
      lastAt: NOW - 2 * DAY,
      judgments: [{ text: '老王这人心是软的，嘴上硬。', at: NOW - 2 * DAY, guess: false, verdict: null, changedFrom: '' }],
      changed: [],
      said: [],
      didTo: [],
      nameOnly: false,
    },
  ]
  const m = model({ beliefs, people })

  const world = worldBeliefsOf(m)
  assert.deepEqual(
    world.map((b) => b.id),
    ['w1', 'w2'],
    '关于老王的那条不该算世界判断',
  )

  const text = buildSections(m, { shown: 5, peopleOthers: true })
    .map((s) => s.text)
    .join('\n')
  const peopleHead = text.indexOf('## 你认识的')
  assert.ok(peopleHead >= 0, '认识人段得在')
  const selfHead = text.indexOf('## 你自己说过的话')
  assert.ok(selfHead >= 0, '判断段得在')
  const selfSeg = text.slice(selfHead)
  assert.ok(!selfSeg.includes('老王这人心是软的'), '人的判断不该在「你自己说过的话」里再印一遍')
  assert.ok(!text.includes('更早以前') || !text.slice(text.indexOf('## 更早以前')).includes('老王这人心是软的'))
})

test('段内降级：长的放不下就换短的，短版也放不下才整段撤', () => {
  const long = `## 你对自己的说法\n${'长'.repeat(120)}\n${'旧'.repeat(40)}`
  const short = `## 你对自己的说法\n${'长'.repeat(120)}`
  const core = { text: '## 现在\n今天在。', keep: true }

  // 预算刚好够长版：原样摆出来，不是缩水
  {
    const plan = assembleWithPlan([core, { text: long, keep: false, id: 'narrative', alt: short }], 200)
    const row = plan.plan.find((p) => p.id === 'narrative')
    assert.equal(row.kept, true)
    assert.equal(row.shrunk, false, '放得下就别缩')
    assert.ok(plan.text.includes('旧'))
  }

  // 预算只够短版：整段不该消失，而是缩成短版并记账
  {
    // 长版 170 字、短版 129 字、核心段 10 字；150 只够短版
    const plan = assembleWithPlan([core, { text: long, keep: false, id: 'narrative', alt: short }], 150)
    const row = plan.plan.find((p) => p.id === 'narrative')
    assert.equal(row.kept, true, '短版放得下就不许整段消失')
    assert.equal(row.shrunk, true, '要记下这一条是缩过的')
    assert.ok(plan.text.includes('## 你对自己的说法'))
    assert.ok(!plan.text.includes('旧'), '缩的是「上一段」那半截')
  }

  // 连短版都放不下：才整段撤
  {
    const plan = assembleWithPlan([core, { text: long, keep: false, id: 'narrative', alt: short }], 10)
    const row = plan.plan.find((p) => p.id === 'narrative')
    assert.equal(row.kept, false)
    assert.ok(!plan.text.includes('你对自己的说法'))
  }
})

test('可选段顺序：她拒绝过的排在「你对自己的说法」前头', () => {
  // 顺序按「谁更像她这个人」排，不按产生时间：拒绝过是她做过的选择，
  // 说法只是这个月的总述。两人互换之后，同样的预算先留住的是前面那些。
  const rankOf = (heading) => sectionRank({ text: `## ${heading}\n- x`, keep: false })
  assert.ok(rankOf('你自己说过的话') < rankOf('你拒绝过'))
  assert.ok(rankOf('你拒绝过') < rankOf('你对自己的说法'))
  assert.ok(rankOf('你对自己的说法') < rankOf('你读到的一句话'))
  assert.ok(rankOf('你读到的一句话') < rankOf('你反复想起过的事'))
  // 核心段永远排在最前（rank 0），所以重排不会把「## 这次」顶上来
  assert.equal(sectionRank({ text: '## 这次\n做点事', keep: true }), 0)
  assert.equal(sectionLabel({ text: '## 你拒绝过\n- x' }), '你拒绝过')
})

test('预算常量与配置同源：3600', () => {
  assert.equal(SELF_DOC_BUDGET, 3600)
})

test('判「关于谁」用不截断的人名与 id，不用界面那份 24 人名单（用户 m05827）', () => {
  const model = {
    beliefs: [
      { id: 'b1', who: {}, topic: '朋友1', text: '朋友1 话不多。' },
      { id: 'w1', who: {}, topic: '', text: '夜里容易想事情。' },
    ],
    // 展示用的名单只留得下 24 个，朋友1 被截在外面
    people: [{ id: 'owner', name: '猫', judgments: [], changed: [], said: [], didTo: [] }],
    peopleNames: ['猫', '朋友1'],
    personBeliefIds: ['b1'],
  }
  assert.deepEqual(worldBeliefsOf(model).map((b) => b.id), ['w1'], '关于人的那条不算世界')
})
