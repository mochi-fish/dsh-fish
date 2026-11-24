/**
 * herpeople.js —— 让她能回头翻「她认识的人」：her_people 工具（1.1.0 S3-c）
 *
 * 和 `lib/herdiary.js` 同一个形状：只开一扇很窄的窗，**不是**给她一个读文件工具。
 *   - 参数只有一个名字（或名字里的几个字），或 `list`；
 *   - **不收路径**——`../`、绝对路径在这里没有入口；
 *   - 一次一份，正文截断到 `PEOPLE_READ_MAX`；
 *   - 读到的**不参与**身份文档拼装，也**不进** `her_recall`：
 *     身份文档里那一段只有三个人一行，完整的内容在事件流里，只有她主动翻才看得到。
 *
 * 为什么不能返回空字符串：返回空串，她会以为「翻成功了，但是空的」；
 * 名单为空时得直接说清「你现在还没往谁名下写过什么」——那是事实，不是失败。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents } from './store.js'
import { loadConfig } from './settings.js'
import { defineTool } from './tool.js'
import { deriveSelf } from './derive.js'
import { findPerson, renderPerson, PEOPLE_READ_MAX } from './people.js'
import { pronounOf } from './pronoun.js'

/** 一次名单回几条：名单本身很短，全给也行，但这里与 `PEOPLE_MAX` 对齐。 */
const LIST_MAX = 24

/** 名字匹配词最长多少个字（防止她拿一整段话当名字）。 */
const WANT_MAX = 40

/**
 * 这一行在名单里怎么写。
 *
 * 2026-11-24 审计：从前这里写死「主人（你说的那个人）」，而她照名单里的字去查
 * 却查不到（那一行的 `name` 是空串，`findPerson` 比对的是名字）——名单在教她
 * 用一个查不到的说法。现在用她自己的称呼：她叫他「猫」，名单里就是「猫」。
 */
function labelOf(p, call) {
  if (p.id !== 'owner') return p.name || '（没留下名字）'
  return p.name || call || '你说的那个人'
}

function nameLine(p, call) {
  const n = labelOf(p, call)
  const j = p.judgments[0]
  return j ? `- ${n}：${j.guess ? '你猜过' : '你写过'}「${j.text.slice(0, 30)}」` : `- ${n}`
}

/**
 * 注册 her_people 工具。
 *
 * @param {object} ctx dsh ctx
 * @param {object} deps `{ root }`
 */
export function registerHerPeople(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_people',
      description:
        '翻你认识的人：你怎么看这个人、这个人说过什么、你拒绝过什么。' +
        '不给名字就回一份名单；给一个名字（或者名字里的几个字）就回那一个人。' +
        '一次一份，太长的会截断。',
      parameters: toJsonSchema({
        name: {
          type: 'string',
          required: false,
          description: '想看谁。全名或者名字里的几个字都行。不写就回一份名单。',
        },
        list: {
          type: 'boolean',
          required: false,
          description: '只想要一份名单：给 true 就只回名字，不出正文。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['found', 'text'],
        },
        render: (_args, out) => [{ type: 'text', text: out.text }],
      },
      async execute(args) {
        try {
          const { events } = await readEvents(root).catch(() => ({ events: [] }))
          const { config } = await loadConfig(root).catch(() => ({ config: {} }))
          // 2026-11-24 审计：这里从前自己调 `peopleOf(events)`，**不传她的称呼**，
          // 于是主人那一行永远没有名字、靠 `topic` 写称呼的判断一条也挂不上——
          // 身份段里摆着「你对猫有过一句准话」，翻出来却没有这句；她按名单里的字
          // 去查也查不到。现在跟身份段走同一个派生（`deriveSelf`），一个真相源。
          const model = deriveSelf(Array.isArray(events) ? events : [], {
            growthDays: config?.growthDays,
          })
          const call = String(model?.name ?? '').trim().slice(0, WANT_MAX)
          // 开关关着时，她的世界里只有{T}一个人——工具也不该把别人翻出来。
          const others = config?.people?.others?.enabled === true
          const all = Array.isArray(model?.people) ? model.people : []
          // 只有称呼、没有任何往来记录的人不摆：一个空壳子页面对她没信息量，
          // 还会让「你现在认识 N 个人」这个数虚高。
          const hasContent = (p) =>
            p.times > 0 || p.judgments.length > 0 || p.changed.length > 0 || p.said.length > 0 || p.didTo.length > 0
          const people = (others ? all : all.filter((p) => p.id === 'owner')).filter(hasContent)

          if (!people.length) {
            return {
              found: false,
              text:
                '你现在还没往谁名下写过什么。哪天对某个人心里有了一句准话，' +
                '用 growth_commit 写下来、topic 填那个人的名字，这里就会有了。',
            }
          }

          const want = String(args?.name ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, WANT_MAX)

          if (args?.list === true || !want) {
            const rows = people.slice(0, LIST_MAX)
            return {
              found: true,
              text: [`你现在认识 ${people.length} 个人：`, ...rows.map((p) => nameLine(p, call))].join('\n'),
            }
          }

          // 名单里写的是哪个字，就得能用那个字查到（见 `labelOf`）：名字匹配不上时，
          // 再按名单上显示的那个说法找一遍——她照着名单问，不该得到「没找到」。
          let hit = findPerson(people, want)
          if (!hit.length) {
            const byLabel = people.filter((p) => {
              const n = labelOf(p, call)
              return n === want || n.includes(want) || want.includes(n)
            })
            if (byLabel.length) hit = byLabel
          }
          if (!hit.length) {
            return {
              found: false,
              text:
                `没找到「${want}」。你现在认识的是：` +
                people.map((p) => labelOf(p, call)).join('、') +
                '。',
            }
          }
          const text = hit.map((p) => renderPerson(p, { pronoun: pronounOf(config) })).join('\n\n')
          return {
            found: true,
            text: text.length > PEOPLE_READ_MAX ? `${text.slice(0, PEOPLE_READ_MAX)}…` : text,
          }
        } catch {
          // 读不出来就是读不出来，不说教、不假装成功。
          return { found: false, text: '这会儿翻不开，稍后再试。' }
        }
      },
    }),
  )
}
