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
// 显式认领（桥调 /claim）用的两本账。会话一建出来就记下 agent，等桥点名再装备；
// 与 waiters 分开：waiters 只给「目录命中 + 第一封来信」那条自动路，显式认领要能
// 认任何目录里的会话，但不能让来信自己触发——否则他普通窗口里收到一条插件消息
// 也会被认成她。
const agents = new Map() // 归一后的会话 id → WeakRef<agent>
const claimers = new Map() // 归一后的会话 id → Set<() => boolean>
const claimedNow = new Set() // 这一次跑起来后被显式认领过的 id（1.1.1：给 /release 与日志用）

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
 * 三条认法：
 *   ① 桥显式声明 `source.bridge === true`（给以后的桥用；只有插件投递才写得出来）；
 *   ② 插件中转：`source.kind` 是 `plugin:<插件名>`。有些桥（dsh-onebot-qq）直接把
 *      消息 `followup` 进会话，kind 写自己的前缀，不经过宿主的 prompt()。
 *   ③ 宿主 `prompt()` 送进来的：kind 固定 `user`；群聊、群里的他、没有
 *      `clientTimeZone` 的 human 才算。
 *
 * 为什么仍要死守 `kind === 'user'` 这一条（2026-11-23 对抗复核抓到的）：宿主的
 * `prompt()` 在正文为空时把 kind 写成 `retry`，classifyMessage 的最后一条又会把
 * 不认识的 kind 全当人。他屋里那条普通会话只要点一次「重试」，`human` + 无时区
 * 就长得跟桥来信一模一样，于是被认成她——1.0.8 修掉的那种误伤会从这道门再进来。
 * 所以 ③ 只认 user；`retry`、空 kind、自己起名的 kind 都不算。
 *
 * ② 的取舍（2026-11-24，issue #179 之后的外部报告）：插件中转是 QQ 私聊唯一
 * 的来信形状，不放行就等于每换一次房、每重启一次都把她的人设弄丢。代价是
 * 「别的插件往一条建在她屋里、还没认领的会话里投消息」也会触发认领——这比
 * 每个私聊新会话都裸跑轻得多。自己插件的记账（`plugin:dsh-fish`、`fish:'note'`）
 * 排除在外。
 *
 * @param {string} cls `classifyMessage()` 的结论
 * @param {{ kind?: string, clientTimeZone?: string, bridge?: boolean, fish?: string } | undefined} source 事件的 `data.source`
 */
export function isBridgeMessage(cls, source) {
  const src = source ?? {}
  const kind = String(src.kind ?? '')

  // ① 新契约：桥自己说「这是转进来的」。
  if (src.bridge === true && kind !== 'retry' && kind !== '') return true

  // ② 插件中转：kind 带 plugin: 前缀。宿主 prompt() 不写这种 kind，本地客户端也不写。
  if (kind.startsWith('plugin:') && !kind.startsWith('plugin:dsh-fish') && !src.fish) return true

  // ③ 宿主 prompt() 进来的。
  if (kind !== 'user') return false
  return cls === 'group' || cls === 'group-owner'
    || (cls === 'human' && !src.clientTimeZone)
}

/**
 * 路径归一（只给「算不算同一个目录 / 在不在这个目录下」用）。
 * 反斜杠转正斜杠、去尾斜杠、小写；Windows 上大小写不敏感，Unix 上也按同一套算——
 * 宁可把 `C:\Fish` 与 `c:\fish` 当同一个，也不要因为盘符大小写让桥认不回来。
 */
export function normClaimDir(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** cwd 是否就在这个目录里（含它自己）。 */
export function underDir(cwd, dir) {
  const c = normClaimDir(cwd)
  const d = normClaimDir(dir)
  if (!c || !d) return false
  return c === d || c.startsWith(`${d}/`)
}

/** 会话一建出来就记下 agent：显式认领要能按 id 找到它。 */
export function rememberAgent(sessionId, agent) {
  const sid = String(sessionId ?? '').replace(/^session-/, '')
  if (!sid || !agent) return
  agents.set(sid, new WeakRef(agent))
}

/** 按会话 id 取活着的 agent；被回收了就顺手清掉。 */
export function agentFor(sessionId) {
  const sid = String(sessionId ?? '').replace(/^session-/, '')
  if (!sid) return null
  const ref = agents.get(sid)
  if (!ref) return null
  const agent = ref.deref()
  if (!agent) {
    agents.delete(sid)
    return null
  }
  return agent
}

/**
 * 登记「桥点名认领这条会话」时要跑的事。与 whenHers 不同：**不按目录筛**，
 * 只由 `/claim` 主动触发；自动来信那条路不会碰它。
 */
export function whenClaimed(sessionId, fn) {
  const sid = String(sessionId ?? '').replace(/^session-/, '')
  if (!sid || typeof fn !== 'function') return
  let set = claimers.get(sid)
  if (!set) claimers.set(sid, set = new Set())
  set.add(fn)
}

/**
 * 桥点名认领：把登记的装备跑一遍，跑完就清（同一条会话只认一次）。
 * 返回真的跑过几件事（0 = 这条没有可认领的装备，比如它本来就是她、或 agent 已经没了）。
 */
export function equipClaimed(sessionId) {
  const sid = String(sessionId ?? '').replace(/^session-/, '')
  if (!sid) return 0
  const set = claimers.get(sid)
  if (!set || !set.size) return 0
  claimers.delete(sid)
  let ran = 0
  for (const fn of set) {
    try {
      if (fn() !== false) ran += 1
    } catch { /* 一个装备挂了不能连累另一个 */ }
  }
  if (ran) claimedNow.add(sid)
  return ran
}

/** 这条会话这一趟是不是被显式认领过的（/release 与日志用）。 */
export function wasClaimed(sessionId) {
  return claimedNow.has(String(sessionId ?? '').replace(/^session-/, ''))
}

/** 撤回显式认领的标记（不再按她的身份对待）。 */
export function forgetClaimed(sessionId) {
  return claimedNow.delete(String(sessionId ?? '').replace(/^session-/, ''))
}

/** 测试用：清空登记。 */
export function resetClaimWaiters() {
  waiters.clear()
  claimers.clear()
  agents.clear()
  claimedNow.clear()
}

/** 测试用：看还有没有人在等（不暴露回调本身）。 */
export function pendingClaimCount() {
  let n = 0
  for (const set of waiters.values()) n += set.size
  return n
}
