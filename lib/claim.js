/**
 * 「等一封外面来的信，再认这条会话是她」的登记处（2026-11-23）。
 *
 * 背景：1.0.8 起按会话 id 认人。她自己那条会话 id 由建会话的路（`asHerSession`）
 * 记进台账；可**桥自建的会话**不在我们的建会话路上——桥装成独立进程，用自己的
 * 账号起一条 DSH 会话，再把 QQ / Telegram 的话 prompt 进去。那条会话 cwd 就是她的
 * 屋子，id 却不在册，于是身份段没挂、工具面也没收窄，读起来像换了一条鱼。
 *
 * 为什么不退回「cwd 一样就是她」：那正是 1.0.8 修掉的误伤——他本人在「大肥鱼的家」
 * 这个工作区里开会话，也会被当成她。所以判据不能只看目录。
 *
 * 判据换成**来信**：他自己开在那个工作区的会话，收的是客户端打的字（带
 * `clientTimeZone`）或插件自己的东西；桥转进来的话一定带着桥的记号（群聊 / 群里的
 * 他 / 没有时区的 `human`）。第一封那样的信到达时，这条会话才算她——那时候再把
 * 身份段与工具面补挂上去。
 *
 * 这个模块**不 import 任何项目模块**：identity.js 与 restrict.js 都往里登记
 * 回调，turns.js 只负责认出来信后调 `claimSession`。避免 turns → identity 那条
 * 已经存在的依赖再绕回来成环。
 */

const waiters = new Map() // 「家 + 会话 id」→ Set<() => void>

function keyOf(sessionId, herDir) {
  const home = String(herDir ?? '')
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase()
  const sid = String(sessionId ?? '').replace(/^session-/, '')
  return `${home}\u0000${sid}`
}

/**
 * 登记一条「这条会话要是她的，就这么装备它」的回调。
 *
 * 同一个会话、同一个家登记多次会被去重；一个家下的多条会话互不影响。
 *
 * @param {string} sessionId
 * @param {string} herDir
 * @param {() => void} fn 认领后要跑的事（挂身份段、下收窄刀、挂兜底守卫）
 */
export function whenHers(sessionId, herDir, fn) {
  const sid = String(sessionId ?? '').replace(/^session-/, '')
  if (!sid || typeof fn !== 'function') return
  const key = keyOf(sid, herDir)
  let set = waiters.get(key)
  if (!set) waiters.set(key, set = new Set())
  set.add(fn)
}

/**
 * 这封信是外面来的：把这条会话认下来，跑掉登记的回调。
 *
 * 只跑一次（跑完就清），后面的来信不再重复装备。返回是否真的认领了。
 */
export function claimSession(sessionId, herDir) {
  const sid = String(sessionId ?? '').replace(/^session-/, '')
  if (!sid) return false
  const key = keyOf(sid, herDir)
  const set = waiters.get(key)
  if (!set || !set.size) return false
  waiters.delete(key)
  for (const fn of set) {
    try { fn() } catch { /* 一个钩子挂了不能连累另一个 */ }
  }
  return true
}

/**
 * 这封来信是不是「外面来的」——桥转进来的话。
 *
 * 只认三种：群聊、群里的他、没有 `clientTimeZone` 的 `human`。最后一条是因为
 * 本地客户端打的字一定带时区；宿主自己拼的上下文没有 `source`（classifyMessage
 * 返回 `context`），插件的记账走 `plugin`，都不算。
 *
 * **`kind` 必须是 `user`**（2026-11-23 对抗复核抓到的）：宿主的 `prompt()` 在正文
 * 为空时把 kind 写成 `retry`，classifyMessage 的最后一条又会把不认识的 kind 全当人。
 * 他屋里那条普通会话只要点一次「重试」，`human` + 无时区就长得跟桥来信一模一样，
 * 于是被认成她——1.0.8 修掉的那种误伤会从这道门再进来一次。桥建会话一定走
 * `session.prompt()`，宿主固定写 `kind:'user'`；插件的 `/say` 走自己的 kind，
 * 但那条路不建新会话（房间 id 早就在台账里），不需要这里认。
 *
 * @param {string} cls `classifyMessage()` 的结论
 * @param {{ kind?: string, clientTimeZone?: string } | undefined} source 事件的 `data.source`
 */
export function isBridgeMessage(cls, source) {
  const src = source ?? {}
  if (String(src.kind ?? '') !== 'user') return false
  return cls === 'group' || cls === 'group-owner'
    || (cls === 'human' && !src.clientTimeZone)
}

/** 测试用：清空登记。 */
export function resetClaimWaiters() {
  waiters.clear()
}

/** 测试用：看还有没有人在等（不暴露回调本身）。 */
export function pendingClaimCount() {
  let n = 0
  for (const set of waiters.values()) n += set.size
  return n
}
