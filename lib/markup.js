/**
 * markup.js —— 模型侧工具调用标记的清洗（issue #25，2026-11-04）
 *
 * 症状：
 *   侧栏里她发过一整段只有
 *     </｜｜DSML｜｜ invoke>
 *     </｜｜DSML｜｜ calls>
 *   的“正文”，同一句还被她自己道歉「上一条我这边发岔了，粘了一串没用的符号」。
 *   更要紧的是这两段被写进了 `events.jsonl`，成了两条 `utterance`。
 *
 * 根因在模型侧与宿主之间，插件改不了：`deepseek-messages` 那一路偶发
 * 「只发出收尾标记、没有开标签、也没有参数」的一步（案发机器上约 500 轮 2 次）。
 * 解析器组不出一次调用，标记就被当成了 assistant 的正文。而 `turns.js` 的
 * `assistantText()` 只按 `type === 'text'` 取块、取到什么记什么，于是这串符号
 * 变成了她账本里的一句话；`home.js` 里问「上一段最后说了什么」也读同一份正文。
 *
 * 插件能做的只有一件窄事：**别把这种东西记成她的话**。所以这里只做清洗，
 * 而且刻意收窄：
 *   - 只有出现 `｜｜DSML｜｜` 才动手，正常正文一个字符都不改；
 *   - 标记旁边还有真话的，留下真话，只去掉标记；
 *   - 不猜别的工具语法、不删正文里的 `<` `>`、不动 schema、不改已有事件。
 *
 * 2026-11-21（issue #166）加了第二种兜底：模型只吐出调用体的参数段、没有 invoke 头，
 * 这段 `<parameter name="…">…</parameter>` 会按正文落盘；剥壳留话。
 *
 * 2026-11-22（issue #166 跟进，外部报告 @mxc881031 的 A–G 七形状）：上一版的判据是
 * 「壳必须包住整段」（`^…$`），实测只有 A 能剥——正文在前、壳在中间、收尾后多一个
 * 句号、`name='text'` 单引号全都不认（而且 `hasLeakedToolSyntax` 也判 false，静默），
 * 带 invoke 头 + 多参数的那种还会把参数名剥进正文（`add</parameter>`）。现在改成
 * **按配对扫参数段**：任意位置认 `<parameter name=…>…</parameter>`，只取 `name="text"`
 * 那一段的字，别的参数与 invoke/calls 外壳一并丢掉；收尾没闭合的仍然一律不动。
 *
 * 2026-11-26（issue #166 第三轮，外部报告 @mxc881031 复测）：A–G 七条在记录层
 * （`stripToolMarkup` / `stripLeakedToolSyntax`）已经全干净，只剩 `stripToolShell`
 * 自己对 F 仍原样返回——三个函数对同一段给出两个答案。这里把 F 也收进配对扫：
 * 开标签被 DSML 残标打断时先补回 `<`，仍然认不出 `text` 段就按原样返回。
 */

/**
 * 一个完整的参数段（2026-11-22，issue #166 跟进）。
 *
 * 双引号、单引号、不带引号三种写法都认；名字记进 1/2/3 组，正文在第 4 组。
 * `[\s\S]*?` 收到最近的 `</parameter>`，所以「多参数」按顺序两两配对，
 * 不会像上一版那样开口多吃一个参数、收尾落在最后，把中间的字留在正文里。
 */
const SHELL_PAIR = /<parameter\s+name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))\s*>([\s\S]*?)<\/parameter\s*>/gi

/**
 * 参数段之外的外壳：`<invoke …>` / `</invoke>` / `</calls>` / `<function_calls>`，
 * 以及剥完剩下的孤立 `</parameter>`（DSML 分支里删掉了开标签，收尾没人管）。
 * 只在「已经认出参数段」或「已经撞上 DSML 标记」的文本上用，正常正文碰不到它。
 */
const SHELL_TAGS = /<\/?(?:invoke|calls|function_calls)\b[^>]*>|<\/\s*parameter\s*>/gi

/** 剥完壳剩下的尾巴：只有空白和标点才当成壳的一部分吸收掉（`</invoke>。`）。 */
const SHELL_TAIL = /^[\s。，、！？；：…—,.;:!?~)\]】」』”’]*$/

/** 标记的核心片段。全角竖线 `｜` 是 U+FF5C，别写成半角 `|`。 */
const TOKEN = '｜｜DSML｜｜'
/** 不带 g：`.test()` 用它。带 g 的正则会记 lastIndex，第二次调用就判错。 */
const CORE = /｜｜dsml｜｜/i
/** 只管这种外壳：`<｜｜DSML｜｜ invoke>` / `</｜｜DSML｜｜ calls>` 之类。 */
const WHOLE = /<\/?｜｜DSML｜｜[^>]*>/gi

