/**
 * markup.test.mjs —— 工具调用标记漏进正文时，别把它当成她说的话（issue #25）
 *
 * 这一组守四件事：
 *   ① 只有标记的一步：清洗后是空串，不留任何残渣；
 *   ② 标记旁边还有真话：留真话，只去掉标记；
 *   ③ 正常正文里出现 `<` `>` 的，一个字符都不动；
 *   ④ 流被截断、标记没闭合的，从第一个残标切到行尾。
 *   ⑤ 漏进正文的参数壳（issue #166 / 2026-11-22 跟进）：任意位置认
 *      `<parameter name="…">…</parameter>`，只留 `text` 那段的字；正文中间提到、
 *      或者壳没收尾的，一个字符都不动。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hasToolMarkup, stripToolMarkup, stripToolShell } from '../lib/markup.js'
import { assistantText } from '../lib/turns.js'

/** issue #25 里真实的默认收尾标记（全角竖线 U+FF5C，不是半角 `|`） */
const CLOSE = '</｜｜DSML｜｜ invoke>'

test('只有标记的一步：清洗后是空串', () => {
  assert.equal(stripToolMarkup(CLOSE), '')
  assert.equal(stripToolMarkup(`  ${CLOSE}  `), '')
  assert.equal(stripToolMarkup(`</｜｜DSML｜｜ calls>`), '')
})

test('码点对得上：是全角竖线 U+FF5C，不是半角', () => {
  // 写死这几个码点，免得以后谁手滑把它「修」成半角竖线——那样线上就永远认不出来
  assert.equal(CLOSE[2].codePointAt(0), 0xff5c)
  assert.equal(CLOSE[3].codePointAt(0), 0xff5c)
  assert.equal(hasToolMarkup(CLOSE), true)
  // 半角竖线的顺手版本不该被认成标记
  assert.equal(hasToolMarkup('</||DSML|| invoke>'), false)
})

test('标记旁边还有真话：留真话，只去掉标记', () => {
  assert.equal(stripToolMarkup(`我把窗关上了。${CLOSE}`), '我把窗关上了。')
  assert.equal(stripToolMarkup(`${CLOSE}\n我把窗关上了。`), '我把窗关上了。')
  assert.equal(stripToolMarkup(`前半句${CLOSE}后半句`), '前半句后半句')
})

test('正常正文一个字符都不改', () => {
  const plain = '他写了一句 a < b && c > d，还有 <div> 这种标签。'
  assert.equal(stripToolMarkup(plain), plain)
  assert.equal(stripToolMarkup('没有符号的一句话'), '没有符号的一句话')
  assert.equal(stripToolMarkup(''), '')
  assert.equal(stripToolMarkup(null), '')
  assert.equal(stripToolMarkup(undefined), '')
  assert.equal(hasToolMarkup('<div>不是标记</div>'), false)
})

test('流被截断、标记没闭合：从第一个残标切到行尾', () => {
  // 现实里流断在参数中间，后面跟着的是调用参数，不是她说的话
  assert.equal(stripToolMarkup(`我把窗关上了。${CLOSE.slice(0, -1)}`), '我把窗关上了。')
  assert.equal(stripToolMarkup('我说完了。</｜｜DSML｜｜ invoke name="x"'), '我说完了。')
  // 整个都是残标
  assert.equal(stripToolMarkup('</｜｜DSML｜｜'), '')
})

test('大小写不影响：小写的 dsml 也认', () => {
  assert.equal(stripToolMarkup('收到。</｜｜dsml｜｜ invoke>'), '收到。')
  assert.equal(hasToolMarkup('</｜｜Dsml｜｜ invoke>'), true)
})

test('assistantText：只剩标记的一步取到空串（不会被记成她的话）', () => {
  assert.equal(assistantText({ message: { content: [{ type: 'text', text: CLOSE }] } }), '')
  // content 是字符串兜底的那条路也要洗
  assert.equal(assistantText({ message: { content: CLOSE } }), '')
  assert.equal(assistantText({ text: CLOSE }), '')
  // reasoning 后面跟一段纯标记：仍然是空
  assert.equal(
    assistantText({ message: { content: [{ type: 'reasoning', text: '想想' }, { type: 'text', text: CLOSE }] } }),
    '',
  )
})

test('assistantText：标记和真话混在同一步时，真话照常留下', () => {
  assert.equal(
    assistantText({
      message: {
        content: [
          { type: 'text', text: '我把窗关上了。' },
          { type: 'text', text: CLOSE },
        ],
      },
    }),
    '我把窗关上了。',
    '纯标记的块被丢掉，不留空行',
  )
  assert.equal(
    assistantText({ message: { content: [{ type: 'text', text: `我把窗关上了。${CLOSE}` }] } }),
    '我把窗关上了。',
  )
})

