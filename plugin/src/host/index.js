/**
 * 鱼社 dsh-yushe · 宿主端入口
 *
 * S1（M0）：只做一件事 —— 注册 `GET /api/dsh-yushe/status`，告诉浏览器端「宿主这边有什么」：
 *   - 宿主模型服务 `llm` 在不在（通道 A 能不能用）
 *   - 用户当前默认模型是哪个（provider / model 名字，不含任何密钥）
 *   - 鱼的 B站号登录过没有（只给 true/false，绝不读出凭证内容）
 * 后续里程碑在这里挂：人设注入、AI 网关、鱼生引擎、畅游调度、B站 MCP。
 *
 * 规矩（见仓库根 AGENTS.md）：路由带 dsh-yushe 前缀、只收回环请求；注册都套 ctx.effect，热重载不重复注册。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hostSay, hostModel, SAY_PROMPT, startRoam, roamStatus, logProbe } from './probe.js';
import { createPond } from './pond.js';
import { registerGameRoutes, registerPersona } from './game-routes.js';
import { createLife, snapshot } from './life-engine.js';
import { registerLifeRoutes, registerLifeSection } from './life-routes.js';
import { registerRoomRoutes } from './room-routes.js';
import { initClock, clockSkewed, nowDate } from './clock.js';
import { createWallet, registerWalletRoutes } from './wallet.js';
import { createBili, registerBiliRoutes } from './bili.js';
import { createLetters, registerLetterRoutes } from './letters.js';
import { registerTipsRoutes } from './tips-routes.js';
import { createTrips, registerBagRoutes } from './trips.js';
import { registerPhotoRoute } from './photos.js';
import { createHabits, registerHabitsRoutes } from './habits.js';
import { registerYusheTools, yusheToolDefs, pathsOf, capsOf, draftKindsOf, sendersOf, capKeysOf } from './tools/registry.js';
import { createBiliRead } from './bili-read.js';
import { createBiliWrite } from './bili-write.js';
import { createActs } from './acts.js';
import { createPlanner } from './planner.js';
import { createGate, registerGateRoutes } from './gate.js';
import { createInbox, registerInboxRoutes } from './inbox.js';
import { createDms, registerDmsRoutes } from './dms.js';
import { createOfficial, registerOfficialRoutes } from './official.js';
import { createWorkSessions } from './work-sessions.js';
import { createWorkspaces, registerWorkspaceRoutes } from './workspaces.js';

export const name = 'dsh-plugin-yushe'; // 包名；存档目录、路由前缀仍叫 dsh-yushe（老存档不丢）
// 人设注入要用 systemPrompt（所有带 dsh-base 的 profile 都有）
export const inject = ['systemPrompt'];
export const VERSION = '0.28.1';
export const STATUS_PATH = '/api/dsh-yushe/status';
export const SAY_PATH = '/api/dsh-yushe/probe/say';
export const ROAM_PATH = '/api/dsh-yushe/probe/roam';

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
export const storageDir = () => join(dshHome(), 'storages', 'dsh-yushe');

/** 只认本机回环请求。 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress;
  if (!(address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === undefined)) return false;
  const host = request?.headers?.host;
  if (typeof host !== 'string') return true;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function writeJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

/** 读宿主状态。所有字段都是「有 / 没有 / 名字」，不含任何秘密。 */
export function readStatus(ctx, startedAt) {
  let llm = null;
  try { llm = ctx?.get?.('llm') ?? null; } catch { llm = null; }
  let selection = null;
  try { selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? null; } catch { selection = null; }
  let providers = null;
  try { providers = typeof llm?.listProviders === 'function' ? llm.listProviders().map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean) : null; } catch { providers = null; }
  return {
    ok: true,
    plugin: name,
    version: VERSION,
    startedAt,
    host: {
      llm: Boolean(llm && typeof llm.stream === 'function'),
      providers,
      defaultModel: selection ? { provider: selection.provider || selection.providerId || '', model: selection.model || selection.modelId || '' } : null,
      agents: (() => { try { return Boolean(ctx?.get?.('agents')); } catch { return false; } })(),
    },
    bili: { loggedIn: existsSync(join(storageDir(), 'bili_credential.json')) },
  };
}

export function withFish(status, pond, life, wallet) {
  const f = pond?.current?.();
  const all = pond?.list?.().fish || [];
  let now = null;
  try { if (f && life) { const st = life.state(f); const s = snapshot(st); now = { where: s.where, whereText: s.whereText, moodIcon: s.moodIcon, moodWord: s.moodWord, energy: s.energy, ...life.activity(f, st, wallet?.busy) }; } } catch { now = null; }
  return { ...status, fish: f ? { id: f.id, name: f.name, proto: f.proto, rarity: f.rarity, personality: f.personality, parentCall: f.parentCall, workspace: f.workspace ? { title: f.workspace.title } : null, now } : null, lastFish: all.length ? all[all.length - 1].id : null, pondSize: all.length, clock: { now: nowDate().toISOString(), skewed: clockSkewed() }, wallet: wallet?.view?.() ?? null };
}

