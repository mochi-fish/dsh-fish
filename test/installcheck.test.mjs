import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  inspectProfile,
  parseFileDep,
  readDep,
  readDepEntry,
  findProfiles,
  ownName,
  pkgNames,
  countJs,
  versionOf,
  PKG_NAME,
} from '../tools/check-install.mjs'

// 2026-10-30（m02961）：房客那次「升级失败」的真因是 node_modules 里落了空副本——
// 插件自己这时候根本没跑，所以只能从外面查。这个脚本就是那把外面的尺子。
//
// 2026-11-24：一把查不出东西的尺子。包里叫 @ssamurias/dsh-fish（0.8.10 起改名），
// 脚本却只认裸名 dsh-fish，于是每个 profile 都「没装过」，一律退出码 2。
// 下面每处 fixture 都写真实包名；裸名单独留一条，给还没改名的老 profile 用。

const PKG = PKG_NAME
const LEGACY = 'dsh-fish'

function tmp(prefix = 'fish-install-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

const normalize = (p) => String(p).replace(/\\/g, '/').toLowerCase()

function writePkg(dir, obj) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(obj, null, 2))
}

function fillJs(dir, n) {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  for (let i = 0; i < n; i += 1) writeFileSync(join(dir, 'lib', `m${i}.js`), '// x\n')
}

/** 带 scope 的包落在 node_modules/@scope/name，不能拿短名去拼。 */
const copyDir = (profile) => join(profile, 'node_modules', ...PKG.split('/'))

test('包名：脚本认的是 package.json 里的真名，裸名只作历史兼容', () => {
  assert.equal(ownName(), PKG)
  assert.equal(pkgNames()[0], PKG)
  assert.ok(pkgNames().includes(LEGACY))
  assert.equal(PKG_NAME, '@ssamurias/dsh-fish')
})

test('依赖写法：只认 file:，link: 与 npm 版本号都不算副本', () => {
  // 返回的是 resolve 过的绝对路径，Windows 上是反斜杠，所以按「规范化后相等」比。
  assert.equal(normalize(parseFileDep('file:D:/DSH/plugins-src/dsh-fish', 'C:/p')), 'd:/dsh/plugins-src/dsh-fish')
  assert.equal(normalize(parseFileDep('file:../src/fish', 'C:/p/desktop')), 'c:/p/src/fish')
  assert.equal(parseFileDep('link:D:/x', 'C:/p'), '')
  assert.equal(parseFileDep('^0.8.1', 'C:/p'), '')
  assert.equal(parseFileDep(undefined, 'C:/p'), '')
})

test('readDep：坏 JSON 返回 null，没有这个包返回空串', () => {
  assert.equal(readDep('{oops'), null)
  assert.equal(readDep('{"dependencies":{"other":"1"}}'), '')
  assert.equal(readDep(`{"devDependencies":{${JSON.stringify(PKG)}:"file:D:/x"}}`), 'file:D:/x')
})

test('readDepEntry：命中哪条依赖，就按哪条的键去拼副本路径', () => {
  assert.deepEqual(readDepEntry(`{"dependencies":{${JSON.stringify(PKG)}:"file:D:/x"}}`), {
    name: PKG,
    dep: 'file:D:/x',
  })
  // 老 profile 里还是裸名，认它，免得把老装的说成「没装过」
  assert.deepEqual(readDepEntry(`{"dependencies":{"dsh-fish":"file:D:/y"}}`), {
    name: LEGACY,
    dep: 'file:D:/y',
  })
  assert.deepEqual(readDepEntry('{"dependencies":{}}'), { name: '', dep: '' })
})

test('副本与源目录版本一致、文件数相当 → ok（副本在 @ssamurias 下）', () => {
  const root = tmp()
  const src = join(root, 'src')
  const profile = join(root, 'profiles', 'desktop')
  writePkg(src, { name: PKG, version: '1.1.1' })
  fillJs(src, 10)
  writePkg(profile, { name: 'p', dependencies: { [PKG]: `file:${src}` } })
  writePkg(copyDir(profile), { name: PKG, version: '1.1.1' })
  fillJs(copyDir(profile), 10)

  const r = inspectProfile(profile)
  assert.equal(r.verdict, 'ok')
  assert.equal(r.pkgName, PKG)
  assert.equal(normalize(r.copy), normalize(copyDir(profile)))
  assert.equal(r.copyVersion, '1.1.1')
  assert.equal(countJs(r.source), 10)
  assert.equal(versionOf(r.copy), '1.1.1')
})

