/**
 * tenant-live-cwd.test.mjs —— 会话换过工作目录之后，写入口还认不认得她的家
 * （2026-11-24 issue #179）
 *
 * 真机：插件 1.0.9 + dsh-go，会话出生在 `/root/workspace`，用户用宿主
 * `working_directory` 切到 `/root/.dsh-fish`，之后所有 her_* 写入口都回
 * 「这条调用来自另一个家」——`callerOf()` 只看 `session.header.cwd`（出生目录），
 * 没看宿主的 workingDirectory 投影（当前目录）。
 *
 * 这里钉四件事：
 *   1. `callerOf` 优先读 workingDirectory 服务的当前目录，取不到回落出生目录；
 *   2. `checkCaller` 按当前目录放行「出生在别处、此刻在自己家里」的会话；
 *   3. 按会话 id 认她（`isHerSession`）时，cwd 在哪都放行——她换目录不等于换人；
 *   4. 不是她的会话仍按 cwd 挡（换目录不能变成越权写入的通行证）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { callerOf, checkCaller, guardWrite } from '../lib/tenant.js'

const ROOT = 'C:\\Users\\someone\\.dsh-fish'
const HER = join(ROOT, 'home')

/** 假的宿主上下文：`ctx.get('workingDirectory').get(session)` 就是当前目录。 */
function fakeCtx(current) {
  return {
    get(name) {
      if (name !== 'workingDirectory') return undefined
      return { get: () => current }
    },
  }
}

function execOf({ id = 'session-a', born, live }) {
  const session = { id, header: { id, cwd: born, sandbox: 'workspace-write' } }
  return { agent: { session }, session }
}

test('callerOf：当前目录优先于出生目录', () => {
  const exec = execOf({ born: 'C:\\Users\\someone\\workspace', live: HER })
  const got = callerOf(exec, fakeCtx(HER))
  assert.equal(got.cwd, HER)
  assert.equal(got.bornCwd, 'C:\\Users\\someone\\workspace')
})

test('callerOf：没有服务、服务抛错时都回落到出生目录', () => {
  const exec = execOf({ born: 'C:\\Users\\someone\\workspace', live: HER })
  assert.equal(callerOf(exec, null).cwd, 'C:\\Users\\someone\\workspace')
  const boom = { get() { throw new Error('no service') } }
  assert.equal(callerOf(exec, boom).cwd, 'C:\\Users\\someone\\workspace')
})

test('checkCaller：出生在别处、此刻在自己家里 → 放行', () => {
  const exec = execOf({ born: 'C:\\Users\\someone\\workspace', live: HER })
  const res = checkCaller(ROOT, exec, { herDir: HER, tool: 'her_note', ctx: fakeCtx(HER) })
  assert.equal(res.ok, true)
  assert.equal(res.cwd, HER)
})

test('checkCaller：出生在家里、此刻在别处、又不是她的会话 → 拒绝', () => {
  const exec = execOf({ born: HER, live: 'D:\\work\\other' })
  const res = checkCaller(ROOT, exec, { herDir: HER, tool: 'her_note', ctx: fakeCtx('D:\\work\\other') })
  assert.equal(res.ok, false)
  assert.match(res.why, /另一个家/)
})

test('checkCaller：按会话 id 是她的 → cwd 在别处也放行', () => {
  const exec = execOf({ id: 'session-her', born: 'D:\\work\\other', live: 'D:\\work\\other' })
  const res = checkCaller(ROOT, exec, {
    herDir: HER,
    tool: 'her_note',
    ctx: fakeCtx('D:\\work\\other'),
    isHerSession: (sid) => sid === 'session-her',
  })
  assert.equal(res.ok, true)
  assert.equal(res.hers, true)
})

test('guardWrite：从 state 里拿 ctx 与 isHerSession（换过目录的她的会话照写）', () => {
  const state = {
    root: ROOT,
    herDir: HER,
    tenant: { ok: true },
    ctx: fakeCtx('D:\\work\\other'),
    isHerSession: (sid) => sid === 'session-her',
  }
  const mine = execOf({ id: 'session-her', born: HER, live: 'D:\\work\\other' })
  assert.equal(guardWrite(state, mine, 'her_note').ok, true)

  const other = execOf({ id: 'session-other', born: HER, live: 'D:\\work\\other' })
  const denied = guardWrite(state, other, 'her_note')
  assert.equal(denied.ok, false)
  assert.match(denied.note, /另一个家/)
})
