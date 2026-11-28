// @ts-check
/**
 * reset-pending.js —— 「重开一局」先写一张意向书，等启动时再搬（2026-11-28 外部报告）
 *
 * 为什么不能在运行中搬：
 *   Windows 上把一个目录整体 rename 走，只要那一刻目录里**任何一个文件**被打开就会
 *   EPERM——而插件自己每轮都在写：`log.js` 的日志、`session-pressure` 的缓存、
 *   `tenant.js` 每 15 秒 tmp+rename 的 `instance.json`、`autobackup` 扫目录。
 *   用户看到的就是「点了没反应」（失败回执原来又渲染在页顶，卡在页尾，滚不到）。
 *
 * 唯一真正没有写入者的时刻是 `boot()` 的第一行：还没人写日志、没占位、没建屋子。
 * 所以点下去先写一张**放在数据目录之外**的意向书（`~/.dsh-fish-reset.json`），
 * 当场试一次；试不成也把意向留下，下次启动时兑现。
 *
 * 不变量（都对着测试）：
 *   1. 意向书和它的失败日志都不能放进 root —— root 正是要被整体搬走的那个目录；
 *   2. 读坏了当成没有（并记一行），绝不让它挡住启动；
 *   3. 搬之前先写 `running`；下次启动看到 `running` 说明上次搬到一半进程没了——
 *      不自动重试（可能已经跨盘复制了一半），转 `failed` 等人点「再试一次」；
 *   4. root 与当前数据目录不同的意向书一律不碰（同一台机器可以有好几间屋）。
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'node:fs'
import { join, resolve, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { resetAll } from './reset.js'
import { retireHomeSessions } from './retire.js'

const VERSION = 1
export const PHASES = ['armed', 'running', 'done', 'failed']
const LOCK_STALE_MS = 120_000

/**
 * 意向书的路径。可以用 `DSH_FISH_RESET_PENDING` 改（测试与多实例用），
 * 但**绝不能**落在 root 里 —— 这个文件要在 root 被搬走之后还活着。
 */
export function pendingFile() {
  const env = String(process.env.DSH_FISH_RESET_PENDING ?? '').trim()
  return env || join(homedir(), '.dsh-fish-reset.json')
}

/** 意向书自己的日志（搬失败时写这里；root 里的日志会跟着一起被搬走）。 */
export function pendingLogFile() {
  return pendingFile().replace(/\.json$/i, '') + '.log'
}

