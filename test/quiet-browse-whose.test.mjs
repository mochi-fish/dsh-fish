/**
 * quiet-browse-whose.test.mjs —— 便条和「翻一翻」照实说这些是谁翻到的（2026-11-23）
 *
 * 积压队列（whatseen.js 的 pendingGlances）里大多是安静刷（scheduler.js 的 quietBrowse）
 * 在后台记下的：那一趟不投递会话、不叫醒，她一个字没看见（browse.js 记 `browsed:` 那段注释：
 * 「那一趟她没看见，标题写进回忆里就是假经历」）。原先醒来便条与「翻一翻」开头一律写成她自己翻过或刷到，
 * 会把后台静默抓取的条目说成她亲手翻过的经历。
 *
 * 钉四件：
 *   1. pendingGlances 给她自己翻到过的（`looked:` / `look:`）标 mine，只在后台刷到的不标；
 *      真跑一趟 quietBrowse，记下的条目一条都不算她的；
 *   2. 全是后台抓取时：便条与「翻一翻」开头都明说由 dsh-fish 后台刷出、并非她自翻，
 *      「共 N 条；这次先摆 M 条」照旧连着；
 *   3. 全是她自己翻到过的：原话不变；
 *   4. 两种都有：开头分开说，只给她翻到过的那几条注一句。
 *
 * 全部用假 client，不联网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { quietBrowse, browseDigestLine, browseReviewText, browseReviewDue } from '../lib/scheduler.js'
import { pendingGlances } from '../lib/whatseen.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { readEvents, appendEvent } from '../lib/store.js'

const NOW = Date.parse('2026-11-17T10:00:00+08:00')
const DK = '2026-11-17'
const at = (h) => new Date(NOW - h * 3600_000).toISOString()
const bv = (i) => `BV${String(i).padStart(10, '0')}`

/** 安静刷那一趟落下的样子：`browse:` 一行 + 每条一行 `browsed:`。 */
function quietTrip(ids, h = 5) {
  const items = ids.map((i) => ({ bvid: bv(i), title: `后台${i}`, up: `UP${i}`, duration: 180 }))
  return [
    { type: 'meta', ts: at(h), text: `browse:${DK} ${JSON.stringify(items)}` },
    ...ids.map((i) => ({ type: 'meta', ts: at(h), text: `browsed:${bv(i)}` })),
  ]
}

/** 她自己用 bili_look 翻首页时落下的样子：`looked:` + `look:`（what=home 不记 judged:）。 */
function herLook(i, h = 3) {
  return [
    { type: 'meta', ts: at(h), text: `looked:${bv(i)} 她翻到的${i}` },
    { type: 'meta', ts: at(h), text: `look:${DK} ${bv(i)} ${JSON.stringify({ title: `她翻到的${i}`, up: `UP${i}`, duration: 240 })}` },
  ]
}

test('pendingGlances：她自己翻到过的标 mine，只在后台刷到的不标', () => {
  const events = [
    ...quietTrip([1, 2, 3]),
    ...herLook(4),
    // 2 号她前天自己翻首页时也带过：哪天摆到过都算她的
    { type: 'meta', ts: at(48), text: `looked:${bv(2)} 后台2` },
  ]
  const got = pendingGlances(events, { now: NOW }).map((x) => [x.bvid, x.mine])
  assert.deepEqual(got, [[bv(1), false], [bv(2), true], [bv(3), false], [bv(4), true]])
})

