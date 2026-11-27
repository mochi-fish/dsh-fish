/**
 * 记忆图（2026-11-26 用户 m03077）：把事件流和派生结果排成一张可交互的图。
 *
 * 这里是从 02-我的项目/大肥鱼/记忆可视化/build.mjs 搬进来的，只做了三件事：
 *   · 不再自己读盘——事件、model、stances 都由调用方传进来；
 *   · 不再写文件——返回 view 对象，由 renderMemoryMapHtml 内联进页面；
 *   · 变成纯函数，方便测试和复算。
 *
 * 排版规则一句话：半径=时间（sqrt 摊开），角度=扇区里第几个（螺旋），
 * 叶子从中轴斜岔出去，四种扇区固定在四个 90° 象限里。
 * 位置是稳定的——同样的数据画两次长得一样，第二次打开还认得哪块是哪块。
 */
import { deriveSelf } from './derive.js'
import { buildStances } from './stance.js'

/**
 * 她自己的名字——从事件流里取，不写死。
 *
 * 用户 2026-11-27 的原话：要「用户实际和大肥鱼共同决定的名字」，也就是她自己说
 * 我想叫做「XXX」、或者他给她起的那个名字；没有就留空，标题只写「记忆星图」。
 * 真机上那句话是「他给我起了名字：大肥鱼。」（2026-10-25 那条 utterance），
 * 后面她改口「不是为我造的，是从外面挑的」时名字没变，所以这里取**最后一次**命中。
 *
 * 三种说法：① 起了名字：X ② 以后叫我 X ③ 我想叫做「X」。
 * 都限死在一行内容里、名字不超过 16 字，取不到就返回空串——宁可不写，也不写半句。
 */
