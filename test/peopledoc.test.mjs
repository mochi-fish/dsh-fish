/**
 * peopledoc.test.mjs —— `home/她认识的人.md` 这份抄本（1.1.0 S3-b）
 *
 * 这一组守四件事：
 *   ① 它是派生副本：同一份 model 写两次，第二次不动文件（幂等）；
 *   ② 开关关着时文档里只有{T}一个人；
 *   ③ 一个人都没有时说的是人话，不是一份空文件；
 *   ④ 落点就在 `home/` 下，名字不叫 `AGENTS.md`（那个名字会被宿主当指令注入）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { peopleDocPath, renderPeopleDoc, writePeopleDocFrom } from '../lib/peopledoc.js'
import { peopleOf } from '../lib/people.js'

const OWNER = { id: 'owner', name: '' }
const WANG = { id: 'bili:1001', name: '老王' }

function ev(o) {
  return { id: o.id, type: o.type, ts: o.ts, text: o.text, who: o.who, topic: o.topic, refs: o.refs }
}

const T1 = '2026-11-01T10:00:00.000Z'
const T2 = '2026-11-02T10:00:00.000Z'
const T3 = '2026-11-03T10:00:00.000Z'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-people-'))
}

function model() {
  return {
    day: 5,
    firstMetAt: T1,
    people: peopleOf([
      ev({ id: 'e1', type: 'heard', ts: T1, text: '今天有点累。', who: OWNER }),
      ev({ id: 'e2', type: 'voice', ts: T2, text: '我一般两点才睡。', who: WANG }),
      ev({ id: 'e3', type: 'utterance', ts: T3, text: '老王是个能熬夜的人。', who: WANG }),
    ]),
  }
}

test('落点在 home/ 下，名字不叫 AGENTS.md', () => {
  const root = 'C:\\house'
  assert.match(peopleDocPath(root), /她认识的人\.md$/)
  assert.match(peopleDocPath(root), /home/)
  assert.doesNotMatch(peopleDocPath(root), /AGENTS\.md/, '那个名字会被宿主当指令注入对话')
})

test('幂等：同一份 model 写两次，第二次不动文件', async () => {
  const root = await tmpRoot()
  try {
    await writeFile(join(root, 'events.jsonl'), '', 'utf8')
    const cfg = { people: { others: { enabled: true } } }
    const first = await writePeopleDocFrom(root, model(), cfg)
    assert.equal(first.ok, true)
    assert.equal(first.changed, true)

    const text1 = await readFile(first.file, 'utf8')

    const second = await writePeopleDocFrom(root, model(), cfg)
    assert.equal(second.ok, true)
    assert.equal(second.changed, false, '内容没变就不该再动一次文件')
    assert.equal(await readFile(second.file, 'utf8'), text1)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('开关关着：文档里只有主人一个', async () => {
  const root = await tmpRoot()
  try {
    const closed = await writePeopleDocFrom(root, model(), { people: { others: { enabled: false } } })
    const text = await readFile(closed.file, 'utf8')
    assert.match(text, /# 她认识的人/)
    assert.match(text, /重算出来的抄本/, '要写明改它不生效')
    assert.doesNotMatch(text, /老王/, '开关关着，她的世界里只有一个人')

    const open = await writePeopleDocFrom(root, model(), { people: { others: { enabled: true } } })
    const all = await readFile(open.file, 'utf8')
    assert.match(all, /老王/)
    assert.equal(open.changed, true, '内容变了就得重写')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('一个人都没有时说的是人话', () => {
  const text = renderPeopleDoc({ people: [] }, { pronoun: '他', others: true })
  assert.match(text, /# 她认识的人/)
  assert.match(text, /还没有/)
  assert.doesNotMatch(text, /undefined/)
})
