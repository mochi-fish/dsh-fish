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
import { PERSON_NATURE_TEXT, PERSON_NOTE_MAX, normalizeNature, normalizePid } from './person.js'

/** 最多记这么多人；满了按最近出现挤掉旧的——被挤掉等于忘了，这是对的。 */
export const PEOPLE_MAX = 24
/** 身份段里最多摆几个（主人不占名额）。用户 m00729 从 8 降到 3。 */
export const PEOPLE_IN_PROMPT = 3
/** 身份段这一整段最多多少字（含标题）。S0 只有主人时是 350，S3 起 380。 */
export const PEOPLE_SECTION_MAX = 440
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
 * @param {{ now?: number, max?: number, ownerNames?: string[] }} [opts]
 * @returns {Array<{id:string,name:string,nameOnly:boolean,firstAt:number,lastAt:number,
 *   times:number,nightTimes:number,spanDays:number,judgmentIds:string[],judged:number,
 *   judgments:Array<{id:string,at:number,text:string,guess:boolean,verdict:string|null}>,
 *   changed:Array<{at:number,text:string,verdict:string|null,guess:boolean}>,
 *   said:Array<{at:number,text:string}>,
 *   didTo:Array<{at:number,text:string}>}>}
 */
export function peopleOf(events = [], { max = PEOPLE_MAX, ownerNames = [] } = {}) {
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
        changed: [],
        said: [],
        didTo: [],
        // 1.1.4（issue #183）：显式登记的人带这三样；从 `who` 长出来的人留空。
        nature: '',
        note: '',
        registered: false,
        addedAt: 0,
      }
      people.set(id, p)
    }
    return p
  }

  // 第 0 遍：显式登记的人（1.1.4，issue #183）。
  //
  // 为什么要在「谁出现过」之前：一个从没说过话、只被他提起过的人，靠 `who`
  // 永远长不出来。登记是唯一不靠猜的来源——名字、nature、一句为什么，都在事件里。
  // 只认三种事件，其余类型一律跳过（老读者读不认识的事件也是这么跳的）。
  const aliasPairs = []
  const mergePairs = []
  for (const e of list) {
    if (e?.type !== 'person_add' && e?.type !== 'person_alias' && e?.type !== 'person_merge') continue
    const pid = normalizePid(e?.pid)
    if (!pid) continue
    if (e.type === 'person_add') {
      const p = person(pid)
      p.registered = true
      p.nature = normalizeNature(e.nature)
      const name = String(e.name ?? '').trim().slice(0, PERSON_NAME_MAX)
      if (name && !p.name) p.name = name
      p.note = String(e.text ?? '').trim().slice(0, PERSON_NOTE_MAX)
      const at = tsMs(e)
      if (at > 0 && !p.addedAt) p.addedAt = at
    } else if (e.type === 'person_alias') {
      const alias = String(e.text ?? '').trim().slice(0, PERSON_NAME_MAX)
      if (alias) aliasPairs.push({ pid, alias })
    } else {
      const into = normalizePid(e?.into)
      if (into && into !== pid) mergePairs.push({ from: pid, into })
    }
  }

  // 并人（`person_merge`）：她可以把「奶糕兽」和「那个做鱼的」认成同一个人。
  // 只重定向 id，不删事件——老事件里的 `who.id` 还是老 id，读的时候折一下即可。
  const redirect = new Map()
  for (const { from, into } of mergePairs) redirect.set(from, into)
  const fold = (id) => {
    let cur = String(id ?? '')
    for (let i = 0; i < 8 && redirect.has(cur); i += 1) {
      const next = redirect.get(cur)
      if (!next || next === cur) break
      cur = next
    }
    return cur
  }
  for (const [from, into] of redirect) {
    const a = people.get(from)
    const b = people.get(fold(into))
    if (!a || !b) continue
    if (!b.name && a.name) b.name = a.name
    if (!b.nature && a.nature) b.nature = a.nature
    if (!b.note && a.note) b.note = a.note
    if (a.addedAt && (!b.addedAt || a.addedAt < b.addedAt)) b.addedAt = a.addedAt
    if (a.registered) b.registered = true
  }
  // 折过以后 `from` 那一行不再单独出现（它的材料在第二遍里按 fold 后的 id 归到 into）。
  for (const [from, into] of redirect) {
    if (fold(from) !== from) people.delete(from)
  }

  // 第一遍：谁在事件里出现过（voice / heard / utterance 才带 who）
  for (const e of list) {
    const key = personKeyOf(e?.who)
    if (!key) continue
    const at = tsMs(e)
    if (!(at > 0)) continue
    const p = person(fold(key), key.startsWith(NAME_PREFIX))
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

  // 用名字反查：`topic` 只有命中**恰好一个**已知的人，那条判断才算「关于这个人的」。
  //
  // 1.1.4（issue #183）从 `Map(name → id)` 改成 `Map(name → 一组 id)`：同名不猜。
  // 以前后写的覆盖先写的，于是「大肥鱼」既是作品角色又是写它的人时，所有判断都会
  // 挂到最后那个身上，她翻到谁都觉得奇怪。现在命中多个就当没命中——那条判断留在
  // 「关于世界」里：漏挂一次看得见（还能用 about 补），挂错一次看不见。
  /** @type {Map<string, Set<string>>} */
  const byName = new Map()
  const addName = (name, id) => {
    const key = String(name ?? '').trim()
    if (!key || !id) return
    let set = byName.get(key)
    if (!set) {
      set = new Set()
      byName.set(key, set)
    }
    set.add(id)
  }
  /** 名字 → id；命中 0 个或多个都返回空串（调用方当「没认出来」处理）。 */
  const nameId = (name) => {
    const set = byName.get(String(name ?? '').trim())
    return set && set.size === 1 ? [...set][0] : ''
  }
  for (const p of people.values()) if (p.name) addName(p.name, p.id)
  // 登记时添的小名也走同一张表：`person_alias` 的别名绑在具体 id 上，不设全局别名表。
  for (const { pid, alias } of aliasPairs) {
    const target = fold(pid)
    addName(alias, target)
    const row = people.get(target)
    if (row && !row.name) row.name = alias
  }

  // 2026-11-24（用户 m05827 审计）：主人怎么称呼，也得能反查。
  //
  // 主人那一行的 `name` 永远是空串——书房补写的 `who` 是 `{ id: 'owner', name: '' }`，
  // 所以 `byName` 里从来没有主人。她照提示词写「对某人的一句准话，topic 填那个人的名字」，
  // 填的是她平时叫他的那个称呼，于是那条判断一条都挂不到主人头上：身份段里
  // 「你认识的{T}」永远只有「第一次说话」和一句原话，她写下的看法永远不出现。
  //
  // 这个称呼不是配置项，是事件流自己长出来的（`derive.js` 的 `model.name`：她自己
  // 说过的「你叫……」，或导入人设带来的）。谁都没规定必须叫「主人」——她叫他什么，
  // 那就是什么，所以这里由调用方把称呼传进来，代码不写死任何一个词。
  const aliases = (Array.isArray(ownerNames) ? ownerNames : [])
    .map((n) => String(n ?? '').trim().slice(0, PERSON_NAME_MAX))
    .filter(Boolean)
  // 称呼有了，就说明她心里有这个人——哪怕老账本里还没出现过一条带 `who` 的事件，
  // 也让这一行先立起来（`firstAt` 留 0，由 `ownerLines` 退回 `model.firstMetAt`）。
  // 不立这一行的话，第二遍里「topic 命中别名」的那条判断会因为找不到人而被丢掉。
  const ownerRow = aliases.length ? person(OWNER) : people.get(OWNER)
  for (const alias of aliases) {
    // 1.1.4：别名走同一张多值表。她管他和另一个人叫同一个字时，两者都记进去，
    // 那条 `topic` 写成这个字就认不出来——这正是「不猜」要的：宁可漏挂。
    addName(alias, OWNER)
    // 反过来也让主人这一行带上这个称呼：人物文档的标题、「以前不是这么说的」都要用它。
    if (ownerRow && !ownerRow.name) ownerRow.name = alias
  }

  // 第二遍：她自己写下的判断挂到人身上
  // 每条判断挂给了谁，按事件 id 记下来：改口句要靠它找回归属（见下）。
  const ownerOf = new Map()
  for (const e of list) {
    if (e?.type !== 'utterance' && e?.type !== 'revise') continue
    // uncommitted 只是凭据（群里她说过的话），不是她认领的判断——不进这一层。
    const flags = Array.isArray(e.flags) ? e.flags : []
    if (flags.includes('uncommitted')) continue
    const text = String(e?.text ?? '').trim()
    if (!text) continue
    const at = tsMs(e)
    // 挂人的优先级（1.1.4，issue #183）：她自己点名的 `about` 最高，其次 `who`，
    // 再其次 `topic` 命中一个认识的人，最后才靠 refs 指的旧句回推。
    // `about` 排在第一个，是因为它不受名字影响：同名的人她也能说清是哪一个。
    let id = ''
    const about = fold(normalizePid(e?.about))
    if (about && people.has(about)) id = about
    if (!id) {
      const whoKey = personKeyOf(e?.who)
      if (whoKey) id = fold(whoKey)
    }
    if (!id) {
      const topic = String(e?.topic ?? '').trim()
      // 命中恰好一个人时才挂（`nameId` 在同名时返回空串，见上面）。
      if (topic) id = nameId(topic)
    }
    if (!id) {
      for (const rid of Array.isArray(e.refs) ? e.refs : []) {
        const key = fold(personKeyOf(byId.get(String(rid))?.who))
        if (key && people.has(key)) {
          id = key
          break
        }
      }
    }
    // 2026-11-24（审计 + 用户 m05827「这个也修改」）：改口句挂不上人。
    //
    // 她改口的时候写的是 `type=revise`、`verdict=refined/refuted`、`refs` 指回旧那句，
    // 而 revise 本身不带 `who`、也不带 `topic`——上面三条判据一条都命不中，新说法就
    // 挂不到任何人身上。后果比丢一句更重：旧句已经被撤下（进 changed），新句又没人收，
    // 那个人在身份段里整段消失。
    // 这里顺着 `refs` 找回旧判断挂给了谁——旧判断是她自己写的，归属在前一轮已经算出来了。
    if (!id) {
      for (const rid of Array.isArray(e.refs) ? e.refs : []) {
        const key = ownerOf.get(String(rid))
        if (key && people.has(key)) {
          id = key
          break
        }
      }
    }
    if (id === OWNER && !people.has(id)) person(OWNER)
    if (!id || !people.has(id)) continue
    ownerOf.set(String(e.id ?? ''), id)
    people.get(id).judgments.push({
      id: String(e.id ?? ''),
      at,
      text,
      guess: isGuess(text),
      verdict: /** @type {string|null} */ (e.verdict ?? null),
      changedFrom: '',
    })
  }

  // 第二遍之后：被 revise 改掉的旧判断，从「现在的看法」里撤下来。
  // 2026-11-24（用户 m05215）：对人的认知要跟判断、立场一样能改口——她写一条
  // revise、verdict=refined 或 refuted、refs 指着旧那句，旧的就退场，
  // 而不是和新的一句并排摆着，让她看起来同时信两种说法。
  // 旧的那句不删：进 changed，人物文档里写作「以前不是这么说的」。
  const replaced = new Map()
  for (const e of list) {
    if (e?.type !== 'revise') continue
    const verdict = String(e?.verdict ?? '')
    if (verdict !== 'refined' && verdict !== 'refuted') continue
    const at = tsMs(e)
    for (const rid of Array.isArray(e.refs) ? e.refs : []) {
      const key = String(rid ?? '')
      if (key) replaced.set(key, { at, verdict })
    }
  }
  if (replaced.size) {
    for (const p of people.values()) {
      const kept = []
      for (const j of p.judgments) {
        const hit = replaced.get(j.id)
        if (!hit) {
          kept.push(j)
          continue
        }
        p.changed.push({ at: hit.at, text: j.text, verdict: hit.verdict, guess: j.guess })
      }
      p.judgments = kept
      // 把「从哪句改过来」挂到改写者身上：文档里要能看出她改了哪一句。
      for (const j of p.judgments) {
        if (j.verdict !== 'refined' && j.verdict !== 'refuted') continue
        const from = p.changed.filter((c) => c.at <= j.at).sort((x, y) => y.at - x.at)[0]
        if (from) j.changedFrom = from.text
      }
    }
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

  // 同名的人有几个（1.1.4，issue #183）：两个以上时，光写名字分不清是谁，
  // 身份段与 her_people 都要把这件事说出来，而不是替她挑一个。
  const nameCount = new Map()
  for (const p of people.values()) {
    if (!p.name) continue
    nameCount.set(p.name, (nameCount.get(p.name) || 0) + 1)
  }

  const out = [...people.values()].map((p) => ({
    id: p.id,
    name: p.name,
    nameOnly: Boolean(p.nameOnly),
    // 1.1.4（issue #183）：显式登记的人带 nature / note / addedAt；从 who 长出来的人 nature 为空。
    nature: p.nature || '',
    note: p.note || '',
    registered: Boolean(p.registered),
    ambiguous: Boolean(p.name) && (nameCount.get(p.name) || 0) > 1,
    addedAt: p.addedAt || 0,
    firstAt: p.firstAt,
    lastAt: p.lastAt,
    times: p.times,
    nightTimes: p.nightTimes,
    spanDays: p.firstAt > 0 && p.lastAt > p.firstAt ? (p.lastAt - p.firstAt) / DAY_MS : 0,
    // 全量 id，不受每人 3 条的展示上限截断：`persona.js` 用它把「已经挂在人身上的
    // 判断」从「你自己说过的话」里剔掉——改口句不带 `topic`，只能靠 id 认。
    judgmentIds: p.judgments.map((j) => j.id),
    // 判断的**全量条数**（不受每人 3 条截断）。体检要报「你写过几条关于{T}的判断」，
    // 而她的判断多数不带 `who`（靠 `topic` 挂到人身上），体检从前按事件数，永远是 0。
    judged: p.judgments.length,
    judgments: p.judgments.sort((a, b) => b.at - a.at).slice(0, PERSON_JUDGE_MAX),
    changed: p.changed.sort((a, b) => b.at - a.at).slice(0, PERSON_JUDGE_MAX),
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
  // 两个来源都认：事件里带 `who` 算出来的毫秒数，和 `model.firstMetAt` 那种 ISO 串。
  const atMs = (v) => {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
    const parsed = Date.parse(String(v ?? ''))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  // 主人这一行用**起点**那一天（2026-11-27，issue #181；2026-11-28 按 #181/#182 的
  // 跟进改成「只认 seed」）。`p.firstAt` 只认带 `who` 的事件，而 `who` 是 1.0.9 才
  // 开始写的：老账本一条都没有，它就是空；1.1.3 之后又是「最早记下他一句话」的那天，
  // 一定晚于认识他的那天。两条路都跟下面「到今天第 N 天」的天数（按 seed 算）对不上。
  // 导入事件、时钟错位还会让它比 seed 更早——所以日期与天数只从同一个来源取。
  const born = atMs(p?.firstAt)
  const met = atMs(model?.firstMetAt)
  const since = met > 0 ? met : born
  // `||` 不是 `??`：list 兜底造出来的主人行 `firstAt` 是 0，`??` 会让它去格式化
  // 1970-01-01（真机上显示成「1 月 1 日」），要让它退回到 model.firstMetAt。
  const md = monthDay(since || p?.firstAt || model?.firstMetAt)
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
  // 1.1.4（issue #183）：她自己记下来的人（`her_person add`）哪怕还没写过判断，
  // 也摆一行——那句「这是谁」本身就是内容，不摆的话她记了也等于没记。
  if (!last) {
    if (!p.registered) return ''
    const nature = PERSON_NATURE_TEXT[p.nature] || ''
    const note = clip(p.note, 40)
    const tail = [nature, note].filter(Boolean).join('，')
    return `- ${whoLabel(p)}${tail ? `：${tail}` : ''}`
  }
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

  // 1.1.4（issue #183）：按 nature 分栏。
  //
  // 为什么分：以前所有人挤在「你认识的人」里，于是「阿甘」（电影角色）和「小周」
  // （他朋友）看起来是同一种关系——她可以喜欢阿甘，但那是「看过」，不是「认识」。
  // 只分三栏，不再多：栏越多，每栏能分到的字数越少，她反而记不住谁是谁。
  //   - `self` 是她自己，不是「你认识的人」；
  //   - `anonymous`（评论里那位）只留在 her_people 里，不占身份段的位子——
  //     它数量可以很多，摆进来会把真人的位置挤掉。
  const eligible = rest.filter((p) => p.nature !== 'self' && p.nature !== 'anonymous')
  /** 这一栏：说过话的人（他在场，或群友跟她对过话）。 */
  const here = eligible.filter((p) => p.times > 0)
  /** 这一栏：他提起过、或她读到过，但没跟她说过话。 */
  const heardOf = eligible.filter((p) => !(p.times > 0) && p.nature !== 'fictional' && p.nature !== 'author')
  /** 这一栏：作品里的人（角色、作者）——「看过」不是「认识」。 */
  const works = eligible.filter((p) => !(p.times > 0) && (p.nature === 'fictional' || p.nature === 'author'))

  // 标题跟着她怎么称呼{T}走（2026-11-24，用户 m05827）：她叫他「猫」，这一段就是
  // 「你认识的猫」；插件不替她定一个「主人」。还没有称呼时仍留 `{T}`，由 `fillOwner`
  // 填成 他 / 她 / TA——和以前一模一样。
  const call = String(model?.name ?? '').trim().slice(0, PERSON_NAME_MAX)
  const head = `## 你认识的${call || '{T}'}`
  const lines = []
  let used = head.length
  // 预算按**换完称呼之后**的长度算（2026-11-24 审计）：`{T}` 是 3 个字，她管他叫
  // 两个字还是十个字，同一个 `PEOPLE_SECTION_MAX` 就得是一致的上限。从前先量
  // `{T}` 版再整体替换，称呼一长这段就悄悄超了——而它现在是核心段，超出来的
  // 那部分会从别处的预算里扣。
  const fix = (s) => (call ? String(s).split('{T}').join(call) : String(s))
  const take = (line) => {
    if (!line) return false
    const text = fix(line)
    if (used + text.length + 1 > maxChars) return false
    lines.push(text)
    used += text.length + 1
    return true
  }

  for (const line of ownerLines(owner, model)) take(line)

  // 三个小栏：在场的人并进「你认识的」那一段（他们确实认识），另外两栏只在有人时才立标题。
  let shown = 0
  const put = (p) => {
    if (shown >= PEOPLE_IN_PROMPT) return false
    const line = otherLine(p)
    // 1.1.0 审计（2026-11-24）：没写过判断的人不摆（空条目不进身份段），
    // 但「不摆」不等于「到此为止」——最近见过的总是还没写过判断的那个陌生人，
    // 从前这里一 break，后面真写过判断的人就一个都摆不出来了。
    if (!line) return false
    if (!take(line)) return false
    shown += 1
    return true
  }
  // 2026-11-28（issue #183）：空条目要「跳过」，不是「到此为止」——最近见过的
  // 往往还没写过判断，从前这里一 break，后面真写过判断的人一个都摆不出来。
  for (const p of here) {
    if (shown >= PEOPLE_IN_PROMPT) break
    if (!otherLine(p)) continue
    if (!put(p)) break
  }

  // 预算记在 `used` 上，`take` 是闭包；撤回一行时按行重算最省事，也不用改 `take`。
  const recount = () => {
    used = head.length
    for (const l of lines) used += l.length + 1
  }
  const putGroup = (title, list) => {
    if (!list.length) return
    const before = lines.length
    // 标题也要过预算：否则「标题占了一行、底下一条都放不下」的空白栏会进提示词。
    if (!take(title)) return
    for (const p of list) {
      if (shown >= PEOPLE_IN_PROMPT) break
      // 同 `here` 那条：没内容的跳过，不打断后面的人。
      if (!otherLine(p)) continue
      if (!put(p)) break
    }
    // 只立了标题、一条都没进来：撤掉标题，别让空白栏白占预算。
    if (lines.length === before + 1) {
      lines.length = before
      recount()
    }
  }
  putGroup(`## 听${call || '{T}'}提起过的人`, heardOf)
  putGroup('## 你读过的作品里的人', works)

  if (!lines.length) return ''
  // 三句不能省的话之一：不写这句，她不知道自己有 `her_people`，工具等于不存在。
  // 但只有主人一个时不写——那时候没有「谁」可翻，写了反而像在催她。
  if (rest.some((p) => p.judgments.length > 0)) take('- 想细看谁，可以自己翻。')

  // 每一行进来时就已经换过称呼了（见上面 `fix`），所以这里不再整体替换——从前
  // 那样做会把「还有 N 条」之类的行也换掉，而且账面上算的是替换前的长度。
  return [head, ...lines].join('\n')
}

/** 一个人完整的一页（给 `home/她认识的人.md` 与 `her_people` 共用）。 */
export function renderPerson(p, { pronoun = '{T}' } = {}) {
  // 主人那一页的标题也跟她怎么称呼走（2026-11-24 审计）：`peopleOf` 现在会把称呼
  // 记到主人这一行上，那就别再用代词——身份段写「你认识的猫」、翻出来写「## 他」，
  // 她会以为这是两个人。没有称呼时才退回代词。
  const name = p.id === OWNER ? p.name || pronoun : p.name || '（没留下名字）'
  const lines = [`## ${name}`]
  const a = monthDay(p.firstAt)
  const b = monthDay(p.lastAt)
  if (a) lines.push(`- 第一次见到：${a}`)
  if (b && b !== a) lines.push(`- 最近一次：${b}`)
  if (p.judgments.length) {
    lines.push('- 你写下的：')
    for (const j of p.judgments) {
      const tag = j.guess ? '（猜的）' : ''
      // 改过口的要留痕（2026-11-24，用户 m05215）：旧的那句已经退场，这一句要标明是改来的，
      // 别让她以为这句话从一开始就是这样。
      const mark = j.verdict === 'refined'
        ? '（改的口）'
        : j.verdict === 'refuted'
          ? '（推翻了以前那句）'
          : ''
      lines.push(`  - ${monthDay(j.at)}${tag}「${clip(j.text, 200)}」${mark}`)
    }
    lines.push('- 想改口就用 growth_commit，type=revise，verdict=refined 或 refuted，refs 填那条的 id。')
  }
  // 被改掉的旧句不删，单独一节：她翻到这个人的时候能看见自己以前是怎么想的。
  if (Array.isArray(p.changed) && p.changed.length) {
    lines.push('- 以前不是这么说的：')
    for (const c of p.changed) {
      const when = c.verdict === 'refuted' ? '这天推翻了' : '这天改了口'
      lines.push(`  - ${monthDay(c.at)}${c.guess ? '（猜的）' : ''}「${clip(c.text, 200)}」（${when}）`)
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
