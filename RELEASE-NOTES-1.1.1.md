# 1.1.1 · 写入口也认会话 id

1.1.0 发布后收到 issue #179：会话出生在 A、后来用宿主的 `working_directory` 切到 B，之后所有写入口都回「这条调用来自另一个家」。

## 原因

`lib/tenant.js` 的 `callerOf()` 只读 `session.header.cwd`——那是**出生时**的目录。宿主的当前目录在 `workingDirectory` 投影里，换过目录之后 `header.cwd` 不会跟着变。只读工具（`her_recall` / `her_diary` / `her_stance`）不走写入口，所以看起来「只有写东西坏了」。

## 修法

1. 当前目录优先：先问宿主 `workingDirectory.get(session)`，拿不到才回落出生目录；
2. 会话 id 在册就直接放行：`isHerSession` 命中时 cwd 在哪都不影响——她换目录，不等于换了个人。

`look.js` / `sub.js` / `watch.js` 的 `tenancyOf` 与 `use.js` 的记账路径一并透传 `ctx` 与 `isHerSession`；拒绝日志多记一行 `born=`。

## 验证

- 新增 `test/tenant-live-cwd.test.mjs` 6 条；
- 全量 3311 pass / 0 fail（229 个测试文件）；
- `doc-check --actual 3311`、`pack-check` 绿。

## 升级

1.1.0 已发布，这一笔进 1.1.1。升级前如果遇到写入口被拒，先把会话的 `working_directory` 切回出生目录，或者等 1.1.1。
