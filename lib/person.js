/**
 * person.js —— 「人」这个实体的形状（1.1.4，issue #183 第一阶段）
 *
 * 为什么单独一个文件：`schema.js` 要在写入时校验、`people.js` 要在派生时读、
 * `her_person` 要在回执里报 id。三处必须用同一套上限与同一套 nature，
 * 各写一份迟早会漂——漂了以后是一条人写不进去、或者写进去却永远不摆出来。
 *
 * 三条原则（issue #183 与用户 m02105 的裁定）：
 *   1. **只有显式登记才建人**。不从 `topic`、不从正文猜——猜错一次，
 *      她就永远以为那句判断是关于这个人的。
 *   2. **nature 只决定身份段分哪一栏**，不参与「这句判断有什么凭据」。
 *      凭据（`basis`：亲口 / 转述 / 作品 / 别人写的）是另一条线，本版不做。
 *   3. **同名不猜**：名字命中多个时，调用方要么拿 id，要么被拒；没有「取最近那个」。
 *
 * 事件形状（纯加法，不升 `EVENT_SCHEMA_VERSION`）：
 *   person_add   { pid, name, nature, text: 一句为什么这是个人 }
 *   person_alias { pid, text: 小名 }
 *   person_merge { pid, into, text: 为什么是同一个人 }
 */

/** 一个人算什么。只影响摆在哪一栏，不影响判断能不能挂上来。 */
export const PERSON_NATURES = Object.freeze([
  'real', // 现实里的人：他朋友、家里人
  'fictional', // 作品里的角色
  'author', // 写东西的人：UP 主、作者
  'group', // 群里的人、桥那头的人
  'self', // 她自己——不进「你认识的人」
  'anonymous', // 没有名字的人：评论里那位、某条弹幕的主人
])

/** 名字最长多少个字（与 `schema.js` 的 `WHO_NAME_MAX` 同一个数）。 */
export const PERSON_NAME_MAX = 40
/** 「为什么这是个人」最长多少字。一句话就够，写长了是日记。 */
export const PERSON_NOTE_MAX = 200
/** 显式登记的人最多多少个；满了要她先 merge，不然列表本身就成了负担。 */
export const PERSON_REGISTRY_MAX = 50

/** 人物 id 的形状：`p_` + 小写字母数字。派生层、工具、测试都按这个认。 */
const PID_RE = /^p_[0-9a-z]{4,20}$/

/** 校验并规整 pid；不合法返回空串（调用方决定是拒还是跳过）。 */
export function normalizePid(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return PID_RE.test(s) ? s : ''
}

/** 名字：压空白、去掉包住它的引号、截到上限。 */
export function normalizePersonName(v) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[「」『』“”"']+|[「」『』“”"']+$/g, '')
    .trim()
    .slice(0, PERSON_NAME_MAX)
}

/** nature：认不出就退回 `real`——写错一个词不该让整条事件被拒。 */
export function normalizeNature(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return PERSON_NATURES.includes(s) ? s : 'real'
}

/**
 * 生成一个 pid。用毫秒 + 两位随机：同一天连着建三个人也不会撞。
 * 不用 ULID：这里不需要全局单调，人只有几十个。
 */
export function newPersonId(now = Date.now(), rand = Math.random) {
  const base = Math.max(0, Math.trunc(Number(now) || 0)).toString(36)
  const tail = Math.floor(rand() * 36 ** 2)
    .toString(36)
    .padStart(2, '0')
  return `p_${base}${tail}`
}

/** 摆给人看时，nature 怎么念（身份段的分栏标题用）。 */
export const PERSON_NATURE_TEXT = Object.freeze({
  real: '现实里的人',
  fictional: '作品里的角色',
  author: '写东西的人',
  group: '群里的人',
  self: '我自己',
  anonymous: '没有名字的人',
})
