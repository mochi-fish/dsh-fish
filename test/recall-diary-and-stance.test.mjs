/**
 * recall-diary-and-stance.test.mjs —— her_recall 日记/单字汉字分词，以及 stance 改口收拢与第 9–12 位拒绝保留
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerRecall, tokensOf, searchEvents, searchOps } from '../lib/recall.js'
import { buildStances, stanceSection, stanceDetail, STANCE_PROMPT_MAX } from '../lib/stance.js'
import { buildSections } from '../lib/persona.js'
import { appendEvent, writeDaily } from '../lib/store.js'

const DAY_MS = 86_400_000

test('tokensOf 与 searchEvents / searchOps 支持单字汉字与书名号引号包裹，过滤单字英文数字', () => {
  assert.deepEqual(tokensOf('药'), ['药'])
  assert.deepEqual(tokensOf('「药」'), ['药'])
  assert.deepEqual(tokensOf('《周易》'), ['周易'])
  assert.deepEqual(tokensOf('a 9 琴'), ['琴'])

  const now = Date.now()
  const events = [
    { id: 'e1', type: 'utterance', ts: new Date(now - DAY_MS).toISOString(), text: '记得提醒他按时吃药。' },
    { id: 'e2', type: 'utterance', ts: new Date(now - 2 * DAY_MS).toISOString(), text: '今天练了一会儿琴。' },
  ]
  assert.equal(searchEvents(events, '药', { now }).rows[0]?.id, 'e1')
  assert.equal(searchEvents(events, '「琴」', { now }).rows[0]?.id, 'e2')

  const ops = searchOps({
    notes: [{ id: 'n1', text: '把药放进包里', status: 'open', created: new Date(now - DAY_MS).toISOString() }],
    appointments: [{ id: 'a1', what: '陪他去拿药', due: '2026-11-28', status: 'open', created: new Date(now - DAY_MS).toISOString() }],
  }, '药', { now })
  assert.equal(ops.length, 2)
  assert.ok(ops.some((line) => line.includes('把药放进包里')))
  assert.ok(ops.some((line) => line.includes('陪{T}去拿药') || line.includes('陪他去拿药')))
})

test('her_recall 传 kind="diary" 能翻到 diary/ 下的日记，不传 kind 时不混入事件流', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-recall-diary-'))
  try {
    await writeDaily('diaryDir', '2026-11-20', '今天下雨，看了一段弹吉他的视频。', root)
    await writeDaily('diaryDir', '2026-11-25', '夜里读完了《周易》里的一节，记一笔。', root)
    await appendEvent({ type: 'utterance', text: '事件流里只有这一句闲话。' }, { day: 5, stage: 2, source: 'system' }, root)

    let recallTool = null
    registerRecall({ tools: { register: (d) => { recallTool = d; return d } } }, { root })

    // 不传 kind：不把日记混进普通事件流检索
    const general = await recallTool.execute({ query: '周易' })
    assert.equal(general.found, false)

    // 明确传 kind="diary"：翻出对应日记与日期
    const diaryHit = await recallTool.execute({ kind: 'diary', query: '《周易》' })
    assert.equal(diaryHit.found, true)
    assert.match(diaryHit.text, /2026-11-25/)
    assert.match(diaryHit.text, /周易/)

    // 单字查询 + kind="diary"
    const singleCharHit = await recallTool.execute({ kind: 'diary', query: '雨' })
    assert.equal(singleCharHit.found, true)
    assert.match(singleCharHit.text, /2026-11-20/)
    assert.match(singleCharHit.text, /下雨/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('stance 同向 never 与 refused 并存后遇到反向改口时一并退场', () => {
  const belief = (id, text, since, extra = {}) => ({
    id, text, since, confidence: 0.7, status: 'active', mentions: 3, verified: 0, ...extra,
  })
  const refusal = (id, at, what, object, act = '') => ({
    id, at, what, act, object, quote: what, reaction: 'insist', refs: [], fromOwner: null, revisedVerdict: null,
  })

  const flipped = buildStances({
    stage: 4,
    stageGate: { passed: ['trust', 'autonomy', 'competence'] },
    scars: [],
    beliefs: [
      belief('b1', '我绝不吃香菜', '2026-10-01T10:00:00Z'),
      belief('b2', '我绝不吃香菜', '2026-10-02T10:00:00Z'),
      belief('l1', '我喜欢吃香菜', '2026-10-20T10:00:00Z'),
      belief('l2', '我喜欢吃香菜', '2026-10-22T10:00:00Z'),
    ],
    refusals: [
      refusal('r1', '2026-10-05T10:00:00Z', '我不想吃香菜', '香菜', '吃'),
      refusal('r2', '2026-10-07T10:00:00Z', '我不想吃香菜', '香菜', '吃'),
    ],
  })
  assert.deepEqual(flipped.map((s) => s.kind), ['like'])
  assert.ok(stanceSection(flipped).includes('这件事我改过口'))
  assert.ok(!stanceSection(flipped).includes('这件事你没答应'))
})

test('被同向判断吸收的拒绝：排在前 8 条时不重复，排在第 9–12 条时仍保留在「你拒绝过」', () => {
  const belief = (id, text, since, extra = {}) => ({
    id, text, since, confidence: 0.7, status: 'active', mentions: 3, verified: 0, ...extra,
  })
  const refusal = (id, at, what, object, act = '') => ({
    id, at, what, act, object, quote: what, reaction: 'insist', refs: [], fromOwner: null, revisedVerdict: null,
  })
  const fillerTopics = ['替别人写作业', '在群里唱歌', '半夜大声喧哗', '假装自己是人', '私自改掉约定', '把私聊贴到群里', '随手删掉旧信', '瞎编没看过的书']
  const makeModel = (fillerCount) => ({
    seed: '你是一条会自己长起来的鱼。',
    day: 60,
    stage: 4,
    stageGate: { passed: ['trust', 'autonomy', 'competence'] },
    faded: [],
    tensions: [],
    solid: [],
    refuted: [],
    selfmodAttempts: [],
    facts: { hurts: 0 },
    narrative: null,
    name: null,
    absenceDays: 0,
    scars: fillerTopics.slice(0, fillerCount).map((t) => ({ quote: `我绝不${t}`, reaction: 'insist' })),
    beliefs: [
      ...fillerTopics.slice(0, fillerCount).map((t, i) => belief(`f${i}`, `我绝不${t}`, '2026-10-01T10:00:00Z')),
      belief('dup1', '我绝不迟到', '2026-10-03T10:00:00Z', { mentions: 2 }),
      belief('dup2', '我绝不迟到', '2026-10-04T10:00:00Z', { mentions: 2 }),
    ],
    refusals: [
      refusal('rd1', '2026-10-05T10:00:00Z', '我绝不迟到', '迟到'),
      refusal('rd2', '2026-10-06T10:00:00Z', '我绝不迟到', '迟到'),
    ],
  })

  const inTop8 = buildSections(makeModel(STANCE_PROMPT_MAX - 1), { pronoun: '她' }).map((s) => s.text).join('\n\n')
  assert.ok(inTop8.includes('我绝不迟到'))
  assert.ok(!inTop8.includes('## 你拒绝过'), '已在前 8 条展示的吸收拒绝不再重复出现在「你拒绝过」')

  const atRank9Model = makeModel(STANCE_PROMPT_MAX)
  const atRank9Doc = buildSections(atRank9Model, { pronoun: '她' }).map((s) => s.text).join('\n\n')
  const standPart = atRank9Doc.split('\n\n').find((s) => s.startsWith('## 我站哪边')) ?? ''
  const refusedPart = atRank9Doc.split('\n\n').find((s) => s.startsWith('## 你拒绝过')) ?? ''
  assert.ok(!standPart.includes('迟到'))
  assert.ok(refusedPart.includes('我绝不迟到'), '排到第 9 条没进「我站哪边」时，拒绝仍保留在「你拒绝过」里')

  const detail = stanceDetail(atRank9Model)
  assert.equal(detail.length, STANCE_PROMPT_MAX + 1)
  assert.equal(detail.at(-1).shown, false)
})
