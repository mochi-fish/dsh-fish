/**
 * peopledoc.js —— `home/她认识的人.md`（1.1.0 S3-b）
 *
 * **这份文件不是真相源。** 真源只有一个：事件流（`events.jsonl`）。
 * 它和 `home/她的身份.md` 是同一种东西——写完事件、由 `deriveSelf()` 重新算出来、
 * 整份覆盖的派生副本。改它不会生效，下一次重算就被覆盖。
 *
 * 为什么要这份文件：身份文档里那一节只摆三个人、每人一行（整段预算 380 字），
 * 想看清「她到底怎么看这个人」得有一份完整的。真相在事件流里，但人读不了 jsonl。
 *
 * 四条硬规矩（照 `lib/selfdoc.js` 的先例）：
 *   1. 副本不是真相源，每次重算覆盖。
 *   2. `people.others.enabled === false` 时文档里只有{T}一个人——开关关着，她的世界里就一个人。
 *   3. 内容没变不写盘（幂等）：否则每次写事件都要动一次文件，备份与文件监听都被吵醒。
 *   4. 写不出来不能影响主流程：坏一份给人看的抄本，不该让她少一段提示。
 */

import fs from 'node:fs/promises'
import { join } from 'node:path'
import { paths, readEvents, rootDir, writeAtomic } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'
import { renderPerson } from './people.js'
import { pronounOf } from './pronoun.js'

/** 这份抄本的落盘位置。名字刻意不叫 `AGENTS.md`——宿主会读那个名字并注入对话。 */
export function peopleDocPath(root = rootDir()) {
  return join(paths(root).root, 'home', '她认识的人.md')
}

/**
 * 文档正文。
 *
 * @param {object} model `deriveSelf()` 的返回，或 `{ people }` 这样的小对象
 * @param {{ pronoun?: string, others?: boolean }} [opts]
 *        `others` 对应 `people.others.enabled`；关着时只写{T}一个人。
 * @returns {string}
 */
export function renderPeopleDoc(model, { pronoun = '他', others = false } = {}) {
  const all = Array.isArray(model?.people) ? model.people : []
  const people = others ? all : all.filter((p) => p.id === 'owner')
  const head = [
    '# 她认识的人',
    '',
    '这份是从事件流重算出来的抄本，不是你改它就生效的东西——改了会被下一次重算覆盖。',
    '她写完一条判断，这里就会跟着变。想看她自己怎么说，问她，或者让她翻。',
    '',
  ]
  if (!people.length) {
    head.push('（还没有。她还没往谁名下写过什么。）')
    return `${head.join('\n')}\n`
  }
  const body = []
  for (const p of people) {
    body.push(renderPerson(p, { pronoun }))
    body.push('')
  }
  return `${head.join('\n')}\n${body.join('\n')}`
}

/**
 * 用**已经算好的** model 重算并落盘。幂等：内容一样就不动文件。
 *
 * 为什么要这个入口：`writeSelfDoc()` 每写一次事件就要派生一遍全量 model，
 * 那边已经有 model 了——再调 `writePeopleDoc()` 会白派生第二次。
 *
 * @returns {Promise<{ok:boolean, changed:boolean, file:string}>}
 */
export async function writePeopleDocFrom(root, model, config, { log } = {}) {
  const file = peopleDocPath(root)
  try {
    const others = config?.people?.others?.enabled === true
    // 抄本里的称呼用设置里的那一个（他 / 她 / TA），与身份文档同源。
    const text = renderPeopleDoc(model, { pronoun: pronounOf(config), others })
    let prev = null
    try {
      prev = await fs.readFile(file, 'utf8')
    } catch {
      /* 首次 */
    }
    const changed = prev !== text
    if (changed) await writeAtomic(file, text)
    return { ok: true, changed, file }
  } catch (err) {
    log?.('people doc failed', err?.message ?? err)
    return { ok: false, changed: false, file }
  }
}

/**
 * 自己读事件、自己派生，再落盘。给没有现成 model 的调用点用。
 *
 * @returns {Promise<{ok:boolean, changed:boolean, file:string}>}
 */
export async function writePeopleDoc(root = rootDir(), { log } = {}) {
  let model = { people: [] }
  let config = {}
  try {
    // 读不出来就当空：坏一份给人看的抄本，不该让她少一段提示（同 selfdoc 的容错口径）。
    const { events } = await readEvents(root).catch(() => ({ events: [] }))
    ;({ config } = await loadConfig(root).catch(() => ({ config: {} })))
    model = deriveSelf(Array.isArray(events) ? events : [], { growthDays: config?.growthDays })
  } catch {
    /* 用空 model 兜底 */
  }
  return writePeopleDocFrom(root, model, config, { log })
}

/** 同 `refreshSelfDoc`：调用点的名字统一叫 refresh，实现只有一个。 */
export async function refreshPeopleDoc(root = rootDir(), opts) {
  return writePeopleDoc(root, opts)
}
