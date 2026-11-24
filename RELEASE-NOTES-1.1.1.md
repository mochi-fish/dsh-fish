# 1.1.1 · 写入口也认会话 id，尺子也认得装了鱼

1.1.0 发布后收到 issue #179：会话出生在 A、后来用宿主的 `working_directory` 切到 B，之后所有写入口都回「这条调用来自另一个家」。

## 原因

`lib/tenant.js` 的 `callerOf()` 只读 `session.header.cwd`——那是**出生时**的目录。宿主的当前目录在 `workingDirectory` 投影里，换过目录之后 `header.cwd` 不会跟着变。只读工具（`her_recall` / `her_diary` / `her_stance`）不走写入口，所以看起来「只有写东西坏了」。

## 修法

1. 当前目录优先：先问宿主 `workingDirectory.get(session)`，拿不到才回落出生目录；
2. 会话 id 在册就直接放行：`isHerSession` 命中时 cwd 在哪都不影响——她换目录，不等于换了个人。

`look.js` / `sub.js` / `watch.js` 的 `tenancyOf` 与 `use.js` 的记账路径一并透传 `ctx` 与 `isHerSession`；拒绝日志多记一行 `born=`。

## 验证

- 新增 `test/tenant-live-cwd.test.mjs` 6 条；
- 全量 3316 pass / 0 fail（229 个测试文件）；
- `doc-check --actual 3316`、`pack-check` 绿。

## 升级

1.1.0 已发布，这一笔进 1.1.1。升级前如果遇到写入口被拒，先把会话的 `working_directory` 切回出生目录，或者等 1.1.1。

## 同一版的另一处：QQ 桥每换一次房就掉一次人设

外部报告（DSH 0.2.2-rc.2 + dsh-onebot-qq）：私聊换新会话后她改用第三人称、思考漏进正文。

- **原因**：那座桥不走宿主 prompt()，而是直接 followup(createUserMessage({ source: { kind: 'plugin:dsh-onebot' } }))；1.0.9 的认领门槛要求 kind === 'user'，因此「第一封外面来的信」永远不到，身份段一次都没挂上。老会话只是偶然被一条 kind:'user' 的来信认领过。
- **修法**：isBridgeMessage() 再认两种来路——source.bridge === true（显式契约）、plugin:<插件名>（插件中转，排除 plugin:dsh-fish 与带 fish 标记的）；retry / 空 kind 仍不算。
- **顺手**：seedHerSessions() 原来只认 channels.json 的顶层数组与 .channels，而写盘用的是 { version: 1, list: [...] }——重启后桥的会话 id 全丢。现在三种形状都认。

桥作者若要最稳，投递时带上 source.bridge = true（或保留 plugin:<名字> 的 kind），并把会话建在 ~/.dsh-fish/home。

## 同一版的第三处：`tools/check-install.mjs` 认不出装了哪条鱼

外部报告：新版自带的脚本在这台机器上查不到东西——退出码 2，「没找到装过 dsh-fish 的 profile」，可明明装着。

- **原因**：`readDep()` 把依赖键写死成裸名 `dsh-fish`。0.8.10 起包名是 `@ssamurias/dsh-fish`，profile 里记的也是新名，于是每个 profile 都被判成「没装过」。同一个错假设还有第二处：副本路径按短名拼成 `node_modules\dsh-fish`，而带 scope 的包其实在 `node_modules\@ssamurias\dsh-fish`——依赖名就算认对，也会指着一个不存在的目录，然后报「副本空的」。
- **修法**：包名不再手写，`ownName()` 直接读脚本旁边的 `package.json`；`pkgNames()` 带上裸名给 0.8.9 之前的老 profile；`readDepEntry()` 返回「命中的是哪条依赖键」，副本路径按那个键拼。顺带：`link:` 安装单列一种结论「软链安装（不需要比对副本）」（原来归到「不是这套装法」，看着像出事），「修法」那行写真实路径。
- **为什么之前一直绿**：7 条测试的 fixture 全按短名构造——错的假设同时写在被测物和尺子上。这一轮 fixture 换成真实 scoped 名，并补一条**这条 bug 自己的回归**：`findProfiles()` 在装着 `@ssamurias/dsh-fish` 的 profile 上必须找得到（原来返回空数组 → 退出码 2），另留一条裸名用例守住老装法。7 → 11 条。
- 同一批老路径也改了：`docs/troubleshooting.md` 与 `lib/index.js` 里那条升级 warn（原来让人去删一个不存在的目录）。