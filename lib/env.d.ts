/**
 * env.d.ts —— 零依赖环境下的 Node.js 内置模块与全局对象最小类型声明
 *
 * 铁律要求 `devDependencies` 保持 `{}`，不装 `@types/node`；
 * 本文件提供插件实际用到的 `node:*` 内置模块与 `Buffer`/`process`/定时器/`URL` 等全局声明，
 * 让本地 IDE 语言服务与 CI `npx tsc -p jsconfig.json --noEmit` 在零安装状态下直接通过。
 *
 * 为什么不借 DOM lib：服务端代码跑在 Node 里，DOM 会让 `window`/`document`/`localStorage`
 * 在这里也查得过，而且同名全局的签名和 Node 不一样（`setTimeout` 在 DOM 里返回 `number`）。
 * 所以 `jsconfig.json` 只开 `ES2023`，用到哪个运行时全局就在这里补哪个；
 * 新开 `@ts-check` 的文件报「Cannot find name」时，照 Node 的真实签名往下加，别把 DOM 加回去。
 */

interface Buffer extends Uint8Array<ArrayBuffer> {
  toString(encoding?: string, start?: number, end?: number): string
  equals(other: Uint8Array): boolean
  subarray(start?: number, end?: number): Buffer
  slice(start?: number, end?: number): Buffer
  write(str: string, offset?: number, length?: number, encoding?: string): number
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number
}

declare var Buffer: {
  from(data: string, encoding?: string): Buffer
  from(data: ArrayBuffer | ArrayLike<number> | Uint8Array): Buffer
  alloc(size: number, fill?: number | string, encoding?: string): Buffer
  allocUnsafe(size: number): Buffer
  concat(list: ReadonlyArray<Uint8Array>, totalLength?: number): Buffer
  isBuffer(obj: unknown): obj is Buffer
  byteLength(str: string | Uint8Array, encoding?: string): number
}

declare var process: {
  env: Record<string, string | undefined>
  argv: string[]
  pid: number
  ppid: number
  platform: string
  arch: string
  version: string
  execPath: string
  cwd(): string
  exit(code?: number): never
  kill(pid: number, signal?: string | number): boolean
  on(event: string, listener: (...args: any[]) => void): any
  off(event: string, listener: (...args: any[]) => void): any
  stdout: { write(chunk: string | Uint8Array): boolean }
  stderr: { write(chunk: string | Uint8Array): boolean }
}

/**
 * Node 的定时器句柄。插件到处靠 `.unref?.()` 不拖住进程退出，所以返回值得是对象，不是 `number`。
 * （`jsconfig.json` 同时写死了 `types: []`：不写的话 tsc 会自动收进上级目录里的
 * `node_modules/@types/*`，本机恰好有 `@types/node` 时看到的类型和 CI 不一样。）
 */
interface NodeTimeout {
  ref(): this
  unref(): this
  hasRef(): boolean
  refresh(): this
  [Symbol.toPrimitive](): number
}

declare function setTimeout<TArgs extends any[]>(callback: (...args: TArgs) => void, ms?: number, ...args: TArgs): NodeTimeout
declare function setInterval<TArgs extends any[]>(callback: (...args: TArgs) => void, ms?: number, ...args: TArgs): NodeTimeout
declare function clearTimeout(timeout: NodeTimeout | string | number | undefined | null): void
declare function clearInterval(timeout: NodeTimeout | string | number | undefined | null): void

