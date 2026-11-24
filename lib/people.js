/**
 * people.js —— 她认识的人（1.1.0 S3-a）
 *
 * 只读事件流、不写盘、不缓存、任何一路读失败就跳过——同 `lib/derive.js` / `lib/loops.js`。
 *
 * 一个人有六样，**一个数字都不给**，判断排在最前面：
 *   - 名字 + id
 *   - 她认领过的判断（最多 `PERSON_JUDGE_MAX` 条，最近的在前）← 主材料
 *   - 第一次见到、最近一次
 *   - 最多 `PERSON_SAID_MAX` 条原话（**没有判断时才顶上来**）
 *   - 她对他做过什么（从 refusal 读，靠 refs 指到那个人的事件）
 *
 * 判断怎么挂到人身上（这是本文件最要紧的一段）：她写下的 utterance 里没有
 * 「这是关于某某的」字段，也不该有（`lib/schema.js` 堵死了她自己打标）。
 * 所以只看她自己做的两件事，任一命中即可：
 *   1. `topic` 写了人名——而且必须是**已经出现过的** `who.name`；不命中就当
 *      「关于某件事的判断」，照旧走 beliefs（所以 `topic` 语义不变）。
 *   2. `refs` 指向了那个人的事件（`who.id` 对得上）。
 * 两样都没写的，**不挂人**——她自己没说是关于谁的，宿主不能替她认。
 *
 * 已知边界：`topic` 是 12 字自由文本，同一个人她可能写成「老王」「王哥」两种，
 * 这里会当成两个人。别名表本期不做（设计稿 §10）。
 *
 * 人的键（1.1.0 补）：有 `who.id` 就用 id；只有名字的（`/say` 那一路桥只给 `speaker`）
 * 用 `name:<名字>` 建人，标 `nameOnly`。为什么不跳过没有 id 的——跳过等于
 * 「接桥的人打开 `her_people` 一个外人都看不见」，那比合并更糟。代价是同名并成一个、
 * 改名拆成两个，所以摆出来时如实写一句「这个名字对上的可能不止一个人」。
 *
 * 「只数不写」（1.1.0 补，设计稿 S0.6 第 8 条）：这里只算「记下来过几次」「几次在夜里」，
 * 摆到人物文档与 `her_people`，**不进身份段**——那是每轮都读的位置，摆数字就成仪表盘了。
 */

import { tsMs } from './schema.js'
import { isGuess } from './guess.js'

/** 最多记这么多人；满了按最近出现挤掉旧的——被挤掉等于忘了，这是对的。 */
export const PEOPLE_MAX = 24
/** 身份段里最多摆几个（主人不占名额）。用户 m00729 从 8 降到 3。 */
export const PEOPLE_IN_PROMPT = 3
/** 身份段这一整段最多多少字（含标题）。S0 只有主人时是 350，S3 起 380。 */
export const PEOPLE_SECTION_MAX = 380
/** 每人最多摆几条她自己写下的判断。 */
export const PERSON_JUDGE_MAX = 3
/** 每人最多留几条别人说的原话（证据，不是判断）。 */
export const PERSON_SAID_MAX = 3
/** 她对他做过什么，每人最多摆几件。 */
export const PERSON_DID_MAX = 3
/** 名字最长多少个字（与 `lib/schema.js` 的 `WHO_NAME_MAX` 一致）。 */
export const PERSON_NAME_MAX = 40
/** `her_people` 一次最多给她看这么多字（照 `DIARY_READ_MAX`）。 */
export const PEOPLE_READ_MAX = 3000

// ---- 「只数不写」（1.1.0 补，设计稿 S0.6 第 8 条）----
// 宿主只摆材料、不下结论：「你们之间记下来过 9 次」不等于「他出现过 9 次」——
// 群友的话默认一条不记，所以数到的永远是**她看得见的往来**，不是那个人的生活。
/** 少于此数不摆次数：两三次就写成「经常」，那是噪声不是材料。 */
export const PERSON_COUNT_MIN = 5
/** 少于此数不摆「在夜里」：样本不够时这一行只会变成错觉。 */
export const PERSON_NIGHT_MIN = 5
/** 跨度短于此天数不摆次数：一天里撞见五回，那是巧合不是习惯。 */
export const PERSON_SPAN_MIN_DAYS = 7

const OWNER = 'owner'

const DAY_MS = 86_400_000

/** 没有 id 的人用的键前缀：桥只报了名字的时候走这条。 */
const NAME_PREFIX = 'name:'

/** 只有名字的人 → 稳定的键。同名会并成一个人，这是这种兜底的已知代价。 */
function nameKey(name) {
  return `${NAME_PREFIX}${String(name ?? '').trim().slice(0, PERSON_NAME_MAX)}`
}

