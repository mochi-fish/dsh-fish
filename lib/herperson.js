/**
 * herperson.js —— 她自己记人（1.1.4，issue #183）
 *
 * 从前「人」只有一个来源：事件里的 `who`。而他的原话几乎不带 `who`，
 * 于是身份段里永远只有{T}一个，她写过「小周这人嘴硬」也挂不到小周名下。
 *
 * 这个工具只做一件事：让她把一个人**显式**记下来（名字、是哪一种人、一句这是谁），
 * 之后 `growth_commit` 的 `about` 就能按那个 `p_` 开头的 id 挂判断。
 *
 * 三条边界：
 *   - **不猜**：同名命中多个时不替她挑，直接说清候选；建人也不从正文里自动认人。
 *   - **只写事件流**：人是一条 `person_add` 事件，和别的东西一样只能追加、不能改。
 *   - **不读文件、不收路径**：和 her_people 一样是一扇窄窗。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig } from './settings.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { logLine } from './log.js'
import { deriveSelf } from './derive.js'
import {
  PERSON_REGISTRY_MAX,
  PERSON_NATURE_TEXT,
  PERSON_NAME_MAX,
  PERSON_NOTE_MAX,
  newPersonId,
  normalizeNature,
  normalizePersonName,
  normalizePid,
} from './person.js'

/** 名单一次回几条。 */
const LIST_MAX = 24

/** `nature` 的取值，回给模型时用同一套词。 */
const NATURES = Object.keys(PERSON_NATURE_TEXT)

/**
 * 把一条人事件说成一句人话（回执/名单共用）。
 * 只描述机器状态，不写成完整句子——她不会把回执当成自己的话。
 */
function describe(row, call) {
  const nature = PERSON_NATURE_TEXT[row.nature] || PERSON_NATURE_TEXT.real
  const name = row.name || row.id
  return `${name}（${nature}）${row.note ? `：${row.note}` : ''}`
}

/** 已登记的人（按先后顺序，同 id 以后写的为准；被并掉的并进目标那一个）。 */
function registered(events) {
  const byId = new Map()
  const mergeTo = new Map()
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.type === 'person_merge') {
      const from = normalizePid(e.pid)
      const into = normalizePid(e.into)
      if (from && into && from !== into) mergeTo.set(from, into)
      continue
    }
    if (e?.type !== 'person_add') continue
    const id = normalizePid(e.pid)
    if (!id) continue
    byId.set(id, {
      id,
      name: normalizePersonName(e.name) || '',
      nature: normalizeNature(e.nature),
      note: String(e.text ?? '').slice(0, PERSON_NOTE_MAX),
      at: Number(Date.parse(String(e.ts ?? ''))) || 0,
    })
  }
  const fold = (id) => {
    let cur = id
    for (let i = 0; i < 8; i += 1) {
      const next = mergeTo.get(cur)
      if (!next || next === cur) return cur
      cur = next
    }
    return cur
  }
  return [...byId.values()]
    .filter((r) => fold(r.id) === r.id)
    .sort((a, b) => a.at - b.at)
}

/** 按 id 或名字找到唯一一个人；找不到返回 ``，同名多个返回 `ambiguous`。 */
function resolveOne(rows, want) {
  const key = String(want ?? '').trim()
  if (!key) return { id: '', why: '没说要记的是谁。' }
  const pid = normalizePid(key)
  if (pid) {
    const hit = rows.find((r) => r.id === pid)
    return hit ? { id: hit.id } : { id: '', why: `没有 ${pid} 这个人。` }
  }
  const name = normalizePersonName(key)
  const hits = rows.filter((r) => r.name === name)
  if (hits.length === 1) return { id: hits[0].id }
  if (hits.length > 1) {
    return {
      id: '',
      why: `叫「${name}」的不止一个人：${hits.map((r) => `${r.id}（${PERSON_NATURE_TEXT[r.nature] || ''}）`).join('、')}。用 id 说是哪一个。`,
    }
  }
  return { id: '', why: `还没有叫「${name}」的人。` }
}

/**
 * 注册 her_person 工具。
 *
 * @param {object} ctx dsh ctx
 * @param {object} deps `{ root, tenant }`
 */