declare var console: {
  log(...args: any[]): void
  info(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
  debug(...args: any[]): void
}

interface ImportMeta {
  url: string
}

interface URLSearchParams {
  get(name: string): string | null
  getAll(name: string): string[]
  has(name: string): boolean
  set(name: string, value: string): void
  append(name: string, value: string): void
  delete(name: string): void
  keys(): IterableIterator<string>
  values(): IterableIterator<string>
  entries(): IterableIterator<[string, string]>
  forEach(callback: (value: string, key: string) => void): void
  toString(): string
  [Symbol.iterator](): IterableIterator<[string, string]>
}

declare var URLSearchParams: {
  new (init?: string | Record<string, string> | Iterable<[string, string]>): URLSearchParams
}

interface URL {
  href: string
  readonly origin: string
  protocol: string
  username: string
  password: string
  host: string
  hostname: string
  port: string
  pathname: string
  search: string
  readonly searchParams: URLSearchParams
  hash: string
  toString(): string
  toJSON(): string
}

declare var URL: {
  new (url: string | URL, base?: string | URL): URL
  canParse(url: string, base?: string): boolean
}

interface AbortSignal {
  readonly aborted: boolean
  readonly reason: any
  throwIfAborted(): void
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

declare var AbortSignal: {
  abort(reason?: any): AbortSignal
  timeout(ms: number): AbortSignal
}

interface AbortController {
  readonly signal: AbortSignal
  abort(reason?: any): void
}

declare var AbortController: {
  new (): AbortController
}

declare module 'node:fs' {
  const fs: {
    existsSync(p: string): boolean
    readFileSync(p: string): Buffer
    readFileSync(p: string, encoding: string): string
    writeFileSync(p: string, data: string | Uint8Array, options?: any): void
    appendFileSync(p: string, data: string | Uint8Array, options?: any): void
    mkdirSync(p: string, options?: any): string | undefined
    readdirSync(p: string, options?: any): any[]
    statSync(p: string, options?: any): any
    lstatSync(p: string, options?: any): any
    realpathSync(p: string, options?: any): string
    renameSync(oldPath: string, newPath: string): void
    unlinkSync(p: string): void
    rmSync(p: string, options?: any): void
    chmodSync(p: string, mode: number | string): void
    copyFileSync(src: string, dest: string, mode?: number): void
    openSync(p: string, flags: string | number, mode?: number): number
    closeSync(fd: number): void
    fsyncSync(fd: number): void
    readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number
    writeSync(fd: number, buffer: Uint8Array | string, offset?: number, length?: number, position?: number | null): number
    createReadStream(p: string, options?: any): any
    createWriteStream(p: string, options?: any): any
    promises: typeof import('node:fs/promises')
  }
  export const existsSync: typeof fs.existsSync
  export const readFileSync: typeof fs.readFileSync
  export const writeFileSync: typeof fs.writeFileSync
  export const appendFileSync: typeof fs.appendFileSync
  export const mkdirSync: typeof fs.mkdirSync
  export const readdirSync: typeof fs.readdirSync
  export const statSync: typeof fs.statSync
  export const lstatSync: typeof fs.lstatSync
  export const realpathSync: typeof fs.realpathSync
  export const renameSync: typeof fs.renameSync
  export const unlinkSync: typeof fs.unlinkSync
  export const rmSync: typeof fs.rmSync
  export const chmodSync: typeof fs.chmodSync
  export const copyFileSync: typeof fs.copyFileSync
  export const openSync: typeof fs.openSync
  export const closeSync: typeof fs.closeSync
  export const fsyncSync: typeof fs.fsyncSync
  export const readSync: typeof fs.readSync
  export const writeSync: typeof fs.writeSync
  export const createReadStream: typeof fs.createReadStream
  export const createWriteStream: typeof fs.createWriteStream
  export const promises: typeof fs.promises
  export default fs
}

declare module 'node:fs/promises' {
  export function readFile(p: string): Promise<Buffer>
  export function readFile(p: string, encoding: string): Promise<string>
  export function writeFile(p: string, data: string | Uint8Array, options?: any): Promise<void>
  export function appendFile(p: string, data: string | Uint8Array, options?: any): Promise<void>
  export function mkdir(p: string, options?: any): Promise<string | undefined>
  export function readdir(p: string, options?: any): Promise<any[]>
  export function stat(p: string, options?: any): Promise<any>
  export function lstat(p: string, options?: any): Promise<any>
  export function realpath(p: string, options?: any): Promise<string>
  export function rename(oldPath: string, newPath: string): Promise<void>
  export function unlink(p: string): Promise<void>
  export function rm(p: string, options?: any): Promise<void>
  export function chmod(p: string, mode: number | string): Promise<void>
  export function copyFile(src: string, dest: string, mode?: number): Promise<void>
  export function mkdtemp(prefix: string, options?: any): Promise<string>
  export function open(p: string, flags?: string | number, mode?: number): Promise<any>
  const fsp: Record<string, any>
  export default fsp
}

declare module 'node:path' {
  const path: {
    join(...paths: string[]): string
    resolve(...paths: string[]): string
    dirname(p: string): string
    basename(p: string, ext?: string): string
    extname(p: string): string
    relative(from: string, to: string): string
    normalize(p: string): string
    isAbsolute(p: string): boolean
    parse(p: string): { root: string; dir: string; base: string; ext: string; name: string }
    sep: string
    delimiter: string
    posix: any
    win32: any
  }
  export const join: typeof path.join
  export const resolve: typeof path.resolve
  export const dirname: typeof path.dirname
  export const basename: typeof path.basename
  export const extname: typeof path.extname
  export const relative: typeof path.relative
  export const normalize: typeof path.normalize
  export const isAbsolute: typeof path.isAbsolute
  export const parse: typeof path.parse
  export const sep: string
  export const delimiter: string
  export const posix: any
  export const win32: any
  export default path
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
  export function platform(): string
  export function hostname(): string
  export function cpus(): any[]
  export const EOL: string
  const os: Record<string, any>
  export default os
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
  export function pathToFileURL(p: string): URL
}

declare module 'node:child_process' {
  export function spawn(command: string, args?: readonly string[], options?: any): any
  export function spawnSync(command: string, args?: readonly string[], options?: any): any
  export function execFile(file: string, args?: readonly string[] | any, options?: any, callback?: any): any
  export function execFileSync(file: string, args?: readonly string[], options?: any): any
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): any
  export function createHmac(algorithm: string, key: string | Uint8Array): any
  export function randomBytes(size: number): Buffer
  export function randomUUID(): string
  export function scryptSync(password: string | Uint8Array, salt: string | Uint8Array, keylen: number, options?: any): Buffer
  export function createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array, options?: any): any
  export function createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array, options?: any): any
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean
  const crypto: Record<string, any>
  export default crypto
}

declare module 'node:zlib' {
  export function gzipSync(buf: string | Uint8Array, options?: any): Buffer
  export function gunzipSync(buf: Uint8Array, options?: any): Buffer
  export function inflateRawSync(buf: Uint8Array, options?: any): Buffer
  export function deflateRawSync(buf: string | Uint8Array, options?: any): Buffer
  const zlib: Record<string, any>
  export default zlib
}

declare module 'node:http' {
  export function createServer(requestListener?: (req: any, res: any) => void): any
  export function request(url: string | URL | any, options?: any, callback?: any): any
  const http: Record<string, any>
  export default http
}

declare module 'node:https' {
  export function request(url: string | URL | any, options?: any, callback?: any): any
  const https: Record<string, any>
  export default https
}

declare module 'node:net' {
  export function createConnection(options: any, connectListener?: () => void): any
  export function createServer(connectionListener?: (socket: any) => void): any
  export function isIP(input: string): number
  const net: Record<string, any>
  export default net
}

declare module 'node:tls' {
  export function connect(options: any, secureConnectListener?: () => void): any
  const tls: Record<string, any>
  export default tls
}

declare module 'node:timers/promises' {
  export function setTimeout<T = void>(delay?: number, value?: T, options?: any): Promise<T>
}