export function apply(ctx) {
  const startedAt = new Date().toISOString();
  const log = (() => { try { return ctx.logger?.('dsh-yushe'); } catch { return undefined; } })();

  initClock(storageDir());
  const wallet = createWallet(ctx, storageDir());
  const bili = createBili(storageDir());
  const pond = createPond(storageDir());
  const life = createLife(storageDir());
  const habits = createHabits(storageDir(), { caps: capsOf() }); // 两层配置：工具声明的上限也并进细配置（F-59）
  // 接口白名单 = 宿主自己用的 + 工具表里声明的（F-59：加工具不用改 bili-read / bili-write）
  const biliRead = createBiliRead(storageDir(), fetch, { extraPaths: pathsOf('GET'), budget: () => habits.get().readBudget }); // 每天读多少次 = 细配置 readBudget
  const biliWrite = createBiliWrite(storageDir(), fetch, { sign: (p) => biliRead.signQuery(p), blocked: () => biliRead.blocked(), extraPaths: pathsOf('POST') }); // 发私信要 WBI 签名；风控期间不发（G3）
  const letters = createLetters({ life, wallet, pond, log, habits });
  const planner = createPlanner({ life, wallet, pond, log });
  const gate = createGate({ storage: storageDir(), life, habits, biliRead, biliWrite, log, kinds: draftKindsOf(), senders: sendersOf(), capKeys: capKeysOf() }); // 说话工具声明的类型 / 发法 / 上限（任务 50）
  const acts = createActs({ storage: storageDir(), habits, life, gate, pond, log }); // 互动账本（任务 49）：上限、对同一个人上限、她自己关注的名单、回执 → 足迹
  gate.usePerson(acts); // G4：说话也算进「对同一个人每天上限」
  const inbox = createInbox({ storage: storageDir(), life, biliRead, gate, log });
  const official = createOfficial({ storage: storageDir(), biliRead, biliWrite, life, pond, version: VERSION });
  const dms = createDms({ storage: storageDir(), life, wallet, habits, biliRead, gate, log });
  const trips = createTrips({ life, wallet, pond, storage: storageDir(), log, habits, biliRead, gate });
  const toolDeps = { pond, life, wallet, habits, trips, log, biliRead, biliWrite, inbox, dms, gate, acts };
  registerYusheTools(ctx, toolDeps);
  // 任务 51：出门 = 她自己调工具（同一张工具表的「出门」出口，带读账给 G2 证据检查）；宿主模型拿不到就走 headless 老路
  trips.useLoop({ tools: (ledger) => yusheToolDefs({ ...toolDeps, ledger }, { from: 'trip' }), model: () => hostModel(ctx) });
  // 回家了：给爸妈写封信（出门回来这个由头）
  life.onTripBack = (f, back) => {
    // 回家：这趟想发的评论 / 动态交给闸门，过了就寄到信箱等爸妈批准（M5b）
    try { if (back.trip.wantComment) gate.propose(f, { kind: 'comment', text: back.trip.wantComment.text, target: back.trip.wantComment.target }); if (back.trip.wantPost) gate.propose(f, { kind: 'post', text: back.trip.wantPost }); } catch { /* 不影响回家 */ }
    if (!back.trip.failed) letters.maybe(f, 'trip', `【这趟看到的】\n${(back.trip.seen || []).slice(0, 6).map((x) => `- ${x.title}`).join('\n')}\n【明信片上写的】${String(back.trip.postcard || '').slice(0, 200)}`); };
  // 她自己决定要不要出门：DSH 开着时每 10 分钟问一次（也顺手推进寄明信片 / 回家）
  ctx.effect(() => { const t = setInterval(() => { try { trips.autoTick(); } catch (e) { log?.warn?.(`[dsh-yushe] autoTick: ${e?.message || e}`); } gate.flush(pond.current() || pond.list().fish.at(-1)).catch(() => {}); planner.tick(pond.current() || pond.list().fish.at(-1)).catch(() => {}); inbox.poll(pond.current() || pond.list().fish.at(-1)).catch(() => {}); dms.poll(pond.current() || pond.list().fish.at(-1)).catch(() => {}); }, 10 * 60_000); return () => clearInterval(t); }, 'dsh-yushe: wander timer');
  // DSH 的工作区表（她在哪个工作区上工，F-64）：有就拿，没有（老宿主）就当「所有工作区」
  let wsRegistry = null;
  if (typeof ctx.inject === 'function') { try { ctx.inject(['workspaceRegistry'], (scope) => { wsRegistry = scope.workspaceRegistry; scope.effect(() => () => { wsRegistry = null; }, 'dsh-yushe: workspace registry'); }); } catch { /* 没有工作区服务 */ } }
  const workspaces = createWorkspaces({ getRegistry: () => wsRegistry });
  const work = createWorkSessions({ ctx, pond, life, log }); // 哪些对话是爸妈开的 + 干了几次活（F-63）
  const personaOrder = registerPersona(ctx, pond, life, work);
  if (personaOrder !== null) registerLifeSection(ctx, pond, life, personaOrder, work);
  log?.info?.(`人设段落 yushe:persona + 近况 yushe:life ${personaOrder !== null ? '已注册' : '未注册（没有 systemPrompt）'}；当前鱼：${pond.current()?.name ?? '无'}`);

  if (typeof ctx.inject !== 'function') {
    log?.warn?.('宿主不支持 ctx.inject，status 路由未注册');
    return;
  }
  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: async (request, response) => {
          if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: 'loopback requests only' });
          if ((request.method ?? 'GET') !== 'GET') return writeJson(response, 405, { ok: false, error: 'method not allowed' });
          writeJson(response, 200, withFish(readStatus(ctx, startedAt), pond, life, wallet));
        },
      }),
      'dsh-yushe: status route',
    );

    registerGameRoutes({ ctx, scope, pond, storage: storageDir(), isLoopbackRequest, writeJson, life, wallet, workspaces });
    registerWorkspaceRoutes({ scope, pond, workspaces, isLoopbackRequest, writeJson });
    registerLifeRoutes({ ctx, scope, pond, life, wallet, letters, gate, inbox, dms, storage: storageDir(), isLoopbackRequest, writeJson });
    registerRoomRoutes({ ctx, scope, pond, life, wallet, letters, trips, planner, storage: storageDir(), isLoopbackRequest, writeJson });
    registerBagRoutes({ scope, pond, life, isLoopbackRequest, writeJson });
    registerPhotoRoute({ scope, storage: storageDir(), isLoopbackRequest, writeJson });
    registerHabitsRoutes({ scope, habits, isLoopbackRequest, writeJson });
    registerGateRoutes({ scope, pond, gate, isLoopbackRequest, writeJson });
    registerInboxRoutes({ scope, pond, inbox, isLoopbackRequest, writeJson });
    registerDmsRoutes({ scope, pond, dms, isLoopbackRequest, writeJson });
    registerOfficialRoutes({ scope, official, isLoopbackRequest, writeJson });
    registerLetterRoutes({ scope, pond, life, isLoopbackRequest, writeJson });
    registerTipsRoutes({ scope, pond, life, storage: storageDir(), isLoopbackRequest, writeJson });
    registerWalletRoutes({ scope, wallet, isLoopbackRequest, writeJson });
    registerBiliRoutes({ scope, bili, isLoopbackRequest, writeJson });

    // S2：宿主模型流式说一句。NDJSON：{type:'delta',text}… 最后 {type:'done',…} 或 {type:'error',…}
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: SAY_PATH,
        handler: async (request, response) => {
          if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: 'loopback requests only' });
          if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' });
          response.statusCode = 200;
          response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
          response.setHeader('cache-control', 'no-store');
          const send = (o) => response.write(JSON.stringify(o) + '\n');
          try {
            const r = await hostSay(ctx, SAY_PROMPT, (text) => send({ type: 'delta', text }));
            logProbe(storageDir(), { kind: 'say', ms: r.ms, provider: r.provider, model: r.model, usage: r.usage, chars: r.text.length });
            try { wallet.chargeTokens('probe', r.usage?.totalTokens || 0); } catch { /* 探针记账失败不影响 */ }
            send({ type: 'done', ...r });
          } catch (e) {
            logProbe(storageDir(), { kind: 'say', error: String(e?.message || e) });
            send({ type: 'error', error: String(e?.message || e) });
          }
          response.end();
        },
      }),
      'dsh-yushe: probe say route',
    );

    // S3：headless 只读畅游一轮。POST 起任务返回 id；GET ?id= 查进度和结果
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: ROAM_PATH,
        handler: async (request, response) => {
          if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: 'loopback requests only' });
          if (request.method === 'POST') {
            try { return writeJson(response, 200, { ok: true, id: startRoam(storageDir()) }); }
            catch (e) { return writeJson(response, 500, { ok: false, error: String(e?.message || e) }); }
          }
          if (request.method === 'GET') {
            const id = new URL(request.url || '', 'http://x').searchParams.get('id') || '';
            const s = roamStatus(id);
            return s ? writeJson(response, 200, { ok: true, ...s }) : writeJson(response, 404, { ok: false, error: '没有这个任务' });
          }
          return writeJson(response, 405, { ok: false, error: 'method not allowed' });
        },
      }),
      'dsh-yushe: probe roam route',
    );
  });
  log?.info?.(`鱼社 ${VERSION} 已加载`);
}