/**
 * 一条事件的 `who` 换算成人的键：有 id 用 id，只有名字用名字。
 *
 * 为什么不跳过没有 id 的：`/say` 那一路桥只给 `speaker`（名字），
 * 跳过等于「接桥的人打开 `her_people` 一个外人都看不见」——那比合并更糟。
 */
function personKeyOf(who) {
  const id = String(who?.id ?? '').trim()
  if (id) return id
  const name = String(who?.name ?? '').trim()
  return name ? nameKey(name) : ''
}

/** 本地小时：夜里 = 23 点到次日 5 点（含 23，不含 5）。 */
function isNight(at) {
  const h = new Date(at).getHours()
  return Number.isFinite(h) && (h >= 23 || h < 5)
}

/** `M 月 D 日`；时间不可解析就返回空串（宁可不写，也不编一个日期）。 */
function monthDay(at) {
  // 两种来源都要认：事件里算出来的毫秒数，以及 `model.firstMetAt` 那种原样的 ISO 串。
  const n = Number(at)
  const ms = Number.isFinite(n) && n > 0 ? n : Date.parse(String(at ?? ''))
  if (!(ms > 0)) return ''
  const t = new Date(ms)
  return Number.isFinite(t.getTime()) && t.getTime() > 0 ? `${t.getMonth() + 1} 月 ${t.getDate()} 日` : ''
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 从事件流算出「她认识哪些人」。
 *
 * @param {object[]} events 事件流（`readEvents(root).events`）
 * @param {{ now?: number, max?: number }} [opts]
 * @returns {Array<{id:string,name:string,firstAt:number,lastAt:number,
 *   judgments:Array<{id:string,at:number,text:string,guess:boolean,verdict:string|null}>,
 *   said:Array<{at:number,text:string}>,
 *   didTo:Array<{at:number,text:string}>}>}
 */
export function peopleOf(events = [], { max = PEOPLE_MAX } = {}) {
  const list = Array.isArray(events) ? events : []
  const byId = new Map()
  for (const e of list) {
    const id = String(e?.id ?? '')
    if (id) byId.set(id, e)
  }

  /** @type {Map<string, any>} */
  const people = new Map()
  const person = (id, nameOnly = false) => {
    let p = people.get(id)
    if (!p) {
      p = {
        id,
        name: '',
        nameOnly,
        firstAt: 0,
        lastAt: 0,
        times: 0,
        nightTimes: 0,
        judgments: [],
        said: [],
        didTo: [],
      }
      people.set(id, p)
    }
    return p
  }

  // 第一遍：谁在事件里出现过（voice / heard / utterance 才带 who）
  for (const e of list) {
    const key = personKeyOf(e?.who)
    if (!key) continue
    const at = tsMs(e)
    if (!(at > 0)) continue
    const p = person(key, key.startsWith(NAME_PREFIX))
    const name = String(e.who?.name ?? '').trim().slice(0, PERSON_NAME_MAX)
    if (!p.firstAt || at < p.firstAt) p.firstAt = at
    // 名字用「最近一次见他时写的那个」：昵称会改，改一次不该把一个人拆成两个人。
    if (at >= p.lastAt && name) p.name = name
    if (!p.name && name) p.name = name
    if (at > p.lastAt) p.lastAt = at
    p.times += 1
    if (isNight(at)) p.nightTimes += 1
    if ((e.type === 'voice' || e.type === 'heard') && String(e.text ?? '').trim()) {
      p.said.push({ at, text: String(e.text).trim() })
    }
  }

  // 用名字反查：`topic` 只有命中一个已知的人，那条判断才算「关于这个人的」
  const byName = new Map()
  for (const p of people.values()) if (p.name) byName.set(p.name, p.id)

  // 第二遍：她自己写下的判断挂到人身上
  for (const e of list) {
    if (e?.type !== 'utterance' && e?.type !== 'revise') continue
    // uncommitted 只是凭据（群里她说过的话），不是她认领的判断——不进这一层。
    const flags = Array.isArray(e.flags) ? e.flags : []
    if (flags.includes('uncommitted')) continue
    const text = String(e?.text ?? '').trim()
    if (!text) continue
    const at = tsMs(e)
    let id = personKeyOf(e?.who)
    if (!id) {
      const topic = String(e?.topic ?? '').trim()
      if (topic && byName.has(topic)) id = byName.get(topic)
    }
    if (!id) {
      for (const rid of Array.isArray(e.refs) ? e.refs : []) {
        const key = personKeyOf(byId.get(String(rid))?.who)
        if (key && people.has(key)) {
          id = key
          break
        }
      }
    }
    if (!id || !people.has(id)) continue
    people.get(id).judgments.push({
      id: String(e.id ?? ''),
      at,
      text,
      guess: isGuess(text),
      verdict: /** @type {string|null} */ (e.verdict ?? null),
    })
  }

  // 第三遍：她对他做过什么（拒绝过什么），靠 refs 指到那个人的事件
  for (const e of list) {
    if (e?.type !== 'refusal') continue
    const text = String(e?.text ?? '').trim()
    if (!text) continue
    const at = tsMs(e)
    for (const rid of Array.isArray(e.refs) ? e.refs : []) {
      const key = personKeyOf(byId.get(String(rid))?.who)
      if (key && people.has(key)) {
        people.get(key).didTo.push({ at, text })
        break
      }
    }
  }

  const out = [...people.values()].map((p) => ({
    id: p.id,
    name: p.name,
    nameOnly: Boolean(p.nameOnly),
    firstAt: p.firstAt,
    lastAt: p.lastAt,
    times: p.times,
    nightTimes: p.nightTimes,
    spanDays: p.firstAt > 0 && p.lastAt > p.firstAt ? (p.lastAt - p.firstAt) / DAY_MS : 0,
    judgments: p.judgments.sort((a, b) => b.at - a.at).slice(0, PERSON_JUDGE_MAX),
    said: p.said.sort((a, b) => b.at - a.at).slice(0, PERSON_SAID_MAX),
    didTo: p.didTo.sort((a, b) => b.at - a.at).slice(0, PERSON_DID_MAX),
  }))

  // 主人永远第一行（他是唯一默认开的那一个）；其余按最近出现排。
  out.sort((a, b) => {
    if (a.id === OWNER) return -1
    if (b.id === OWNER) return 1
    return b.lastAt - a.lastAt
  })
  const cap = Math.max(1, Math.trunc(Number(max) || PEOPLE_MAX))
  return out.slice(0, cap)
}

/** 这个人在文本里怎么称呼：主人是 {T}，别人用她给的名字。 */
function whoLabel(p) {
  return p.id === OWNER ? '{T}' : `「${p.name || '一个没留下名字的人'}」`
}

/**
 * 主人那几行：只摆已经有的事实。
 *
 * 为什么带 model 兜底：`model.people` 只认带 `who` 的事件，而 `who` 是 1.0.9 才开始写的。
 * 老账本里一条都没有的时候，S0 那段（第一次说话 / 记着{T}说过的一句）本来还能摆，
 * 不能因为升级反而少一段——所以人不在名单里也照样出这几行。
 */
function ownerLines(p, model) {
  const out = []
  const md = monthDay(p?.firstAt ?? model?.firstMetAt)
  if (md) {
    const day = Number(model?.day ?? 0)
    out.push(day >= 1 ? `- 第一次说话：${md}，到今天第 ${day} 天` : `- 第一次说话：${md}`)
  }
  const quoted = p?.said?.[0]?.text ?? model?.recentHeard?.[0]?.text
  if (quoted) out.push(`- 你记着{T}说过的一句：「${clip(quoted, 40)}」`)
  const last = p?.judgments?.[0]
  if (last) {
    out.push(`- ${last.guess ? '你猜过' : '你对{T}有过一句准话'}：「${clip(last.text, 40)}」`)
  }
  return out
}

/** 别人那一行：判断优先；一条判断都没有的，不摆（空条目不进身份段）。 */
function otherLine(p) {
  const last = p.judgments[0]
  if (!last) return ''
  const bits = []
  const a = monthDay(p.firstAt)
  const b = monthDay(p.lastAt)
  if (a) bits.push(`${a}第一次见到`)
  if (b && b !== a) bits.push(`最近一次${b}`)
  bits.push(`${last.guess ? '你猜过' : '你写过一句'}：「${clip(last.text, 40)}」`)
  return `- ${whoLabel(p)}：${bits.join('，')}`
}

/**
 * 身份段里那一段（部分读）。
 *
 * 不是新加一段，是把 S0 那段长大：同一个位置、同一个标题，喂进去的人变多。
 * 两段并排会各占一份预算，而 `SELF_DOC_BUDGET` 的真实余量只有 604 字。
 *
 * @param {object} model `deriveSelf()` 的返回（读 `model.people` / `model.day`）
 * @param {{ maxChars?: number, others?: boolean }} [opts]
 *        `others` = `people.others.enabled`；关着的时候只摆主人一个（开关管展示也管落盘）
 * @returns {string} 空串表示这一段整段不出现
 */
export function peopleSection(model, { maxChars = PEOPLE_SECTION_MAX, others = false } = {}) {
  const all = Array.isArray(model?.people) ? model.people : []
  const visible = all.filter((p) => p.id === OWNER || others)
  // 老账本兜底：主人还没往任何事件上写过 `who` 的时候，人不在名单里，
  // 但 `firstMetAt` / `recentHeard` 早就有——S0 那几行不能因此消失。
  const owner = visible.find((p) => p.id === OWNER) ?? null
  const rest = visible.filter((p) => p.id !== OWNER)

  const head = '## 你认识的{T}'
  const lines = []
  let used = head.length
  const take = (line) => {
    if (!line) return false
    if (used + line.length + 1 > maxChars) return false
    lines.push(line)
    used += line.length + 1
    return true
  }

  for (const line of ownerLines(owner, model)) take(line)

  let shown = 0
  for (const p of rest) {
    if (shown >= PEOPLE_IN_PROMPT) break
    const line = otherLine(p)
    // 1.1.0 审计（2026-11-24）：没写过判断的人不摆（空条目不进身份段），
    // 但「不摆」不等于「到此为止」——最近见过的总是还没写过判断的那个陌生人，
    // 从前这里一 break，后面真写过判断的人就一个都摆不出来了。
    if (!line) continue
    if (!take(line)) break
    shown += 1
  }

  if (!lines.length) return ''
  // 三句不能省的话之一：不写这句，她不知道自己有 `her_people`，工具等于不存在。
  // 但只有主人一个时不写——那时候没有「谁」可翻，写了反而像在催她。
  if (rest.some((p) => p.judgments.length > 0)) take('- 想细看谁，可以自己翻。')

  return [head, ...lines].join('\n')
}

/** 一个人完整的一页（给 `home/她认识的人.md` 与 `her_people` 共用）。 */
export function renderPerson(p, { pronoun = '{T}' } = {}) {
  const name = p.id === OWNER ? pronoun : p.name || '（没留下名字）'
  const lines = [`## ${name}`]
  const a = monthDay(p.firstAt)
  const b = monthDay(p.lastAt)
  if (a) lines.push(`- 第一次见到：${a}`)
  if (b && b !== a) lines.push(`- 最近一次：${b}`)
  if (p.judgments.length) {
    lines.push('- 你写下的：')
    for (const j of p.judgments) {
      const tag = j.guess ? '（猜的）' : ''
      lines.push(`  - ${monthDay(j.at)}${tag}「${clip(j.text, 200)}」`)
    }
  }
  if (p.didTo.length) {
    lines.push('- 你拒绝过的：')
    for (const d of p.didTo) lines.push(`  - ${monthDay(d.at)}「${clip(d.text, 200)}」`)
  }
  // 原话只在没有判断时顶上来（用户 m00818：原话替代不了判断）。
  if (!p.judgments.length && p.said.length) {
    lines.push('- 这个人说过的：')
    for (const s of p.said) lines.push(`  - ${monthDay(s.at)}「${clip(s.text, 200)}」`)
  }
  // 「只数不写」（1.1.0）：摆材料，不下结论。三个门槛都是为了不让她拿两三次当习惯。
  // 说「记下来过」而不是「出现过」——群友的话默认一条不记，数到的是往来不是那个人。
  const times = Number(p.times ?? 0)
  const days = Number(p.spanDays ?? 0)
  if (times >= PERSON_COUNT_MIN && days >= PERSON_SPAN_MIN_DAYS) {
    lines.push(`- 你们之间记下来过 ${times} 次，跨了 ${Math.round(days)} 天`)
    const night = Number(p.nightTimes ?? 0)
    if (night >= PERSON_NIGHT_MIN) lines.push(`- 其中 ${night} 次在夜里（晚上十一点到早上五点）`)
  }
  // 只有名字的人：同名会并成一个，得如实说，不能让她以为那就是一个人。
  if (p.nameOnly) lines.push('- 这个名字对上的可能不止一个人。')
  return lines.join('\n')
}

/**
 * 名字匹配：`name` 可以是全名，也可以是名字里的几个字。
 * 只在这份名单里找，不接受路径、不接受正则。
 */
export function findPerson(people = [], want = '') {
  const needle = String(want ?? '').replace(/\s+/g, '').trim()
  if (!needle) return []
  const list = Array.isArray(people) ? people : []
  const exact = list.filter((p) => String(p.name ?? '') === needle)
  if (exact.length) return exact
  return list.filter((p) => {
    const n = String(p.name ?? '')
    return n && (n.includes(needle) || needle.includes(n))
  })
}
