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
import { renderMemoryMapHtml } from '../lib/memorymap.js'

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
