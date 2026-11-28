import test from 'node:test'
import assert from 'node:assert/strict'
import { sleepFacts } from '../lib/sleepfact.js'

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const iso = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString()
const say = (t, text, id = 'ev_say') => ({ id, type: 'utterance', text, ts: t })
const wake = (t, id = 'ev_wake') => ({ type: 'meta', text: 'wake:2026-11-14 test_first', ts: t })

test('过夜十小时：给出跨度、没有动静、睡前最后一句带 id', () => {
  const now = at(2026, 11, 14, 9)
  const events = [
    say(iso(2026, 11, 13, 22, 40), '今天不想再解释一遍', 'ev_last'),
    wake(iso(2026, 11, 14, 9)),
  ]
  const f = sleepFacts(events.filter((e) => e.type !== 'meta' || Date.parse(e.ts) < now), now)
  assert.ok(f)
  assert.equal(Math.round(f.hours), 10)
  assert.match(f.text, /10 个小时/)
  assert.match(f.text, /没有别的动静/)
  assert.match(f.text, /今天不想再解释一遍/)
  assert.match(f.text, /ev_last/)
  assert.equal(f.lastWord.id, 'ev_last')
})

test('中间醒过一次：写出来，不停在「一觉到天亮」', () => {
  const now = at(2026, 11, 14, 9)
  const events = [
    say(iso(2026, 11, 13, 22, 40), '睡前一句'),
    wake(iso(2026, 11, 14, 0, 30)),
    wake(iso(2026, 11, 14, 4, 20)),
  ]
  const f = sleepFacts(events, now)
  assert.ok(f)
  assert.equal(f.middle.length, 2)
  assert.match(f.text, /中间醒过 2 次/)
  assert.match(f.text, /04:20/)
})

test('sleep: 只是记账，不算活动、也不算醒过', () => {
  const now = at(2026, 11, 14, 9)
  const events = [
    say(iso(2026, 11, 13, 22, 40), '睡前一句'),
    { type: 'meta', text: 'sleep:2026-11-14', ts: iso(2026, 11, 14, 3) },
  ]
  const f = sleepFacts(events, now)
  assert.ok(f)
  assert.equal(Math.round(f.hours), 10)
  assert.equal(f.middle.length, 0)
})

test('没有活动基线：不猜', () => {
  assert.equal(sleepFacts([], at(2026, 11, 14, 9)), null)
  // 记账行撑不起基线。这里原来拿 `seen:` 当记账的例子，但 seen: 是他来过的证据（见下一条），换成真正的记账行。
  assert.equal(sleepFacts([{ type: 'meta', text: 'quiet:2026-11-14', ts: iso(2026, 11, 14, 8) }], at(2026, 11, 14, 9)), null)
})

test('他半夜来过、事件流里只留下 seen:：起点从他来的那一刻算，不说一整夜没有动静', () => {
  // 走 /say 的桥、桥房里，他说了话、她也答了，事件流里常常只有这一行 `meta seen:`
  // （/say 不替她写 utterance，heard 每几轮才记一句）。
  const now = at(2026, 11, 14, 9)
  const events = [
    say(iso(2026, 11, 13, 22, 40), '睡前一句', 'ev_last'),
    { type: 'meta', text: `seen:${iso(2026, 11, 14, 2, 10)}`, ts: iso(2026, 11, 14, 2, 10) },
  ]
  const f = sleepFacts(events, now)
  assert.ok(f)
  assert.equal(f.start, at(2026, 11, 14, 2, 10))
  assert.equal(Math.round(f.hours), 7)
  assert.match(f.text, /从 02:10 到 09:00/)
  assert.doesNotMatch(f.text, /22:40/)
  // 她在那之后没写下什么：睡前最后写下的仍是那一句
  assert.equal(f.lastWord.id, 'ev_last')

  // 只有 seen: 也算有基线
  const only = sleepFacts([{ type: 'meta', text: `seen:${iso(2026, 11, 14, 3)}`, ts: iso(2026, 11, 14, 3) }], now)
  assert.ok(only)
  assert.equal(only.start, at(2026, 11, 14, 3))
})

test('隔了两天多：说「两天多」，不把小时数报得很大', () => {
  const now = at(2026, 11, 17, 9)
  const f = sleepFacts([say(iso(2026, 11, 15, 1), '很久以前的一句', 'ev_old')], now)
  assert.ok(f)
  assert.match(f.text, /两天多/)
  assert.doesNotMatch(f.text, /个小时/)
})

test('最后一句只从她自己的话里取：他的消息不算', () => {
  const now = at(2026, 11, 14, 9)
  const events = [
    say(iso(2026, 11, 13, 21), '她的话', 'ev_her'),
    { type: 'voice', text: '他说的话', ts: iso(2026, 11, 13, 23) },
  ]
  const f = sleepFacts(events, now)
  assert.ok(f)
  assert.equal(f.lastWord.id, 'ev_her')
  assert.match(f.text, /她的话/)
  assert.doesNotMatch(f.text, /他说的话/)
})
