# AGENTS.md · 鱼社 dsh-plugin-yushe

> ⚠️ **这是发版仓库的只读副本**，由私有开发仓库的导出脚本生成并整份覆盖。
> **不要在这里开分支、改代码、提 PR**——改动会在下次导出时丢失。
> 要改东西：到开发仓库 `yuna78/dsh-yushe` 提交；发版与合并由维护者统一执行。

> 给来改代码的人和 AI agent 看的。先读 [`docs/北极星.md`](docs/北极星.md)：目标、原则、约束、不做什么。

## 两套身份（别混）

| 身份 | 怎么判断 | 听谁的 |
|---|---|---|
| **开发者** | 改 `plugin/`、`美术/`、`docs/`、`tools/` | 本文件 + `plugin/AGENTS.md` + 验证阶梯 |
| **鱼（运行时）** | DSH 系统提示里的她、headless 出门的她 | 插件注入的人设和工具契约。用户机器上没有本文件，别往这里写运行时规则 |

## 不可违反

- **AI 管表达，规则管结果**：稀有度、五维、成长、奖励、出门时长由可复现规则决定，不交给模型。
- **对外发声过闸门**：评论 / 私信 / 动态，模型只写草稿，宿主端闸门决定（内容规矩 + 发言间隔 + 每天上限）；不绕过闸门、不伪造平台回执、超时不重试。
- **凭证**：B站只走扫码；不打印、不提交、不贴进对话；对外发声的上下文里不放用户主会话内容。
- **只用宿主公开服务**（`llm`、`agentDefaultModel`、`systemPrompt`、`webServer`、`slots`、`tools`、`workspaceRegistry`…）；路由一律带 `dsh-yushe` 前缀且只收本机回环请求。
- 不复刻任何现成游戏的名字、美术、角色；游戏里不用 emoji。
- 仓库里不放本机绝对路径、凭证、真实网友数据。

## 先读什么

| 你要做的事 | 先读 |
|---|---|
| 改插件（宿主端 / 浏览器端） | [`plugin/AGENTS.md`](plugin/AGENTS.md) |
| 改玩法 / 数值 | [`docs/设计/04-放养玩法拆解.html`](docs/设计/04-放养玩法拆解.html)、[`docs/设计/06-成长与闲逛.md`](docs/设计/06-成长与闲逛.md) |
| 改美术 | [`美术/PROVENANCE.md`](美术/PROVENANCE.md) |

## 验证阶梯（改完必跑）

```bash
npm install
npm run build     # esbuild：plugin/lib/index.js（宿主）+ plugin/lib/client.js（浏览器）+ plugin/game/
npm run verify    # 纯函数 + 契约 + 构建产物 + 脱敏，秒级，不要网络
npm run smoke     # 打本机 DSH 实例的 /api/dsh-yushe/status（实例要先跑起来）
```

## 修改纪律

1. 一个改动一个分支，PR 合回 `main`；提交信息说清楚「为什么」。
2. 每一步只交能在 DSH 里点到的东西；界面改动带截图。
3. 改动和北极星冲突的，先开 issue。
