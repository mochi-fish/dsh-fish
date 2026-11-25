# 1.1.2 · 换房之后那页交接，经桥说话的人终于看得到

1.1.1 发布后收到报告：换房后 `home.json` 里的 `carry` 生成得好好的，可交接页从没摆出来过，`carry` 也从没被清。

## 现象

- 四次换房、11 个会话里，「上次停在这」一次都没出现；
- 日志四周零条「交接页没进这一轮的上下文」；
- 手动调 `armHandoffFor(root, sid)` 返回 `true`——数据是齐的，缺的是真机那次调用。

## 原因

报告猜的是 `sessionIdOf(agent)` 取到空串。不是那条：真取到空串的话 `armHandoffFor` 反而不会 arm，也就没有日志——可它也解释不了「`carry` 从不被清」和「11 个会话零命中」。

根子在**投递路**：`armHandoffFor` 全库只有一个调用点（`lib/turns.js:933`），挂在 `onHuman` 里。而 `/say` 的 `prompt()` 带 `requestId: say-…`，宿主播进 `source.rpcId` 之后，`classifyMessage()` 先撞上 `PLUGIN_RPC`（`^say-`）判成 `plugin`，走不到 `kind === 'user'` 那条人判据——`onHuman` 一次都不执行。

`seen:` 和轮数由 `say.js` 自己写，所以别处看起来一切正常；只有交接页这一条链路是死的。**任何经桥说话的人都不生效**，不是某一台机器的特例。

## 修法

`lib/say.js` 自己认领、自己结账：

1. 递进去之前（`prompt` 之前）——书房、他本人、有正文时调 `armHandoffFor(root, sessionId)`；
2. 这一轮结完照 `turns.js:1173-1183` 的口径收：她真读到了（`handoffShown`）才清 `carry`，没读到就留着下一轮再摆，并记一行 `say · 交接页没进这一轮的上下文，carry 留着下一轮再摆`；
3. 群聊、外客不摆——那不是他回书房。

`classifyMessage` 的 `plugin` 判定一个字没动：`/say` 确实不是他亲手打的字，只是交接页必须跟着「他开口了」走，而不是跟着「谁把这句话递进来」走。

## 验证

- `test/channels.test.mjs` 新增 3 条：`prompt` 那一刻必须已经 arm；读到了结完就清 `carry`；群聊不摆、`carry` 原样留着；
- 全量 **3328 pass / 0 fail**（230 个测试文件）；
- `doc-check --actual 3328`、`pack-check`（244 个文件 3.1 MB）绿。

## 升级

1.1.1 已发布，这一笔进 1.1.2。升级后：换过房的第一句（经桥投递的也算）会看到她上一间屋子的最后几句；她读到之后 `carry` 当轮清掉，不会每轮都摆。