/** issue #166 里真实漏出来的形状：没有 invoke 头，只有参数段 + 收尾 */
const SHELL = '<parameter name="text">我把窗关上了。</parameter>\n</invoke>'

test('参数壳：整段被包住时剥壳留话（issue #166）', () => {
  assert.equal(stripToolShell(SHELL), '我把窗关上了。')
  assert.equal(stripToolMarkup(SHELL), '我把窗关上了。')
  // 带 invoke 头的完整壳也认
  assert.equal(
    stripToolMarkup('<invoke name="her_say"><parameter name="text">我把窗关上了。</parameter></invoke>'),
    '我把窗关上了。',
  )
  // 收尾链长一点（parameter → invoke → calls）照样剥
  assert.equal(stripToolShell('<parameter name="text">嗯。</parameter></invoke></calls>'), '嗯。')
  // 空壳 = 这一步她没有正文
  assert.equal(stripToolMarkup('<parameter name="text"></parameter></invoke>'), '')
})

test('参数壳：认不出的形状一律不动（正文里提到 / 收尾没闭合）', () => {
  const prose = '他说 <parameter name="text"> 是模板里的占位符。'
  assert.equal(stripToolMarkup(prose), prose)
  const half = '<parameter name="text">这半截没收尾'
  assert.equal(stripToolMarkup(half), half)
  // `<div>` 和 `a < b` 那条底线不受影响
  assert.equal(stripToolMarkup('<div>不是标记</div>'), '<div>不是标记</div>')
})

/**
 * issue #166 跟进（@mxc881031 的 A–G 七形状，2026-11-22）。
 * 上一版只认 A：开收尾都锚在整段上，B/C/D 不认；`name="` 写死双引号，E 不认；
 * 开口允许多吃一个 `<parameter>`，G 会把参数名剥进正文。
 */
test('参数壳：壳出现在正文任意位置都认（B / C / D）', () => {
  // B：正文在前，壳在末尾
  assert.equal(
    stripToolShell('好，我记下了。\n\n<parameter name="text">明天九点。</parameter>\n</invoke>'),
    '好，我记下了。\n\n明天九点。',
  )
  // C：壳夹在正文中间
  assert.equal(
    stripToolMarkup('我先说一句。<parameter name="text">明天九点。</parameter>后面还有话。'),
    '我先说一句。明天九点。后面还有话。',
  )
  // D：收尾链后面多一个句号——那是壳的尾巴，不是她又说了一句
  assert.equal(stripToolShell('<parameter name="text">明天九点。</parameter></invoke>。'), '明天九点。')
})

test('参数壳：单引号 / 不带引号的 name 也认（E）', () => {
  assert.equal(stripToolShell("<parameter name='text'>明天九点。</parameter>"), '明天九点。')
  assert.equal(stripToolShell('<parameter name=text>明天九点。</parameter>'), '明天九点。')
})

test('参数壳：多参数只留 text，别的参数不剥进正文（G）', () => {
  const call = '<invoke name="her_note"><parameter name="action">add</parameter>'
    + '<parameter name="text">明天九点。</parameter></invoke>'
  assert.equal(stripToolShell(call), '明天九点。')
  assert.equal(stripToolMarkup(call), '明天九点。')
  // 只有参数、没有 text：那一步她没有说话
  assert.equal(stripToolMarkup('<invoke name="her_note"><parameter name="action">add</parameter></invoke>'), '')
  // 但正文照常留下
  assert.equal(
    stripToolMarkup('好。<parameter name="action">add</parameter>'),
    '好。',
  )
})

test('参数壳：DSML 残标开头的半截壳，收尾不留残尾（F）', () => {
  const raw = '好。<｜｜DSML｜｜ parameter name="text">明天九点。</parameter></invoke>'
  assert.equal(stripToolMarkup(raw), '好。明天九点。')
  // 原来会留 `</parameter></invoke>`：DSML 分支只删了开标签那半截
  assert.equal(stripToolMarkup(raw).includes('</'), false)
  // issue #166 第三轮：三个函数要对同一段给同一个答案，`stripToolShell` 也要收 F
  assert.equal(stripToolShell(raw), '好。明天九点。')
  // 但带 DSML 残标的非 text 调用体不该被当成正文（补 `<` 之后认不出 text 就原样返回）
  const foreign = '好。<｜｜DSML｜｜ parameter name="action">add</parameter>'
  assert.equal(stripToolShell(foreign), foreign)
})

test('assistantText：参数壳不会被记成她的话（issue #166）', () => {
  assert.equal(assistantText({ message: { content: [{ type: 'text', text: SHELL }] } }), '我把窗关上了。')
  // content 是字符串兜底那条路也要过
  assert.equal(assistantText({ message: { content: SHELL } }), '我把窗关上了。')
})
