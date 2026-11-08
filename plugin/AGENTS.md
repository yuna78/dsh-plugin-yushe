# plugin/AGENTS.md · dsh-yushe 插件包

> 上级规矩见仓库根 `AGENTS.md`。这里只放改插件必须知道的机器事实。

## 结构

| 路径 | 是什么 |
|---|---|
| `src/host/index.js` | 宿主端入口（Node，`export apply(ctx)`）。路由、人设注入、AI 网关、鱼生引擎、B站 MCP 都从这里挂 |
| `src/client/index.js` | 浏览器端入口（`export default { inject, apply }`），React 由宿主 `require('react')` 提供。注册：左侧栏 `sidebar.panellist` + `main` 面板（主入口）、`shell.overlay`、`conversation.hero.options`、`settings.section` |
| `src/shared/` | 规则核心（`core.js` 抽卡 / `life.js` 200 点·性格·身世·人设渲染），宿主和游戏共用 |
| `src/host/pond.js` · `game-routes.js` · `probe.js` · `sources.js` | 鱼塘与领养校验；游戏 / 领养 / 第一句 / 打招呼路由 + 人设段落；AI 探针；畅游素材预取 |
| `src/host/life-engine.js` · `life-routes.js` | 日常：作息 / 心情精力懒结算 / 事件 / 聊天 / 日记 / 干活计数；聊天、喂食、日记路由 + 近况段落 `yushe:life` |
| `src/host/clock.js` · `wallet.js` | 开发时钟（**所有「现在」走 `nowMs()/nowDate()`，别直接 `Date.now()`**）；钱包：她自己的 AI 调用一律 `wallet.say(kind, …)`，花光抛 `BrokeError`，调用方回落规则台词 |
| `src/shared/allowance.js` · `room.js` | 零花钱纯函数；房间规则：`activityOf` 三态、`poseFor` 动作库回落、`goOutAnswer` 问出门 |
| `src/host/bili.js` | 她的 B站号：扫码登录路由（生成 SVG 二维码、轮询、存凭证 600）、登录状态（只回昵称 / UID / 等级）、退出 |
| `src/shared/mood.js` · `src/host/letters.js` | 心情口气 / 聊天信号 `<sig>`（流式过滤 `sigFilter`）/ 精力规则 / 写信由头；信箱：`letters.maybe(fish, kind)` 后台写信，走钱包 |
| `src/shared/growth.js` | 成长层纯函数：`gainXp` / `dailyTick`（爱好降温、五维此消彼长、性格 3 天稳定才转）/ `feedInterests` / `leanOnce` / `growthView` / `personaFor`（人设跟着长）。life-engine 的 `life.grow(fish, fn)` 改成长层 |
| `src/shared/tips.js` · `src/host/tips-routes.js` | 小贴士（`when(ctx)` 决定时机）+ 说明书 `KB`；**只写现在真能做到的**，新功能上线时顺手补贴士和说明书 |
| `src/shared/trip.js` · `src/host/trips.js` | 闲逛：`wantsToLeave` / `tripPlan` / `souvenirsFor` / 装备；宿主 `trips.start(fish, 'asked'|'self')` + 10 分钟定时器 `autoTick`；寄明信片 / 回家在 `life-engine.tickTrip`（读状态时推进） |
| `src/shared/photo.js` · `src/host/photos.js` | 相册照片：规则拼提示词（`LOOKS` × 场景 × 装备）→ 用户的生图 API → 存 `<storage>/photos/`，`/api/dsh-yushe/photo/<id>` 取；**prefix 路由不许带结尾斜杠**（DSH 按 `prefix + '/'` 匹配） |
| `src/shared/homes.js` | 她的家：10 间房（`HOMES`），背景图 `美术/assets/bg/<id>.webp`，鱼记录里的 `home` 字段；新增房间：加一行 + 出图（`美术/出图/prompts/room-<id>.txt`） |
| `src/shared/habits.js` · `src/host/habits.js` | 上网习惯 = 两层配置（F-59）：`HABIT_FIELDS`（`ui` = 设置页能改，`chat` = 聊天能改，`max` 就是硬顶）+ `KNOBS` 三个档位（按细项反推档位，对不上 = 自定义）；工具声明的 `cap` 由 `schemaWith` 并进来。聊天改走 `propose`（不写）→ `apply(proposalId)` |
| `src/host/tools/` | **工具表（F-59）：一个工具一个文件** `tools/<self|read|act|speak>/<名字>.js`，导出 `defineTool({...})`（约定见 `define.js`.md`）。`_all.js` 由 `npm run build` 生成（勿手改），`registry.js` 汇总后分给主会话（`ctx.inject(['tools'])` 注册成品定义）和出门循环，并生成 B站接口白名单。**加工具 = 加文件，不改 bili-read / bili-write / 别的工具**；verify 跑 `checkTools` 自检 |
| `src/host/account.js` | 换号不继承（G5）：和她 B站号有关的账本存在 `<storage>/bili/<mid>/`（私信、收件箱进度…） |
| `src/host/bili-read.js` | 她的 B站（只读）：WBI 签名（`wbiSign`，文档例子在 verify 里）、首页推荐 / 搜索 / 详情 / 热门评论 / UP 主投稿 / 热门；只走白名单路径；每天 300 次预算、风控码退避 30 分钟；外部标题 `stripEmoji` |
| `src/shared/plan.js` · `src/host/planner.js` | 她每天的打算（`planPrompt` → `validatePlan`，不合格 `templatePlan`）+ `diaryDue`；`planner.ensure`（醒着、今天没打算就写）/ `planner.tick`（宿主 10 分钟定时器，23:30 写日记，走 life-routes 的 `writeDiary`） |
| `src/shared/inbox.js` · `src/host/inbox.js` | 收件箱：`whatToFetch`（省读次数）→ `mergeInbox`（按 id 去重，第一次只记不刷屏）→ `newsEvents`（一类一条进「今天」）、`footStats`（足迹的赞 / 回复）；宿主定时器 `inbox.poll` 一小时一次、醒着才看；路由 `/inbox`（GET 看、POST `{seen}` / `{refresh}`） |
| `src/shared/dm.js` · `src/host/dms.js` | 私信 + 爸妈专线：`pendingTalkers`（只回真人、对方先说的）→ `newTexts` → `dmPrompt`（陌生人不给近况、可以 `（不回）`；专线带近况）→ `parseDmReply` → `gate.propose(kind 'dm')`；20 分钟一次，第一次只记进度；发私信 `bili-write.dm`（WBI 签名器来自 `bili-read.signQuery`） |
| `src/host/room-routes.js` | 房间快捷动作：念新闻（NDJSON）/ 摸头 / 日程 / 冲浪（headless，回来明信片进相册）/ 相册 / 生图 API 设置（key 存 `<storage>/image-api.json`，GET 只回打码尾巴） |
| `src/game/` | iframe 里的游戏：`index.html` + `main.js`（流程）+ `scene.js`（Pixi）+ `story/*.ink`（剧本） |
| `game/` | 游戏构建产物（**进 git**）：`game.js` 带内容哈希引用，立绘和字体拷进 `assets/` |
| `scripts/build.mjs` | esbuild：host → `lib/index.js`（ESM），client → `lib/client.js`（包进 `window.__ModuleLoader__.load`） |
| `lib/` | 构建产物，**进 git**（`link:` 安装直接读它，不跑构建） |
| `verify/run.mjs` | `npm run verify` 的实现 |
| `cordis.patch.yml` | 插进 profile 插件树的那一行（id `yushe`） |

## 宿主事实

- 注册类调用套 `ctx.effect(() => …, '说明')`，否则热重载 / 停用会重复注册而抛错。
- `webServer` 用 `ctx.inject(['webServer'], scope => …)` 拿；`/api/*` 的 exact 路由**绕过 cookie 鉴权**，所以每个 handler 自己判 `isLoopbackRequest`。
- 路由路径一律 `/api/dsh-yushe/*`；重复注册同路径会直接抛错。
- 宿主产物是 ESM，打进来的 CommonJS 依赖（如 `qrcode`）要靠构建 banner 里的 `createRequire` 垫片才能 `require('fs')`——别删。
- 宿主模型：`ctx.get('llm').stream({provider, model, messages, tools: []})`；默认模型 `ctx.get('agentDefaultModel').currentSelection()`。
- 段落 `systemPrompt.section({ name, text: fn, interpolate: false })`，text 返回 `''` 就被宿主过滤（最安全的闭嘴方式）。
- 可选 slot 用 `ctx.slots.inject(name, …)` 探测，没有就不渲染；不要按版本号判断。
- 游戏 iframe 发 `postMessage({type:'dsh-yushe:work'})` → 浏览器端用 `uiWorkspace.startSession(undefined, {prompt})` 在最近工作区开原生会话；`dsh-yushe:close` 关浮层。
- **不许 emoji**：游戏里用 `ICON('名字')`（main.js）、DSH 侧用 `Ic('名字')`（client），图在 `美术/assets/icons/`；宿主返回图标名（如日程 `icon: 'rice'`、心情 `moodIcon: 'mood4'`），不返回 emoji。新图标：`美术/出图/prompts/icons-*.txt` 出 3×3 表 → `slice_icons.py` 切。
- 样式走 `--dsw-alias-*` token 并给浅色兜底，暗色下别写死颜色。

## 在 DSH 里测

```bash
npm run build                                   # 改完 src 先构建（或 npm run build:watch）
dsh plugin --profile yushe-dev add "link:$PWD/plugin"   # 只需一次
dsh --profile yushe-dev                          # 起实例，浏览器打开它打印的地址 → 设置 → 鱼社
npm run smoke                                    # 打 status 路由（端口见 AGENTS.local.md）
```

改宿主端代码后要重启实例；只改浏览器端刷新页面即可。

测夜里 / 白天：`echo '{"now":"2026-11-07T14:00"}' > ~/.dsh/storages/dsh-yushe/dev.json`（房间右上角出现 ⏰），**测完删掉**；测出来的假日期事件记得清掉。
