// @ts-check
import { spawn } from 'node:child_process'
import { looksMojibake } from './guard.js'
import { logLine } from './log.js'

export const PREFIX = '/dsh-fish'

/**
 * @param {import('./types.js').HostContext | null | undefined} ctx
 * @param {string} key
 * @returns {any}
 */
export function safeGet(ctx, key) {
  try { return ctx?.get?.(key) } catch { return null }
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
export function openFolderInSystem(dir) {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: false })
    } catch {
      resolve(false)
      return
    }
    let settled = false
    /** @param {boolean} ok */
    const done = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => done(true), 800)
    child.on('spawn', () => done(true))
    child.on('error', () => done(false))
    child.unref()
  })
}

/**
 * @param {import('./types.js').HttpResponse} res
 * @param {number} code
 * @param {unknown} obj
 */
export function send(res, code, obj) {
  if (res.writableEnded) return
  const body = JSON.stringify(obj, null, 2)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * @param {import('./types.js').HttpResponse} res
 * @param {any} err
 * @returns {boolean}
 */
export function sentTooLarge(res, err) {
  if (err?.statusCode !== 413) return false
  send(res, 413, { error: String(err.message ?? 'body too large') })
  return true
}

/**
 * @param {import('./types.js').HttpRequest} req
 * @param {number} [maxBytes]
 * @param {{ mojibake?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export function readBody(req, maxBytes = 1_000_000, { mojibake = true } = {}) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let over = false
    req.on('data', (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += b.length
      if (over) {
        if (size > 2 * maxBytes) req.destroy?.()
        return
      }
      if (size > maxBytes) {
        over = true
        chunks.length = 0
        const err = /** @type {Error & { statusCode?: number }} */ (new Error('body too large'))
        err.statusCode = 413
        reject(err)
        return
      }
      chunks.push(b)
    })
    req.on('end', () => {
      if (over) return
      const text = Buffer.concat(chunks).toString('utf8')
      if (mojibake && looksMojibake(text)) {
        const err = /** @type {Error & { statusCode?: number }} */ (new Error('正文不是 UTF-8，没递给她'))
        err.statusCode = 400
        return reject(err)
      }
      resolve(text)
    })
    req.on('error', reject)
  })
}

/**
 * @param {import('./types.js').HttpRequest} req
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 */
export function readBodyBuffer(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let over = false
    req.on('data', (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += b.length
      if (over) {
        if (size > 2 * maxBytes) req.destroy?.()
        return
      }
      if (size > maxBytes) {
        over = true
        chunks.length = 0
        const err = /** @type {Error & { statusCode?: number }} */ (new Error('body too large'))
        err.statusCode = 413
        reject(err)
        return
      }
      chunks.push(b)
    })
    req.on('end', () => {
      if (over) return
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

/** @param {any} rejection */
function rejectionCode(rejection) {
  if (typeof rejection === 'number') return rejection
  const n = Number(rejection?.status)
  return Number.isFinite(n) && n >= 400 && n <= 599 ? n : 403
}

/** @param {any} rejection */
function rejectionMessage(rejection) {
  if (typeof rejection === 'number') {
    return rejection === 401
      ? 'unauthenticated（这条路由要 App 的登录 cookie，外部进程请用插件自带的本机投递口）'
      : 'forbidden（这个 Host 不认）'
  }
  const s = String(rejection?.message ?? '').trim()
  return s || 'forbidden'
}

/**
 * @param {import('./types.js').HostContext} ctx
 * @param {string} root
 */
export function makeGuarded(ctx, root) {
  /**
   * @param {(req: import('./types.js').HttpRequest, res: import('./types.js').HttpResponse) => Promise<any> | any} handler
   */
  return function guarded(handler) {
    /**
     * @param {import('./types.js').HttpRequest} req
     * @param {import('./types.js').HttpResponse} res
     */
    return async (req, res) => {
      const conn = safeGet(ctx, 'connection')
      if (!conn) return send(res, 503, { error: 'connection service unavailable' })
      try {
        const rejection = conn.requestRejection?.(req)
        if (rejection) return send(res, rejectionCode(rejection), { error: rejectionMessage(rejection) })
      } catch (err) {
        logLine('warn', [
          '信任校验抛错，这次请求没进处理',
          `${req?.method ?? ''} ${req?.url ?? ''}`.trim(),
          String(/** @type {any} */ (err)?.message ?? err).slice(0, 160),
        ], root)
        return send(res, 503, { error: 'trust check failed' })
      }
      try {
        await handler(req, res)
      } catch (err) {
        const code = /** @type {any} */ (err)?.statusCode ?? 500
        logLine(code >= 500 ? 'error' : 'warn', [
          '处理这条请求时抛错',
          `${req?.method ?? ''} ${req?.url ?? ''}`.trim(),
          `-> ${code}`,
          String(/** @type {any} */ (err)?.message ?? err).slice(0, 200),
        ], root)
        send(res, code, { error: String(/** @type {any} */ (err)?.message ?? err) })
      }
    }
  }
}

export const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>鱼 · 观测台搬进 App 了</title>',
  '<style>',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1116;color:#d7dde5;',
  '  font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
  '.box{max-width:540px;padding:26px 30px;border:1px solid #262d36;border-radius:12px;background:#12161c}',
  'h1{font-size:16px;margin:0 0 12px;font-weight:600}',
  'p{margin:9px 0;color:#9aa4b2;font-size:13px;line-height:1.75}',
  'code{background:#1b212a;border:1px solid #262d36;border-radius:5px;padding:1px 6px;font-size:12px;color:#d7dde5}',
  '</style></head>',
  '<body><div class="box">',
  '  <h1>观测台搬进 App 里了</h1>',
  '  <p>这一页只能从 App 内部打开 —— 在浏览器里直接访问会被登录栅栏拦下。这是设计如此，不是坏了。</p>',
  '  <p>请到 <code>设置 → 鱼</code>：她的状态、她自己说过的话、日记、生长环境，都在那里。</p>',
  '  <p>她的数据仍然全部在 <code>~/.dsh-fish</code>，可以直接看文件。</p>',
  '</div></body></html>',
].join('\n')