const HER_NAME_PATTERNS = [
  /(?:给|替)(?:我|她)?(?:起|取)(?:了|个)?(?:个)?名字\s*[：:]\s*([^\s，。；、！？：:「」『』"'（）()]{1,16})/,
  /以后(?:就)?叫我\s*[「『"']?([^\s，。；、！？「」『』"'（）()]{1,12})/,
  /我想叫[做]?\s*[「『"']([^」』"']{1,12})[」』"']/,
]

export function herNameOf(events) {
  let out = ''
  for (const e of events || []) {
    const text = String(e && e.text ? e.text : '')
    if (!text || text.length > 400) continue
    for (const re of HER_NAME_PATTERNS) {
      const m = text.match(re)
      if (m && m[1]) {
        out = m[1]
          .trim()
          .replace(/[，。；、！？：:]+$/, '')
          .replace(/[吧呀啊哦嘛啦呢]+$/, '')
        break
      }
    }
  }
  return out
}

/** 图例里四个扇区的名字（2026-11-27 用户要求：「人」→「对人的了解」、「听说的」→「听说的事」）。 */
import { MEMORY_MAP_HTML_B64 } from './memorymap-html.js'
import { readEvents } from './store.js'
import { examine } from './health.js'

/**
 * @param {any[]} events
 * @param {any} model deriveSelf 的返回值
 * @param {any[]} stances buildStances 的返回值
 * @param {number} [now]
 */
export function buildViewData(events, model, stances, now = Date.now()) {
  // who 在 S1 之后可能是 {id, name}：渲染层只会印字符串，这里统一折成名字
  const whoName = (w) => (w && typeof w === 'object' ? (w.name || w.id || '') : (w || ''))
  const at = (ev) => Date.parse(ev.ts || ev.at || 0) || 0
  const t0 = Math.min(...events.map(at).filter(Boolean))
  if (!Number.isFinite(t0)) return { meta: { t0: now, t1: now, counts: {} }, sectors: [], spines: {}, tracks: [], nodes: [], edges: [] }

  // ── 扇区定义：角度从 -90°（正上）开始顺时针
  const SECTORS = [
    { key: 'belief', label: '判断', color: '#6fc8ff', from: -90, to: 0 },
    { key: 'heard', label: '听说的事', color: '#7ff0b6', from: 0, to: 90 },
    { key: 'person', label: '对人的了解', color: '#ffd479', from: 90, to: 180 },
    { key: 'stance', label: '立场', color: '#ff9ad5', from: 180, to: 270 },
  ]
  const sectorOf = (k) => SECTORS.find((s) => s.key === k) || SECTORS[0]

  // ── 收集节点
  const nodes = []
  const edgeMap = new Map()
  const addEdge = (a, b, kind) => {
    if (!a || !b || a === b) return
    const k = a < b ? a + '|' + b + '|' + kind : b + '|' + a + '|' + kind
    if (!edgeMap.has(k)) edgeMap.set(k, { a: a < b ? a : b, b: a < b ? b : a, kind })
  }

  const beliefIds = new Set((model.beliefs || []).map((b) => b.id))
  const historyIds = new Set((model.beliefsHistory || []).map((b) => b.id))
  const solidIds = new Set((model.solid || []).map((b) => b.id))

  // 1. 判断（含被推翻的旧句）
  for (const b of model.beliefsHistory || []) {
    const t = Date.parse(b.since) || 0
    const ref = (model.ranked || []).find((r) => r.id === b.id) || b
    nodes.push({
      id: b.id, kind: 'belief',
      text: b.text, at: t,
      verdict: b.verdict || null,
      status: b.status || 'active',
      confidence: Number(b.confidence ?? 0.5),
      topic: b.topic || '',
      // who 现在可能是 {id,name} 这样的对象（S1「谁说的」之后）：面板直接印会出一个
      // [object Object]。这里就折成名字，别把这个坑留给渲染层。
      who: whoName(b.who),
      mentions: Number(ref.mentions || 0),
      verified: Number(ref.verified || 0),
      solid: solidIds.has(b.id),
      stale: Boolean(ref.stale),
      // 最后一次被想起的时间——「快忘了」要按观察时刻现算，不能读死的 stale 布尔
      lastTouch: Number(ref.lastTouchedAt || 0),
      active: beliefIds.has(b.id),
    })
    // 两条判断互相矛盾（derive 的 clash：同一周内、方向相反）——这是唯一一种
    // 「她自己跟自己过不去」的边，画面上要能一眼看见。
    if (ref.conflictWith) addEdge(b.id, String(ref.conflictWith), 'conflict')
  }

  // 2. 她听来的话（从评论区）+ 事件里的 heard
  for (const v of model.voices || []) {
    nodes.push({
      id: v.id, kind: 'heard', text: v.text, at: Date.parse(v.at) || 0,
      from: v.bvid ? `BV ${v.bvid}` : '', echoed: Boolean(v.echoed),
    })
  }
  for (const e of events.filter((x) => x.type === 'heard')) {
    if (nodes.some((n) => n.id === e.id)) continue
    nodes.push({ id: e.id, kind: 'heard', text: e.text, at: at(e), from: whoName(e.who) })
  }

  // 3. 人物（界面上不写主人的真名——公开版不该把用户的名字烙进图里）
  for (const p of model.people || []) {
    const pid = 'person:' + (p.id || p.name)
    nodes.push({
      id: pid, kind: 'person',
      text: p.id === 'owner' ? '主人' : (p.name || '一个人'),
      at: p.firstAt || t0,
      judged: Number(p.judged || 0),
      judgmentIds: p.judgmentIds || [],
    })
    for (const jid of p.judgmentIds || []) addEdge(pid, jid, 'about')
  }

  // 4. 立场
  for (const s of stances) {
    const id = 'stance:' + (s.key || s.id || Math.random().toString(36).slice(2))
    // since 可能是 ISO 字符串（buildStances 直接给的）：不转成毫秒的话，
    // 后面按时间算半径会得到 NaN，节点就静默消失了——HUD 上数得到、图上没有。
    const since = typeof s.since === 'number' ? s.since : (Date.parse(s.since) || now)
    nodes.push({
      id, kind: 'stance', text: s.text || s.title || '', at: since,
      kindOf: s.kind || '', group: s.group || [],
    })
    for (const m of s.group || []) {
      const mid = typeof m === 'string' ? m : m && m.id
      if (mid) addEdge(id, mid, 'stance')
    }
  }

  // 5. 原话：所有 utterance（其中已是判断的复用，其余标记为未认领）
  const beliefNodeIds = new Set(nodes.filter((n) => n.kind === 'belief').map((n) => n.id))
  for (const e of events.filter((x) => x.type === 'utterance')) {
    if (beliefNodeIds.has(e.id)) continue
    nodes.push({
      id: e.id, kind: 'said', text: e.text, at: at(e),
      confidence: Number(e.confidence ?? 0.5),
    })
  }

  // 6. 她看过的东西
  const matByBvid = new Map()
  for (const mt of model.materials || []) {
    const id = 'material:' + mt.key
    matByBvid.set(mt.key, id)
    nodes.push({ id, kind: 'material', text: mt.title || mt.key, at: mt.at || 0, key: mt.key })
  }

  // ── 边
  // 改口链：revise 的 refs 指向旧判断
  for (const e of events.filter((x) => x.type === 'revise' && Array.isArray(x.refs))) {
    for (const r of e.refs) addEdge(e.id, r, 'revise')
  }
  // 同一支 B 站的听闻 → 看过的那条视频
  for (const v of model.voices || []) {
    if (!v.bvid) continue
    const bid = matByBvid.get(v.bvid)
    if (bid) addEdge(v.id, bid, 'about')
  }
  // 同 topic / 同 who
  const byTopic = new Map(), byWho = new Map()
  for (const n of nodes.filter((x) => x.kind === 'belief')) {
    if (n.topic) { (byTopic.get(n.topic) || byTopic.set(n.topic, []).get(n.topic)).push(n.id) }
    if (n.who) { (byWho.get(n.who) || byWho.set(n.who, []).get(n.who)).push(n.id) }
  }
  for (const ids of byTopic.values()) for (let i = 1; i < ids.length; i++) addEdge(ids[0], ids[i], 'topic')
  for (const ids of byWho.values()) for (let i = 1; i < ids.length; i++) addEdge(ids[0], ids[i], 'who')

  // 关系边：文本相似度在这份数据上连不出东西——35 条判断两两最高只有 0.27，
  // 因为每一句都在说不同的事，措辞也不重复。真正能把两句连起来的是它们
  // **引用了同一个东西**：同一句被引号括起来的话、同一个名字。这一层不看修辞，看指称。
  const QUOTE_STOP = new Set(['我也在', '因为什么', '太绕了', '一个字', '一句话'])
  const quotesOf = (t) => [...String(t).matchAll(/[「『"“]([^」』"”]{2,24})[」』"”]/g)]
    .map((m) => m[1].trim())
    .filter((q) => q.length >= 3 && !QUOTE_STOP.has(q))
  {
    const bs = nodes.filter((n) => n.kind === 'belief')
    const qmap = new Map()
    for (const n of bs) {
      for (const q of new Set(quotesOf(n.text))) {
        const arr = qmap.get(q) || qmap.set(q, []).get(q)
        arr.push(n.id)
      }
    }
    for (const [q, ids] of qmap) {
      // 只有两句到四句共享才算关系；五句以上同一个词，那多半是"大肥鱼"这种
      // 到处都在说的名字，全连起来就成了一根柱子，反而看不出什么。
      if (ids.length < 2 || ids.length > 4) continue
      for (let i = 1; i < ids.length; i++) addEdge(ids[0], ids[i], 'quote')
    }
  }

  // 同一天长出来的判断：不是语义关系，是「那几天在想的事」。
  // 单独一种边、单独一种画法（虚线），别和改口链混在一起看。
  {
    const byDay = new Map()
    for (const n of nodes.filter((x) => x.kind === 'belief')) {
      const d = Math.floor((n.at - t0) / 86400000)
      const arr = byDay.get(d) || byDay.set(d, []).get(d)
      arr.push(n)
    }
    for (const arr of byDay.values()) {
      if (arr.length < 2) continue
      arr.sort((a, b) => a.at - b.at)
      for (let i = 1; i < arr.length; i++) addEdge(arr[i - 1].id, arr[i].id, 'day')
    }
  }

  // ── 布局：极坐标（角度=扇区，半径=时间与序位混合），再轻轻推开重叠
  // 半径按「成长期」而不是「已经过了几天」摊开：装完第一天打开时，整只盘
  // 不该只有中间两圈是亮的——外面那一圈圈是「还没走到」，不是画错了。
  const growMs = Math.max(1, Number(model.growthDays) || 30) * 86400000
  const span = Math.max(now - t0, growMs, 1)
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return ((h >>> 0) % 10000) / 10000 }

  // 扇区是固定的 90°：位置稳定，看图的人第二次打开还认得哪块是哪块。
  // 空的立场扇区就让它空着——「这里还没长出东西」本身就是信息。
  const SECTOR_DEG = 90

  // 布局 = 螺旋。半径严格按时间走（时间是硬的，不能为好看挪动），
  // 角度按扇区内的时间位次从 from 扫到 to——于是每一类记忆都是一条从中心盘出来的螺线，
  // 时间密的那几天自然挤成同一圈上的一段弧，稀疏的那几段就一格一格往外跳。
  for (const s of SECTORS) {
    const list = nodes.filter((n) => n.kind === s.key).sort((a, b) => a.at - b.at)
    const m = list.length
    for (let i = 0; i < m; i++) {
      const n = list[i]
      // at 万一不是毫秒数（字符串 / undefined），这里兜一下：宁可位置贴到起点，
      // 也别让这颗点算出 NaN 然后被画布静默跳过——「计数里有、图上没有」就是这么来的。
      const rawAt = Number(n.at)
      const t = Math.min(Math.max(Number.isFinite(rawAt) ? rawAt : t0, t0), now)
      const timeRatio = span > 0 ? (t - t0) / span : 0
      const rankRatio = m > 1 ? i / (m - 1) : 0.5
      // 半径用 sqrt：真实时间里 90% 的记忆挤在前 1/3，线性半径会把整张图压成一个点。
      // sqrt 只是把同一段路程摊开，不改变谁先谁后。
      const rBase = 0.07 + 0.89 * Math.sqrt(timeRatio)
      const aBase = s.from + (s.to - s.from) * (0.06 + 0.88 * rankRatio)
      // 枝条：同一话题的判断走同一条岔枝（角度偏移一样），不同话题分开。
      // 全压在一个角度上时，几百条判断就是一条粗线——图上看不出这里有三十件事。
      // 半径只做毫米级的抖，时间还是硬的：谁先谁后不会因为好看被挪。
      const brancher = n.topic ? hash('t:' + n.topic) : hash('id:' + n.id)
      const branchDeg = (brancher - 0.5) * 15
      const jitterR = 0.014 * (hash(n.id + '|r') * 2 - 1)
      n.sr = rBase
      n.sa = aBase
      n.r = Math.max(0.05, Math.min(0.97, rBase + jitterR))
      n.a = aBase + branchDeg
      const rad = (n.a * Math.PI) / 180
      n.x = Math.cos(rad) * n.r
      n.y = Math.sin(rad) * n.r
    }
  }

  // 「看过的东西」不进那四条螺线：它们是她在边上碰到的东西，不是长出来的判断。
  // 它们也不该按时间摆——看到一样东西，不代表那是「很久以前看的」。
  // 所以放在**最外圈、时间刻度带之外**（r > 1）：读法是「她身边的东西」，
  // 不是「某一天的事」。角度按 id 散开、位置稳定——第二次打开还在原处。
  // （以前这一层没给坐标，画的时候算出 NaN 被静默跳过：计数里有、图上没有。）
  for (const n of nodes) {
    if (n.kind !== 'material') continue
    n.offTime = true
    n.r = 1.09 + 0.035 * hash(n.id)
    n.a = -90 + 360 * hash(n.id + '|a')
    const rad = (n.a * Math.PI) / 180
    n.x = Math.cos(rad) * n.r
    n.y = Math.sin(rad) * n.r
  }

  // 她对自己的说法（narration）：不是判断，是「她怎么讲自己」。
  // 放在中心那只鲸鱼身上——那是她的位置，不是某一类记忆的扇区。
  if (model.narrative && model.narrative.text) {
    const at = Date.parse(model.narrative.at) || now
    nodes.push({
      id: 'self:0', kind: 'self', text: model.narrative.text, at,
      r: 0.165, a: -62, x: 0, y: 0,
    })
  }
  // 一直没定的事（unsettled）：clash 里搁了 14 天还没定下来的那一对。
  // 它和「打架」不一样——打架是硬的，悬着是软的，所以画成一条淡的紫虚线。
  for (const t of model.unsettled || []) {
    const a = String((t.a && t.a.id) || '')
    const b = String((t.b && t.b.id) || '')
    if (a && b) {
      addEdge(a, b, 'unsettled')
      // 两端都记一笔，点开卡片时能说「这条和另一条还悬着」
      for (const id of [a, b]) {
        const n = nodes.find((x) => x.id === id)
        if (n) n.unsettled = true
      }
    }
  }

  // 生长脊：每个扇区把节点按时序连成一条折线——这是"枝"，也是她这一类记忆长出来的轨迹。
  const spines = {}
  for (const s of SECTORS) {
    const list = nodes.filter((n) => n.kind === s.key).sort((a, b) => a.at - b.at)
    if (list.length < 2) { spines[s.key] = []; continue }
    // 脊只走中轴：不跟着叶子偏，否则主干会被叶子拽成一条麻花
    // 脊走「主干」角度：叶子（岔枝）偏出去，主干仍在原处，才看得出哪根枝分了几岔。
    spines[s.key] = list.map((n) => {
      const rad = ((n.sa != null ? n.sa : n.a) * Math.PI) / 180
      const rr = n.sr != null ? n.sr : n.r
      // 第三个值是时间：画的时候按 cursor 截断，脊才是一路长出来的
      return [Math.cos(rad) * rr, Math.sin(rad) * rr, n.at]
    })
  }

  // ── 统计
  const counts = {}
  for (const n of nodes) counts[n.kind] = (counts[n.kind] || 0) + 1

  // ── 横轴曲线：一条线 = 一条判断的命
  // 出生（第一次说出口）→ 被想起时的起伏 → 被改写/被推翻时的转折。
  // 起伏的次数和转折的时间都来自真事件，不补假点。
  const reviseAt = new Map()
  for (const r of events.filter((e) => e.type === 'revise')) {
    for (const ref of (r.refs || [])) {
      if (!reviseAt.has(ref)) reviseAt.set(ref, [])
      reviseAt.get(ref).push(Date.parse(r.ts))
    }
  }

  const tracks = []
  for (const b of model.beliefsHistory || []) {
    const born = Date.parse(b.since)
    if (!Number.isFinite(born)) continue
    const pivots = (reviseAt.get(b.id) || []).filter(Number.isFinite).sort((a, c) => a - c)
    const base = typeof b.confidence === 'number' ? b.confidence : 0.6
    const pts = [[born, Math.max(0.06, base * 0.5)]]
    const recalls = Math.min(6, b.mentions || 0)
    for (let i = 1; i <= recalls; i++) {
      pts.push([born + (now - born) * (i / (recalls + 1)), Math.min(0.92, base * 0.5 + 0.08 * i)])
    }
    for (const p of pivots) pts.push([p, Math.min(0.95, base + 0.15)])
    const tail = b.verdict === 'refuted' ? 0.04 : b.verdict === 'refined' ? base * 0.75 : Math.min(0.98, base + 0.2)
    pts.push([pivots.length ? Math.max(pivots[pivots.length - 1], now - 86400000) : now, tail])
    tracks.push({ id: b.id, text: String(b.text || ''), solid: solidIds.has(b.id), verdict: b.verdict || null, pts })
  }

  const view = {
    meta: {
      // 这张图上写谁的名字：写她自己认下的那个（从事件流里取），不写他的；
      // 她还没有名字时留空，页面只写「记忆星图」。
      // 曾经错取过 model.name——那是「她怎么称呼他」，用户 2026-11-27 指出：时梦尘是他，不是她。
      name: herNameOf(events),
      day: model.day,
      stage: model.stageName,
      generatedAt: now,
      t0, t1: now,
      counts,
      facts: model.facts,
      solid: (model.solid || []).length,
      faded: (model.faded || []).length,
      stances: stances.length,
      people: (model.people || []).length,
      days: Math.max(1, Math.round((now - t0) / 86400000)),
      growth: Math.max(1, Number(model.growthDays) || 30),
      // 她经历过的每一个事件（含系统记账）的时间戳。用来在外圈刻刻度——
      // 密的那几天就是她活得最凶的那几天，这是真数据，不是装饰。
      ticks: events.map(at).filter(Boolean),
      // 他不在的那几段。absence.ts 是「发现他不在」的那一刻，days 是空了几天，
      // 所以区间是 [ts - days*DAY, ts]——那几天她一个人待着。
      absences: events
        .filter((e) => e.type === 'absence' && Number.isFinite(Date.parse(e.ts)))
        .map((e) => {
          const to = Date.parse(e.ts)
          const d = Math.max(1, Number(e.days) || 1)
          return { from: to - d * 86400000, to, days: d }
        })
        .sort((a, b) => a.from - b.from),
      // 传记的刻度：不是「数据里有什么」，是「她第一次做了什么」。
      // 只取第一次——第二次就不叫第一次了，图上放五条正好。
      moments: (() => {
        const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : 1));
        const list = [];
        const take = (pred, label, sub) => {
          const e = sorted.find(pred);
          if (e) list.push({ at: Date.parse(e.ts), label, sub: sub || '', text: String(e.text || '').slice(0, 160) });
        };
        take((e) => e.type === 'utterance', '她第一次开口', '在这个屋子里说的第一句话');
        take((e) => e.type === 'revise', '她第一次改口', '也是第一次认错——同一件事');
        // 不写死「大肥鱼」——别人家的鱼不叫这个名字
        take((e) => /起了(个)?名字|给我起名|管我叫|以后叫我/.test(String(e.text || '')), '她第一次被叫名字', '名字是那天给的');
        take((e) => e.type === 'absentee' || e.type === 'absence', '她第一次被冷落', '两天没人应声');
        take((e) => e.type === 'narration', '她第一次描述自己', '从「看」转到「问来源」');
        // 这两条本机都还是 0 条；机制先留着，真有那一天自动长出来
        take((e) => e.type === 'refusal', '她第一次说不', '第一次明确拒掉一件事');
        if (stances.length) {
          // since 可能是 ISO 字符串：不换算成毫秒，比较是 NaN、排序是乱序，
          // 这条刻度还会被前端的「at <= cursor」判掉——于是它算出来了却不显示。
          const ms = (v) => (typeof v === 'number' ? v : (Date.parse(v) || 0));
          const s0 = [...stances].sort((x, y) => ms(x.since) - ms(y.since))[0];
          const at0 = s0 ? ms(s0.since) : 0;
          if (s0 && at0) {
            list.push({ at: at0, label: '她第一次形成立场', sub: '同一条判断被反复想起、又被应验', text: String(s0.text || s0.claim || '').slice(0, 160) });
          }
        }
        return list.sort((a, b) => a.at - b.at);
      })(),
    },
    sectors: SECTORS,
    spines,
    tracks,
    nodes,
    edges: [...edgeMap.values()],
  }

  return view
}

/**
 * 嵌进 <script> 里的一段 JSON（2026-11-27）：
 * JSON.stringify 不会转义 `<`，她的发言里只要出现一个 `</script>`，这段数据就把
 * <script> 提前关掉，后面的字直接变成 HTML/JS 执行——那是从「别人写的评论」
 * 到她记忆页的一条注入路径。所以这里把 < > & 与行分隔符都写成 \u 形式：
 * 解析出来完全一样，但字符串里不再有任何能闭合标签的字符。
 * @param {any} v
 */
export function scriptJson(v) {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * 拼出完整页面：模板（base64 内嵌）+ 实时数据（替换掉模板里那行 view.js 引用）。
 * @param {string} root 插件数据家（~/.dsh-fish）
 */
export async function renderMemoryMapHtml(root) {
  const { events } = await readEvents(root)
  const model = deriveSelf(events, { growthDays: 30 })
  const stances = buildStances(model)
  const view = buildViewData(events, model, stances)
  // 体检页要和图上用同一份 events，否则页面里的数字和图上的点对不上
  const health = examine(events, { growthDays: 30 })
  const html = Buffer.from(MEMORY_MAP_HTML_B64, 'base64').toString('utf8')
  const data =
    '<script>window.__VIEW__=' + scriptJson(view) +
    ';window.__HEALTH__=' + scriptJson(health) + ';</script>'
  return html.replace('<script src="view.js"></script>', data)
}
