/**
 * 记忆图的出口：一个只在本机回环上的小 HTTP 服务（2026-11-26 用户 m03077）。
 *
 * 和 wikiserve.js 同一个理由：宿主对 http(s) 一律 openExternal + deny，
 * 而信任栅栏要的 cookie 只有 App 自己的 webContents 带着。想要「点一下就
 * 在浏览器里看」，只能自己起一个只监听回环、只认 GET、只吐一份 HTML 的服务。
 *
 * 端口写死 17322（wiki 是 17321，别撞）。被占了就退回系统分配的随机端口。
 */
import { createServer } from 'node:http'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 17322

let STATE = null

function hostOk(raw, port) {
  const h = String(raw || '').trim().toLowerCase()
  return h === `${HOST}:${port}` || h === `localhost:${port}`
}

function send(res, code, headers, body) {
  res.writeHead(code, headers)
  res.end(body)
}

function plain(res, code, text) {
  const body = Buffer.from(text, 'utf8')
  send(res, code, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  }, body)
}

/**
 * 起服务。可重复调用：已经在跑就只把新的 getHtml 换上。
 * @param {{getHtml: () => string | Promise<string>, port?: number}} opts
 */
export function startMapServer(opts = {}) {
  const getHtml = typeof opts.getHtml === 'function' ? opts.getHtml : () => '<!doctype html><meta charset="utf-8"><p>记忆图还没准备好。</p>'
  if (STATE) {
    STATE.getHtml = getHtml
    return api(STATE)
  }

  const st = { getHtml, port: 0, url: '', server: null, triedFallback: false }

  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      plain(res, 405, '只读。')
      return
    }
    if (!hostOk(req.headers.host, st.port)) {
      plain(res, 403, '不认这个地址。')
      return
    }
    let path = '/'
    try { path = new URL(req.url || '/', 'http://127.0.0.1').pathname } catch { path = '/' }
    if (path !== '/' && path !== '/map' && path !== '/map.html') {
      plain(res, 404, '没有这一页。')
      return
    }
    let html = ''
    try {
      html = await st.getHtml()
    } catch (err) {
      plain(res, 500, `这张图没读出来：${err?.message ?? err}`)
      return
    }
    const body = Buffer.from(String(html), 'utf8')
    send(res, 200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    }, req.method === 'HEAD' ? undefined : body)
  })
  st.server = server

  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE' && !st.triedFallback) {
      st.triedFallback = true
      try { server.listen(0, HOST) } catch { /* 下一层还有 error 事件 */ }
      return
    }
    console.warn('[dsh-fish] 记忆图服务起不来', err?.message ?? err)
  })
  server.on('listening', () => {
    const addr = server.address()
    st.port = typeof addr === 'object' && addr ? addr.port : 0
    st.url = `http://${HOST}:${st.port}/`
  })
  server.unref?.()

  const wanted = Number.isInteger(opts.port) && opts.port >= 0 ? opts.port : DEFAULT_PORT
  try { server.listen(wanted, HOST) } catch (err) {
    console.warn('[dsh-fish] 记忆图服务起不来', err?.message ?? err)
  }

  STATE = st
  return api(st)
}

function api(st) {
  return {
    /** 起来之前是空串。UI 那一头拿到空串就显示「正在准备」。 */
    get url() { return st.url },
    get port() { return st.port },
    close() {
      if (STATE === st) STATE = null
      try { st.server?.close() } catch { /* 已经关了 */ }
      st.url = ''
    },
  }
}

/** 给界面用：现取，不缓存。 */
export function mapUrl() {
  return STATE?.url || ''
}

export function closeMapServer() {
  const st = STATE
  STATE = null
  if (!st) return
  try { st.server?.close() } catch { /* 已经关了 */ }
  st.url = ''
}

export const MAP_PORT = DEFAULT_PORT