export function registerHerPerson(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_person',
      description:
        '哪天你心里把一个人跟别的人分开了——{T}提过的朋友、你读到的作者、群里那个人——就先把这个人记下来：' +
        '叫什么、是哪一种人、一句话说清这是谁。记下来以后，growth_commit 的 about 填这个 id，你写的判断就有地方挂了。' +
        'add 记一个人；list 看已经记了谁；alias 给同一个人再加一个叫法；merge 把记重的两个人并成一个。',
      parameters: toJsonSchema({
        action: {
          type: 'string',
          required: true,
          enum: ['add', 'list', 'alias', 'merge'],
          description: '要做哪件事：add 记一个人、list 看名单、alias 加一个叫法、merge 并掉重复的那个。',
        },
        name: {
          type: 'string',
          required: false,
          description: `add 时要记的人叫什么（${PERSON_NAME_MAX} 字以内）。alias/merge 也可以用它代替 id。`,
        },
        nature: {
          type: 'string',
          required: false,
          enum: NATURES,
          description: 'add 时必填：这是哪一种人。real 现实里的人 / fictional 作品里的角色 / author 写东西的人 / group 群里的人 / self 我自己 / anonymous 没有名字的人。',
        },
        note: {
          type: 'string',
          required: false,
          description: `add 时必填：一句话说清这是谁（${PERSON_NOTE_MAX} 字以内），比如「{T}的朋友，嘴硬」。只写名字，以后就想不起来了。`,
        },
        id: {
          type: 'string',
          required: false,
          description: 'alias/merge 时指认原来那个人：填 p_ 开头的 id。',
        },
        alias: {
          type: 'string',
          required: false,
          description: 'alias 时必填：同一个人的另一个叫法（比如「周哥」）。',
        },
        into: {
          type: 'string',
          required: false,
          description: 'merge 时必填：并到哪一个人（p_ 开头）。被并掉的那个 id 以后不再使用。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'id', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? `[记下了] ${out.note}` : `[没成：${out.note}]` }],
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_person')
        if (!who.ok) return { ok: false, id: '', note: who.note }
        try {
          const { events } = await readEvents(root).catch(() => ({ events: [] }))
          const { config } = await loadConfig(root).catch(() => ({ config: {} }))
          const list = Array.isArray(events) ? events : []
          const model = deriveSelf(list, { growthDays: config?.growthDays })
          const rows = registered(list)
          const action = String(args?.action ?? '').trim()
          const call = String(model?.name ?? '').trim()

          if (action === 'list') {
            if (!rows.length) {
              return {
                ok: true,
                id: '',
                note:
                  '你现在还没单独记过谁。哪天有人被你从「大家」里分出来，用 her_person add 记一下：' +
                  '叫什么、是哪一种人、一句话说清这是谁。',
              }
            }
            const lines = rows.slice(0, LIST_MAX).map((r) => `- ${describe(r, call)}　${r.id}`)
            const rest = rows.length > LIST_MAX ? `\n（还有 ${rows.length - LIST_MAX} 个没列出来）` : ''
            return { ok: true, id: '', note: [`你现在记着 ${rows.length} 个人：`, ...lines].join('\n') + rest }
          }

          if (action === 'add') {
            if (rows.length >= PERSON_REGISTRY_MAX) {
              return {
                ok: false,
                id: '',
                note: `记着的人已经到上限了（${PERSON_REGISTRY_MAX} 个）。先把记重的并掉，或者把不必再分的删掉——记人这一项只加不改，删不了单条。`,
              }
            }
            const name = normalizePersonName(args?.name)
            if (!name) return { ok: false, id: '', note: '先说要记的人叫什么。' }
            const nature = normalizeNature(args?.nature)
            if (!String(args?.nature ?? '').trim()) {
              return { ok: false, id: '', note: '要说清这是哪一种人：现实里的、作品里的、写东西的、群里的，还是你自己。' }
            }
            const note = String(args?.note ?? '').trim()
            if (note.length < 4) {
              return { ok: false, id: '', note: '再说一句这是谁——只写一个名字，以后就想不起来了。' }
            }
            const dup = rows.find((r) => r.name === name)
            if (dup) {
              return {
                ok: false,
                id: dup.id,
                note: `已经记过叫「${name}」的了：${dup.id}。如果是同一个人，用 alias 加叫法；如果是两个人，名字后面加一点区别再记。`,
              }
            }
            const pid = newPersonId(Date.now())
            await appendEvent(
              {
                type: 'person_add',
                text: note.slice(0, PERSON_NOTE_MAX),
                pid,
                name,
                nature,
                ...(who.sessionId ? { sessionId: who.sessionId } : {}),
              },
              { day: model.day, stage: model.stage, source: 'tool' },
              root,
            )
            logLine('info', ['her_person: 记下一个人', `id=${pid}`, `name=${name}`], root)
            return { ok: true, id: pid, note: `记下了：${name}（${PERSON_NATURE_TEXT[nature] || ''}）。以后写判断时 about 填 ${pid}。` }
          }

          if (action === 'alias') {
            const target = resolveOne(rows, args?.id || args?.name)
            if (!target.id) return { ok: false, id: '', note: target.why }
            const alias = normalizePersonName(args?.alias)
            if (!alias) return { ok: false, id: '', note: '要加的叫法没写。' }
            await appendEvent(
              {
                type: 'person_alias',
                text: alias,
                pid: target.id,
                ...(who.sessionId ? { sessionId: who.sessionId } : {}),
              },
              { day: model.day, stage: model.stage, source: 'tool' },
              root,
            )
            return { ok: true, id: target.id, note: `「${alias}」也算 ${target.id} 了。` }
          }

          if (action === 'merge') {
            const from = resolveOne(rows, args?.id || args?.name)
            if (!from.id) return { ok: false, id: '', note: from.why }
            const into = resolveOne(rows, args?.into)
            if (!into.id) return { ok: false, id: '', note: into.why }
            if (from.id === into.id) return { ok: false, id: from.id, note: '这两个是同一个人，不用并。' }
            await appendEvent(
              {
                type: 'person_merge',
                text: `并到 ${into.id}`,
                pid: from.id,
                into: into.id,
                ...(who.sessionId ? { sessionId: who.sessionId } : {}),
              },
              { day: model.day, stage: model.stage, source: 'tool' },
              root,
            )
            return { ok: true, id: into.id, note: `把 ${from.id} 并到 ${into.id} 了；以后都算这一个人。` }
          }

          return { ok: false, id: '', note: 'action 只有 add / list / alias / merge 四种。' }
        } catch (err) {
          logLine('warn', ['her_person: 没写成', err?.message ?? err], root)
          return { ok: false, id: '', note: '这条没记下。' }
        }
      },
    }),
  )
}