test('quietBrowse 真跑一趟：记下的条目一条都不算她的，便条照实说是后台刷到的', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-whose-'))
  try {
    const v = (bvid, title) => ({ bvid, title, up: '某UP', duration: 300, view: 1, pic: '' })
    const client = {
      popular: async () => ({ ok: true, data: [v('BVwhose00001', '热门一')] }),
      ranking: async () => ({ ok: true, data: [v('BVwhose00002', '热门二')] }),
      precious: async () => ({ ok: true, data: [] }),
      search: async () => ({ ok: true, data: [] }),
      related: async () => ({ ok: true, data: [] }),
      view: async (bvid) => ({ ok: true, data: { desc: '', pubdate: 1700000000, cid: 1, aid: 1, title: bvid, up: '某UP' } }),
      tags: async () => ({ ok: true, data: [] }),
      replies: async () => ({ ok: true, data: [] }),
      danmaku: async () => ({ ok: true, data: [] }),
    }
    const now = new Date('2026-11-07T12:00:00+08:00')
    const cfg = normalizeConfig({
      browse: { enabled: true, perDay: 4, topN: 2, deepRead: 0, danmaku: 0, voices: false, window: ['00:00', '23:59'] },
    })
    const r = await quietBrowse(root, { day: 2, stage: 2 }, cfg, dateKey(now), { client, now, force: true })
    assert.equal(r.ok, true, r.note)
    assert.ok(r.picks.length >= 1)

    let { events } = await readEvents(root)
    let pending = pendingGlances(events)
    assert.ok(pending.length >= 1)
    assert.ok(pending.every((x) => x.mine === false), JSON.stringify(pending))
    const line = browseDigestLine(pending)
    assert.match(line, /^dsh-fish 最近在后台刷到了 \d+ 条（不是你翻的，标题是 B 站上别人起的）：《热门/)
    assert.doesNotMatch(line, /你自己/)

    // 之后她自己用 bili_look 翻首页，带过另一条：这一条算她的，另外那几条照旧不算
    for (const e of herLook(9, 0)) await appendEvent({ type: 'meta', text: e.text }, { day: 2, stage: 2, source: 'system' }, root)
    ;({ events } = await readEvents(root))
    pending = pendingGlances(events)
    assert.deepEqual(pending.filter((x) => x.mine).map((x) => x.bvid), [bv(9)])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('全是后台刷到的：便条和「翻一翻」都不说成她翻的，「共 N 条；这次先摆 M 条」照旧连着', () => {
  const ids = Array.from({ length: 25 }, (_, i) => i)
  const events = quietTrip(ids)

  const line = browseDigestLine(pendingGlances(events, { now: NOW }), { max: 6 })
  assert.match(line, /^dsh-fish 最近在后台刷到了 二十多条（不是你翻的，标题是 B 站上别人起的）：《后台0》 BV0000000000、/)
  assert.doesNotMatch(line, /你自己|你之前翻到过/)
  assert.match(line, /想看哪条，用 bili_look 打开它；想知道画面是什么样，用 bili_watch 看一眼。$/, '后半句不动')

  const cfg = { wakesPerDay: 0, window: ['06:00', '23:00'], bili: { enabled: true }, browse: { enabled: true, perDay: 4, topN: 10 }, video: { perDay: 2 } }
  const due = browseReviewDue(events, cfg, { now: NOW, dk: DK })
  assert.ok(due)
  const text = browseReviewText(due.pending, due.batch, { left: 2 })
  assert.match(text, /^【翻一翻】这些是 dsh-fish 在后台刷到、还没摆给你看过的（不是你翻的，标题是 B 站上别人起的），共 25 条；这次先摆 20 条。\n1\. 《后台0》 BV0000000000 — UP0 · 3 分钟\n/)
  assert.doesNotMatch(text, /你之前刷到|你之前翻到过/)
  assert.match(text, /看过、或者决定不看，都算这一条已经看过——不用为了清空而看。/)
})

test('全是她自己翻到过的：原话不变', () => {
  const events = [...herLook(1, 4), ...herLook(2, 3)]
  const pending = pendingGlances(events, { now: NOW })
  assert.deepEqual(pending.map((x) => x.mine), [true, true])

  assert.match(browseDigestLine(pending), /^最近你自己又翻到了 2 条：《她翻到的1》 BV0000000001、《她翻到的2》 BV0000000002。/)
  const text = browseReviewText(pending, 20, { left: 0 })
  assert.match(text, /^【翻一翻】这些是你之前刷到、还没看过的，共 2 条；这次先摆 2 条。\n/)
  assert.doesNotMatch(text, /dsh-fish|你之前翻到过/)
})

test('两种都有：开头分开说，只给她翻到过的那几条注一句', () => {
  const events = [...quietTrip([1, 2], 5), ...herLook(3, 3)]
  const pending = pendingGlances(events, { now: NOW })

  const line = browseDigestLine(pending)
  assert.match(line, /^最近攒下了 3 条（1 条是你早先翻到的，其余由 dsh-fish 自动刷入——不是你翻的，标题是 B 站上别人起的）：/)
  assert.match(line, /《后台1》 BV0000000001、《后台2》 BV0000000002、《她翻到的3》 BV0000000003（你之前翻到过）。/)
  assert.equal(line.split('（你之前翻到过）').length - 1, 1, '只注她翻到过的那一条')

  const text = browseReviewText(pending, 2, { left: 0, videoOn: false })
  const rows = text.split('\n')
  // 「有 1 条」数的是整个积压，不是这一批：这一批摆的两条都是后台的，说「其中」会被读成这两条里有她的
  assert.equal(rows[0], '【翻一翻】这些是还没看过的，共 3 条；这次先摆 2 条。这 3 条里有 1 条是你早先翻到的，其余由 dsh-fish 自动刷入（不是你翻的，标题是 B 站上别人起的）。')
  assert.equal(rows[1], '1. 《后台1》 BV0000000001 — UP1 · 3 分钟')
  assert.equal(rows[2], '2. 《后台2》 BV0000000002 — UP2 · 3 分钟')

  // 摆到她翻到过的那条时，那一行后面注一句
  const all = browseReviewText(pending, 3, { left: 0, videoOn: false }).split('\n')
  assert.equal(all[3], '3. 《她翻到的3》 BV0000000003 — UP3 · 4 分钟 · 你之前翻到过')
  assert.doesNotMatch(all[1] + all[2], /你之前翻到过/)
})