function noteLog(line) {
  try {
    mkdirSync(dirname(pendingLogFile()), { recursive: true })
    writeFileSync(pendingLogFile(), `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' })
  } catch { /* 侧日志写不进去也不能挡路 */ }
}

/** 两个 root 是不是同一个（Windows 盘符与尾斜杠不敏感）。 */
export function sameRoot(a, b) {
  if (!a || !b) return false
  try {
    return resolve(String(a)).replace(/[\\/]+$/, '').toLowerCase()
      === resolve(String(b)).replace(/[\\/]+$/, '').toLowerCase()
  } catch {
    return false
  }
}

function isAbsolutePath(p) {
  try { return isAbsolute(p) } catch { return false }
}

/**
 * 读意向书。文件不在 → null；坏 JSON / 版本不对 / 路径不是绝对的 → null（并记一行）。
 * @returns {null | {version:number, phase:string, root:string, armedAt:string, expect:any, retire:any, attempts:number, lastRun:any, history:any[]}}
 */
export function readPending() {
  const file = pendingFile()
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return null }
  let obj = null
  try { obj = JSON.parse(String(raw).trim() || 'null') } catch {
    noteLog(`意向书读不懂（${file}），当成没有`)
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  if (Number(obj.version) !== VERSION) return null
  if (!PHASES.includes(String(obj.phase))) return null
  if (typeof obj.root !== 'string' || !isAbsolutePath(obj.root)) return null
  return {
    version: VERSION,
    phase: String(obj.phase),
    root: String(obj.root),
    armedAt: typeof obj.armedAt === 'string' ? obj.armedAt : '',
    expect: obj.expect && typeof obj.expect === 'object' ? obj.expect : null,
    retire: obj.retire && typeof obj.retire === 'object' ? obj.retire : null,
    attempts: Number.isFinite(Number(obj.attempts)) ? Number(obj.attempts) : 0,
    lastRun: obj.lastRun && typeof obj.lastRun === 'object' ? obj.lastRun : null,
    history: Array.isArray(obj.history) ? obj.history.slice(-4) : [],
  }
}

function writePending(marker) {
  const file = pendingFile()
  const body = `${JSON.stringify(marker, null, 2)}\n`
  try {
    mkdirSync(dirname(file), { recursive: true })
    // 先写临时文件再改名：半张意向书比没有更糟（下次启动会把它读成坏文件）。
    writeFileSync(`${file}.tmp`, body, 'utf8')
    renameSync(`${file}.tmp`, file)
    return { ok: true }
  } catch {
    try {
      writeFileSync(file, body, 'utf8')
      return { ok: true }
    } catch (err2) {
      noteLog(`意向书写不进去：${String(err2?.message ?? err2)}`)
      return { ok: false, why: String(err2?.message ?? err2) }
    }
  }
}

// ESM 里没有 require；renameSync 从上面那行 import 拿。
/**
 * 排一次重开。同一 root 已经排着（armed）就不再写，armedAt 保持不变。
 * @param {{root:string, expect?:any, retire?:any, now?:Date}} opts
 */
export function armPending(opts = {}) {
  const { root, expect = null, retire = null, now = new Date() } = opts
  const at = now instanceof Date ? now : new Date(now)
  const existing = readPending()
  const base = existing && sameRoot(existing.root, root) ? existing : null
  if (base && base.phase === 'armed') return { ok: true, already: true, marker: base }
  const marker = {
    version: VERSION,
    phase: 'armed',
    root: resolve(String(root ?? '')),
    armedAt: at.toISOString(),
    expect: expect ?? base?.expect ?? null,
    retire: retire ?? base?.retire ?? null,
    attempts: base?.attempts ?? 0,
    lastRun: base?.lastRun ?? null,
    history: (base?.history ?? []).slice(-4),
  }
  const w = writePending(marker)
  noteLog(`排好重开：${marker.root}`)
  return { ok: w.ok, already: false, marker, why: w.why }
}

/** 撤销一张还没搬的意向书。正在搬（running）时拒绝。 */
export function cancelPending(opts = {}) {
  const { root } = opts
  const m = readPending()
  if (!m) return { ok: true, removed: false }
  if (root && !sameRoot(m.root, root)) return { ok: true, removed: false, why: '不是这个数据目录的' }
  if (m.phase === 'running') return { ok: false, removed: false, why: '正在搬，等它结束' }
  try {
    unlinkSync(pendingFile())
    noteLog('撤销重开')
    return { ok: true, removed: true }
  } catch {
    return { ok: true, removed: false }
  }
}

/** 清掉意向书（搬完之后用；文件不在也不报错）。 */
export function clearPending() {
  try { unlinkSync(pendingFile()) } catch { /* 没有就没有 */ }
  try { unlinkSync(`${pendingFile()}.lock`) } catch { /* 同上 */ }
}

/** 给设置页看的摘要；不是这个 root 的意向书返回 null。 */
export function pendingSummary(root) {
  const m = readPending()
  if (!m) return null
  if (root && !sameRoot(m.root, root)) return null
  return {
    phase: m.phase,
    root: m.root,
    armedAt: m.armedAt,
    attempts: m.attempts,
    lastRun: m.lastRun,
  }
}

function lockPath() { return `${pendingFile()}.lock` }

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return String(err?.code ?? '') === 'EPERM'
  }
}

/** 两个实例同时启动时只让一个搬。锁超过 2 分钟或 pid 已经不在了就当没有。 */
function takeLock() {
  const file = lockPath()
  try {
    const j = JSON.parse(readFileSync(file, 'utf8') || '{}')
    const at = Number(j?.at)
    const pid = Number(j?.pid)
    if (pid && pid !== process.pid && Number.isFinite(at) && Date.now() - at < LOCK_STALE_MS && processAlive(pid)) {
      return { ok: false, why: `另一个实例（pid ${pid}）正在搬` }
    }
  } catch { /* 没有锁或锁坏了：往下写 */ }
  try { writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8') } catch { /* 锁写不进去就不锁 */ }
  return { ok: true }
}

function dropLock() {
  try { unlinkSync(lockPath()) } catch { /* 没有就算了 */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function nowIso() { return new Date().toISOString() }

/**
 * 兑现意向书。永不抛（启动链路不能被它带垮）。
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {object} [opts.ctx]
 * @param {(m:string)=>void} [opts.log]
 * @param {(root:string, opts?:object)=>Promise<any>} [opts.reset]
 * @param {number[]} [opts.retryDelays]
 */
export async function attemptPending(opts = {}) {
  const { root, ctx = null, log, reset = resetAll, retryDelays = [0, 150, 400] } = opts

  // 回执的形状统一成：ok 表示「这一次搬成了」，skipped 表示「没轮到我 / 没有要搬的」。
  const marker = readPending()
  if (!marker) return { ok: true, skipped: true, code: 'none', why: '没有排着的重开' }
  if (!sameRoot(marker.root, root)) return { ok: true, skipped: true, code: 'other_root', why: '意向书是另一个数据目录的' }

  if (marker.phase === 'done') {
    const movedTo = String(marker.lastRun?.movedTo ?? '')
    clearPending()
    return { ok: true, code: 'done', done: true, movedTo }
  }

  if (marker.phase === 'running') {
    // 上次搬到一半进程没了：数据可能已经整体搬走、也可能跨盘复制了一半。
    // 不自动重试——转 failed，让设置页的人看到并决定。
    const why = '上一次重开搬到一半就断了（进程中途退出）。旧的一切没被动过，这次不自动重试——在设置页点「再试一次」。'
    const failed = {
      ...marker,
      phase: 'failed',
      failedAt: nowIso(),
      lastRun: { at: nowIso(), ok: false, code: 'dirty', why },
    }
    writePending(failed)
    noteLog(`running 残留（${marker.root}）→ failed`)
    return { ok: false, code: 'dirty', why, marker: failed }
  }

  if (marker.phase === 'failed') {
    return { ok: false, code: 'failed', why: String(marker.lastRun?.why ?? '上一次没搬成'), marker }
  }

  const lock = takeLock()
  if (!lock.ok) return { ok: true, skipped: true, code: 'locked', why: lock.why }

  const startedAt = nowIso()
  const attempt = marker.attempts + 1
  try {
    writePending({ ...marker, phase: 'running', startedAt, attempts: attempt })

    /** @type {any} */
    let last = null
    let tries = 0
    for (const delay of retryDelays) {
      if (delay) await sleep(delay)
      tries += 1
      try {
        last = await reset(root, { log })
      } catch (err) {
        last = { ok: false, code: String(err?.code ?? 'internal'), why: String(err?.message ?? err) }
      }
      if (last?.ok) break
      noteLog(`第 ${tries} 次没搬成（${last?.code ?? '?'}）：${String(last?.why ?? '').slice(0, 200)}`)
    }

    if (!last?.ok) {
      const why = String(last?.why ?? '没搬成')
      const code = String(last?.code ?? '')
      const failed = {
        ...marker,
        phase: 'armed',
        attempts: attempt,
        lastRun: { at: nowIso(), ok: false, code, why, tries },
        history: [
          ...(marker.history ?? []),
          { at: startedAt, ok: false, code, why: why.slice(0, 160), tries },
        ].slice(-4),
      }
      writePending(failed)
      return { ok: false, code, why, pending: true, marker: failed }
    }

    // 旧会话的登记在 home.json 里，而 home.json 已经跟着 root 一起被搬走了——
    // 只能用排意向那一下记下的快照（retire.js 支持直接收一份 home 记录）。
    let retired = { ok: true, archived: [], failed: [], why: '' }
    try {
      retired = /** @type {any} */ (await retireHomeSessions(ctx, { root, home: marker.retire ?? null, log }))
    } catch (err) {
      retired = { ok: false, archived: [], failed: [], why: String(err?.message ?? err) }
    }

    const done = {
      ...marker,
      phase: 'done',
      finishedAt: nowIso(),
      attempts: attempt,
      lastRun: {
        at: nowIso(),
        ok: true,
        movedTo: String(last.movedTo ?? ''),
        archived: retired.archived ?? [],
        retiredError: retired.ok ? '' : retired.why,
      },
      history: [
        ...(marker.history ?? []),
        { at: startedAt, ok: true, code: '', movedTo: String(last.movedTo ?? ''), tries },
      ].slice(-4),
    }
    writePending(done)
    noteLog(`重开完成：${last.movedTo || '(本来就没有档)'}`)
    return { ok: true, code: 'done', movedTo: String(last.movedTo ?? ''), carried: last.carried ?? [], retired, marker: done }
  } finally {
    dropLock()
  }
}

/**
 * boot() 最前调用的入口：吞掉一切异常。
 * @param {object} ctx
 * @param {string} root
 * @param {{log?:(m:string)=>void, reset?:Function}} [opts]
 */
export async function runPendingReset(ctx, root, opts = {}) {
  try {
    return await attemptPending({ root, ctx, log: opts.log, reset: opts.reset })
  } catch (err) {
    const why = String(err?.message ?? err)
    noteLog(`启动兑现异常：${why}`)
    return { ok: false, code: 'internal', why }
  }
}
