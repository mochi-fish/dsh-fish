/**
 * guess.js —— 「这句是猜的，还是不是」（S0.6，用户 m01020 / m01298）
 *
 * 为什么单独一个文件：`lib/people.js` 也要用它（判断摆到某个人名下时要知道
 * 该写「你猜过」还是「你有一句准话」），而 `lib/derive.js` 要 import people.js。
 * 放在 derive 里就成了循环依赖，所以把这两条正则挪出来，derive 照旧 re-export。
 *
 * 为什么只分两类：`lib/stance.js` 的 `classifyStance` 敢用两条正则判「喜欢 / 拒绝」，
 * 是因为那两个类别边界硬。「观察」和「看法」的边界软得多——「他总在半夜回话」
 * 既是看到的，也是她的看法；硬分必错，而分类一错，摆出来的标题就是错的，比不分更糟。
 * 「猜的」边界硬：推测词就那么几个。
 *
 * 分类在宿主侧（`lib/schema.js` 堵死了她自己打标：`anchored` 只认宿主写，
 * 「让她自己打标，等于让她决定『我哪句话算数』」）。所以不新增任何参数，
 * 只从她写下的正文里读，**只改摆法，不改她的任何数据**。
 *
 * 已知边界：漏判（她写「兴许」「说不准」以外的说法）只会少一个「猜」字，不会写坏数据；
 * 误判（「不可能」里带「可能」）用 NOT_GUESS 挡一道。宁可漏，不可错标签。
 */

const GUESS_WORDS = /(可能|大概|也许|好像|像是|估计|应该是|说不定|我猜|我怀疑|感觉上|兴许|说不准)/
const NOT_GUESS = /(不可能|没可能|不太可能)/

export function isGuess(text = '') {
  const s = String(text ?? '')
  if (!s) return false
  if (NOT_GUESS.test(s)) return false
  return GUESS_WORDS.test(s)
}