test('node_modules 里只有个空目录 → empty-copy，并给出修法依据', () => {
  const root = tmp()
  const src = join(root, 'src')
  const profile = join(root, 'profiles', 'desktop')
  writePkg(src, { name: PKG, version: '1.1.1' })
  fillJs(src, 10)
  writePkg(profile, { name: 'p', dependencies: { [PKG]: `file:${src}` } })
  mkdirSync(copyDir(profile), { recursive: true })

  const r = inspectProfile(profile)
  assert.equal(r.verdict, 'empty-copy')
  assert.match(r.why, /空的|一半/)
  assert.equal(r.sourceVersion, '1.1.1')
  // 文案里得是真实路径，不然让人去删一个不存在的目录
  assert.match(r.why, /@ssamurias/)
})

test('副本只落了一半文件（版本号还在）→ 仍判 empty-copy', () => {
  const root = tmp()
  const src = join(root, 'src')
  const profile = join(root, 'profiles', 'desktop')
  writePkg(src, { name: PKG, version: '1.1.1' })
  fillJs(src, 20)
  writePkg(profile, { name: 'p', dependencies: { [PKG]: `file:${src}` } })
  writePkg(copyDir(profile), { name: PKG, version: '1.1.1' })
  fillJs(copyDir(profile), 3)

  const r = inspectProfile(profile)
  assert.equal(r.verdict, 'empty-copy')
  assert.equal(r.copyJs, 3)
})

test('源目录换了新版、副本还是旧的 → stale-copy', () => {
  const root = tmp()
  const src = join(root, 'src')
  const profile = join(root, 'profiles', 'desktop')
  writePkg(src, { name: PKG, version: '1.1.1' })
  fillJs(src, 10)
  writePkg(profile, { name: 'p', dependencies: { [PKG]: `file:${src}` } })
  writePkg(copyDir(profile), { name: PKG, version: '1.0.10' })
  fillJs(copyDir(profile), 10)

  const r = inspectProfile(profile)
  assert.equal(r.verdict, 'stale-copy')
  assert.match(r.why, /1\.0\.10/)
})

test('link: 安装不判坏（没有副本这回事）', () => {
  const root = tmp()
  const profile = join(root, 'profiles', 'desktop')
  writePkg(profile, { name: 'p', dependencies: { [PKG]: 'link:D:/x' } })

  const r = inspectProfile(profile)
  assert.equal(r.verdict, 'linked')
  assert.match(r.why, /软链/)
})

test('profile 里没这个包 / 没有 package.json → 不炸', () => {
  const root = tmp()
  const p1 = join(root, 'a')
  writePkg(p1, { name: 'p', dependencies: {} })
  assert.equal(inspectProfile(p1).verdict, 'no-dep')

  const p2 = join(root, 'b')
  mkdirSync(p2, { recursive: true })
  assert.equal(inspectProfile(p2).verdict, 'no-profile')
})

// ↓ 这条是这个 bug 的回归：装的是真名，脚本却一个 profile 都找不出来 → 退出码 2。
test('findProfiles：装的是 @ssamurias/dsh-fish 也能被找到（不再一律退出码 2）', () => {
  const home = tmp('fish-home-')
  writePkg(join(home, 'profiles', 'desktop'), { name: 'p', dependencies: { [PKG]: 'file:D:/x' } })
  writePkg(join(home, 'profiles', 'web'), { name: 'p', dependencies: { other: '1.0.0' } })
  writePkg(join(home, 'profiles', 'whale'), { name: 'p', dependencies: { [LEGACY]: 'file:D:/y' } })

  const found = findProfiles(home).map((d) => d.split(/[\\/]/).pop())
  assert.deepEqual(found.sort(), ['desktop', 'whale'])
})
