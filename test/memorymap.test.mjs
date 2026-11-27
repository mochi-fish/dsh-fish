// 记忆图这一页（2026-11-26）：它是一段 base64 内嵌的 HTML，页面自己跑脚本。
// 这两类错都不会报错、只会「点了没反应」，所以只能在字符串层面盯：
//   ① 模板里主脚本收尾之后多一个游离的 </script>（旧补丁留下的），浏览器提前关掉主脚本，
//      后面整段变成正文文本——点「体检」既不切页签也不抛异常；
//   ② 搜索框或页签的标记被哪次重打补丁弄丢。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MEMORY_MAP_HTML_B64 } from '../lib/memorymap-html.js'
import { renderMemoryMapHtml, herNameOf, scriptJson } from '../lib/memorymap.js'

const template = () => Buffer.from(MEMORY_MAP_HTML_B64, 'base64').toString('utf8')

test('记忆图模板：两个页签、体检那一栏、顶上那颗搜索框都在', () => {
  const h = template()
  assert.match(h, /<div id="tabs">/, '缺页签容器 #tabs')
  assert.match(h, /data-v="health"/, '缺「体检」页签')
  assert.match(h, /<div id="healthpane">/, '缺体检那一栏 #healthpane')
  assert.match(h, /id="hgroups"/, '缺体检上层那三组')
  assert.match(h, /id="hstats"/, '缺体检下层那些数')
  assert.match(h, /id="mfindq"/, '缺顶上那颗搜索框')
  assert.equal((h.match(/__TABS_WIRED__/g) || []).length, 1, '__TABS_WIRED__ 该有且只有一处')
  assert.equal((h.match(/__SEARCH_WIRED__/g) || []).length, 1, '__SEARCH_WIRED__ 该有且只有一处')
})

test('记忆图模板：script 开与合一样多（多一个就把后面的脚本变成正文）', () => {
  const h = template()
  const open = (h.match(/<script\b/g) || []).length
  const close = (h.match(/<\/script>/g) || []).length
  assert.equal(open, close, `有 ${open} 个 <script 但 ${close} 个 </script>，多出来的会提前收尾`)
})

test('renderMemoryMapHtml：没有事件也给得出一页，数据内联、不外链 view.js', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-map-'))
  try {
    const out = await renderMemoryMapHtml(root)
    assert.ok(out.includes('window.__VIEW__='), '页面里没有 __VIEW__ 数据')
    assert.ok(out.includes('window.__HEALTH__='), '页面里没有 __HEALTH__ 数据')
    assert.ok(!out.includes('<script src="view.js"></script>'), '还留着外链 view.js')
    assert.match(out, /id="mfindq"/, '内联数据那一步把搜索框弄丢了')
    assert.equal((out.match(/<script\b/g) || []).length, (out.match(/<\/script>/g) || []).length, '内联之后 script 开合对不上')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('内联数据里出现 </script> 也不会把页面切断（2026-11-27）', () => {
  // 这一段是她可能真的会记下来的东西：B 站评论、群里别人说的话都可能是这种字。
  // JSON.stringify 不转义 `<`，以前这行会被当成 <script> 的收尾，后面的 onerror 直接执行。
  const evil = '</script><img src=x onerror=alert(1)>'
  const s = scriptJson({ text: evil, line: 'a\u2028b' })
  assert.ok(!s.includes('</script>'), '还留着能闭合标签的 </script>')
  assert.ok(!s.includes('<'), '还留着裸的 <')
  assert.ok(!s.includes('\u2028'), '还留着行分隔符（老引擎里会当换行）')
  // 转义之后必须还能被 JS 读回原样
  assert.equal(JSON.parse(s).text, evil)
  assert.equal(JSON.parse(s).line, 'a\u2028b')
})

// 名字（2026-11-27）：她自己的名字从事件流里取；取不到就留空，页面只写「记忆星图」。
// 绝不能拿 model.name 顶上——那是「她怎么称呼他」（他的称呼），不是她的名字。
test('她的名字从「他给我起了名字：X」里取', () => {
  assert.equal(herNameOf([{ text: '他给我起了名字：大肥鱼。他说我不是一个东西。' }]), '大肥鱼')
})

test('她自己的说法也认：以后叫我 X / 我想叫做「X」，语气词要去掉', () => {
  assert.equal(herNameOf([{ text: '以后就叫我阿辰吧' }]), '阿辰')
  assert.equal(herNameOf([{ text: '我想叫做「小满」' }]), '小满')
})

test('没写过名字就留空，不从别处兜底', () => {
  assert.equal(herNameOf([]), '')
  assert.equal(herNameOf([{ text: '今天天气不错' }]), '')
  assert.equal(herNameOf([{ text: '他给了我一块糖' }]), '')
})

test('写过多次时取最后一次', () => {
  assert.equal(herNameOf([
    { text: '他给我起了名字：旧名。' },
    { text: '以后就叫我新名' },
  ]), '新名')
})
