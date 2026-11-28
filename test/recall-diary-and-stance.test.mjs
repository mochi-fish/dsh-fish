/**
 * recall-diary-and-stance.test.mjs —— her_recall 日记/单字汉字分词，以及 stance 改口收拢与第 9–12 位拒绝保留
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerRecall, tokensOf, searchEvents, searchOps } from '../lib/recall.js'
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
