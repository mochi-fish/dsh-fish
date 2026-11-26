/**
 * state-config.test.mjs —— 设置页回填的那份 config 不能少键（2026-11-26）
 *
 * 外部反馈：把「一天最多几版」填成 10，关掉界面再打开、重启之后又回到 2。
 * 盘上存的是 10（`updateConfig` 深合并，`works` 不在整表保存里），坏的是读：
 * `/state` 的 `config` 是一份手写白名单，里面没有 `works`，客户端
 * `Number(s.config?.works?.versionsPerDay ?? 2)` 就只能落回默认值。
 *
 * 所以这里守两件事：
 *   1. 盘上是什么，`/state` 就原样说什么（works / 梦 / 回引 / 定时醒 …）；
 *   2. 客户端从 `s.config?.X` 读的每一个键，`/state` 都得给——以后加设置项
 *      忘了同步这份白名单时，这条会先红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeConfig } from '../lib/store.js'
import { registerObserve } from '../lib/observe.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = join(HERE, '..', 'lib', 'client')

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-state-config-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function fakeObserveCtx() {
  const routes = []
  const ctx = {
    get: (k) => (k === 'connection'
      ? { requestRejection: () => null }
      : k === 'webServer'
        ? { register: (def) => { routes.push(def); return () => {} } }
        : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  return { ctx, routes }
}

async function stateOf(root) {
  const { ctx, routes } = fakeObserveCtx()
  registerObserve(ctx, { root, version: '0.0.0-test', tenancy: { tenant: { ok: true, instanceId: 'me' } } })
  const route = routes.find((r) => String(r.path || '').endsWith('/state'))
  assert.ok(route, '必须有 /state 路由')
  let status = 0
  let body = ''
  const res = { writeHead: (s) => { status = s }, setHeader: () => {}, end: (s) => { body = String(s ?? '') } }
  await route.handler({ method: 'GET', url: route.path, headers: {} }, res)
  assert.equal(status, 200, `/state 要 200，实际 ${status}`)
  return JSON.parse(body)
}

test('设置页的 config：盘上存成什么，/state 就说什么', async () => {
  await withRoot(async (root) => {
    await writeConfig({
      wakesPerDay: 5,
      works: { versionsPerDay: 10, keepVersions: false },
      drive: { enabled: false },
      interest: { enabled: false },
      dream: { enabled: false },
      cue: { enabled: false },
      memory: { selfWake: false, echo: false },
    }, root)
    const st = await stateOf(root)
    const c = st.config ?? {}
    assert.equal(c.works?.versionsPerDay, 10, '一天最多几版：存 10 就要说 10（不是回填默认的 2）')
    assert.equal(c.works?.keepVersions, false, '旧版留不留：关着就要说关着')
    assert.equal(c.wakesPerDay, 5, '每天定时醒几次：存 5 就要说 5')
    assert.equal(c.drive?.enabled, false, '梦/主动性这些开关也一样，不能回填成默认开')
    assert.equal(c.interest?.enabled, false)
    assert.equal(c.dream?.enabled, false)
    assert.equal(c.cue?.enabled, false)
    assert.equal(c.memory?.selfWake, false)
    assert.equal(c.memory?.echo, false)
  })
})

test('设置页的 config：客户端读的每一个键，/state 都得给（防以后加设置项忘了同步）', async () => {
  const files = (await readdir(CLIENT_DIR)).filter((f) => f.endsWith('.js'))
  assert.ok(files.length > 0, '前提：lib/client 下要有分片')
  const reads = new Set()
  for (const f of files) {
    const text = await readFile(join(CLIENT_DIR, f), 'utf8')
    for (const m of text.matchAll(/(?:^|[^\w$])(?:s|state)\??\.config\?\.([A-Za-z_$][\w$]*)(?:\?\.([A-Za-z_$][\w$]*))?/g)) {
      reads.add(m[2] ? `${m[1]}.${m[2]}` : m[1])
    }
  }
  assert.ok(reads.size > 0, '前提：客户端确实从状态页里读配置')
  await withRoot(async (root) => {
    const st = await stateOf(root)
    for (const path of reads) {
      const [head, sub] = path.split('.')
      const v = st.config?.[head]
      assert.notEqual(v, undefined, `客户端读 s.config.${head}，/state 却没给这一个键`)
      if (sub) assert.notEqual(v?.[sub], undefined, `客户端读 s.config.${path}，/state 里缺 ${path}`)
    }
  })
})
