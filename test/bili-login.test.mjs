/**
 * bili-login.test.mjs —— 定时刷站、安静刷的客户端要带登录态（2026-11-23）。
 *
 * 真机：匿名翻评论 B 站只回 3 条（同一条视频：匿名 data=3、登录 data=20）。
 * 醒来前那趟刷站（lookBeforeWake）和安静刷（quietBrowse）建客户端时都没读
 * owner.json 里的 cookie，于是「每条读几条热评」设成 15 也只能看到三四条，
 * 深读等于白读。bili_look 那条路 1.0.6 起已经是带登录态的（issue #150），这两条漏了。
 *
 * 全部用假 fetch，不碰真网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { biliClientFor } from '../lib/scheduler.js'

const SPI = { code: 0, data: { b_3: 'BUVID3-TEST', b_4: 'BUVID4-TEST' } }
const VIEW = { code: 0, data: { bvid: 'BV1xx411c7mD', aid: 1, cid: 2, title: 't', owner: { name: 'up' } } }

/** 假 fetch：记下每次请求的 URL 和 cookie 头 */
function mkFetch() {
  const calls = []
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), cookie: init.headers?.cookie ?? '' })
    const body = String(url).includes('/x/frontend/finger/spi') ? SPI : VIEW
    const text = JSON.stringify(body)
    return { status: 200, text: async () => text, json: async () => body }
  }
  f.calls = calls
  return f
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-login-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function withFakeFetch(fake, fn) {
  const old = globalThis.fetch
  globalThis.fetch = fake
  try {
    return await fn()
  } finally {
    globalThis.fetch = old
  }
}

test('owner.json 里有 cookie：定时刷站建出来的客户端带着它', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'owner.json'), JSON.stringify({ mid: '1', cookie: 'SESSDATA=abc; bili_jct=def' }))
    const f = mkFetch()
    await withFakeFetch(f, async () => {
      const client = await biliClientFor(root)
      const r = await client.view('BV1xx411c7mD')
      assert.equal(r.ok, true)
      const view = f.calls.find((x) => x.url.includes('/x/web-interface/view'))
      assert.match(view.cookie, /SESSDATA=abc/)
      assert.match(view.cookie, /bili_jct=def/)
    })
  })
})

test('没有 owner.json（没登录）：退回匿名客户端，照常带匿名 buvid3', async () => {
  await withRoot(async (root) => {
    const f = mkFetch()
    await withFakeFetch(f, async () => {
      const client = await biliClientFor(root)
      const r = await client.view('BV1xx411c7mD')
      assert.equal(r.ok, true)
      const view = f.calls.find((x) => x.url.includes('/x/web-interface/view'))
      assert.doesNotMatch(view.cookie, /SESSDATA/)
      assert.match(view.cookie, /(?:^|;\s*)buvid3=BUVID3-TEST/)
    })
  })
})