/** 这段正文里有没有工具调用标记（给「要不要打一行日志」用）。 */
export function hasToolMarkup(text) {
  return CORE.test(String(text ?? ''))
}

/** 把 `SHELL_PAIR` 扫一遍，按出现顺序返回 `{ name, start, end, inner }`（不 splice）。 */
function scanShellPairs(source) {
  SHELL_PAIR.lastIndex = 0
  const pairs = []
  let m
  while ((m = SHELL_PAIR.exec(source)) !== null) {
    const name = (m[1] ?? m[2] ?? m[3] ?? '').trim().toLowerCase()
    pairs.push({ name, start: m.index, end: m.index + m[0].length, inner: m[4] })
    if (m[0].length === 0) SHELL_PAIR.lastIndex += 1
  }
  return pairs
}

/**
 * 剥掉漏进正文的参数壳，留下她真说的话；认不出参数段就原样返回（不加 trim）。
 *
 * 认出的形状（任意位置，不再要求包住整段）：
 *   - `<parameter name="text">话</parameter>`（单引号、不带引号也认）
 *   - 外面可能还裹着 `<invoke name="…">` / `</invoke>` / `</calls>` / `<function_calls>`
 *   - 一个调用里多个参数时，只留 `text` 那段；别的参数（`action`、`title`…）连同标签丢掉
 *   - 收尾后只剩标点的（`</invoke>。`）一起吸收
 *   - 开标签被 DSML 残标打断了 `<` 的（`<｜｜DSML｜｜ parameter name="text">`），
 *     补回那一笔再按配对扫（issue #166 的 F，2026-11-26）
 *
 * 不动的形状：收尾没闭合的、正文中间提到 `<parameter>` 而没写 `</parameter>` 的
 * ——宁可漏判，不可把她真说的话切掉。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripToolShell(text) {
  const original = String(text ?? '')
  if (!original || !/parameter/i.test(original)) return original
  // issue #166 的 F（2026-11-26）：`<｜｜DSML｜｜ parameter name="text">…` 这种开标签
  // 比参数段少了 `<` 这一笔，配对扫认不出来。只把这一笔补回去，别的字符不动；
  // 补完仍然认不出 `text` 段就按原样返回——那种是 DSML 形态的调用体，不该当正文。
  const source = original.replace(/<｜｜DSML｜｜\s*(?=parameter\b)/gi, '<')
  const normalized = source !== original
  const pairs = scanShellPairs(source)
  if (!pairs.length) return original
  if (normalized && !pairs.some((p) => p.name === 'text')) return original

  let out = ''
  let cursor = 0
  for (const p of pairs) {
    out += source.slice(cursor, p.start)
    // 只有 `text` 是她要说的话；其余参数是调用的一部分，不该进正文。
    if (p.name === 'text') out += p.inner
    cursor = p.end
  }
  let tail = source.slice(cursor).replace(SHELL_TAGS, '')
  // `</invoke>` 后面跟一个句号的那种：那是壳的尾巴，不是她又说了一句。
  if (SHELL_TAIL.test(tail)) tail = ''
  out += tail
  return out.replace(SHELL_TAGS, '').trim()
}

/**
 * 去掉工具调用标记；去完什么都不剩就返回**空串**——意思是「这一步她没有正文」。
 *
 * 流被截断、标记没闭合（没有 `>`）时，从第一个残标切到行尾：那种情况下后面
 * 跟着的都是标记参数，不是她说的话。反过来，正常句子里提到这几个字符的概率
 * 极低，真提了也只是少半句，不会把她整段话清掉。
 */
export function stripToolMarkup(text) {
  // 先剥参数壳（issue #166）：壳里可能还裹着 DSML 残标，剥完再按老规矩洗。
  const raw = String(stripToolShell(text) ?? '')
  if (!CORE.test(raw)) return raw.trim()
  let t = raw.replace(WHOLE, '')
  // DSML 分支只删掉了开标签那半截（`<｜｜DSML｜｜ parameter name="text">`），
  // 后面的 `</parameter></invoke>` 没人管——这里补一刀，免得留半截壳（issue #166 的 F）。
  t = t.replace(SHELL_TAGS, '')
  const i = t.indexOf(TOKEN)
  // 残标前面通常还留着 `<` 或 `</`（`</｜｜DSML｜｜ invoke` 被截断的那一半），
  // 一起剪掉，否则她会「说」出半截左括号。
  if (i >= 0) t = t.slice(0, i).replace(/<\/?$/, '')
  return t.trim()
}
