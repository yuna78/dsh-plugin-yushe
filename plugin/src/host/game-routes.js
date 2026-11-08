/**
 * M2 · 出生：鱼塘、领养、破壳第一句、游戏静态文件。
 *
 *   GET  /api/dsh-yushe/pond          鱼塘概况（当前鱼 + 列表摘要）
 *   POST /api/dsh-yushe/adopt         {spec} → 校验、渲染人设、落盘、设为当前
 *   POST /api/dsh-yushe/current       {id|null} → 切换 / 关掉上工的鱼
 *   POST /api/dsh-yushe/first-words   {spec} → 宿主模型现写破壳第一句（NDJSON 流式；失败回落模板）
 *   POST /api/dsh-yushe/greet         房间里打招呼：当前鱼的人设 + 宿主模型现写一句（NDJSON）
 *   GET  /api/dsh-yushe/game/*        游戏页面与资源（plugin/game/，构建产物）
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFish } from './pond.js';
import { hostSay, logProbe } from './probe.js';
import { nowDate } from './clock.js';
// 提示词本体在 src/prompts/first.md、greet.md（F-80 搬家-2b）：这里只准备变量再 fill
import { fill } from '../shared/prompt.js';
import PROMPTS from '../prompts/_all.js';
import { firstWords } from '../shared/life.js';
import { personaFor } from '../shared/growth.js';

export const POND_PATH = '/api/dsh-yushe/pond';
export const ADOPT_PATH = '/api/dsh-yushe/adopt';
export const CURRENT_PATH = '/api/dsh-yushe/current';
export const FIRST_WORDS_PATH = '/api/dsh-yushe/first-words';
export const GAME_PATH = '/api/dsh-yushe/game';
export const GREET_PATH = '/api/dsh-yushe/greet';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };
// 构建后 host 在 plugin/lib/index.js，游戏在 plugin/game/
export const gameDir = () => join(dirname(fileURLToPath(import.meta.url)), '..', 'game');

/** 破壳第一句的提示词（本体在 prompts/first.md，搬家-2b）。 */
export function firstPrompt({ persona, call }) {
  return fill(PROMPTS.first, { persona: persona || '', call });
}

/** 房间里打招呼的提示词（本体在 prompts/greet.md，搬家-2b）。working：她刚在 DSH 里干完活。 */
export function greetPrompt({ persona, call, when, working }) {
  return fill(PROMPTS.greet, {
    persona: persona || '', call, when,
    working: working ? '刚在 DSH 里帮 TA 干完活' : '今天在家歇着',
  });
}

export function readJsonBody(request, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    request.on('data', (c) => { size += c.length; if (size > limit) { request.destroy(); resolve(undefined); } else chunks.push(c); });
    request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(undefined); } });
    request.on('error', () => resolve(undefined));
  });
}

/** 把请求路径映射到 game 目录里的文件；越界返回 null。 */
export function resolveGameFile(urlPath, root = gameDir()) {
  let rel = decodeURIComponent(String(urlPath || '').split('?')[0]).slice(GAME_PATH.length).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  const full = normalize(join(root, rel));
  if (!(full === root || full.startsWith(root + sep))) return null;
  return full;
}

const summary = (f) => f && { id: f.id, name: f.name, proto: f.proto, rarity: f.rarity, personality: f.personality, parentCall: f.parentCall, firstWords: f.firstWords, story: f.story, pts: f.pts, cast: f.cast, seed: f.seed, createdAt: f.createdAt, home: f.home || 'cyberroom', workspace: f.workspace || null };

export function registerGameRoutes({ ctx, scope, pond, storage, isLoopbackRequest, writeJson, life, wallet, workspaces = null }) {
  const guard = (request, response, method) => {
    if (!isLoopbackRequest(request)) { writeJson(response, 403, { ok: false, error: 'loopback requests only' }); return false; }
    if (method && request.method !== method) { writeJson(response, 405, { ok: false, error: 'method not allowed' }); return false; }
    return true;
  };
  const reg = (path, kind, handler, label) => scope.effect(() => scope.webServer.register({ kind, path, handler }), `dsh-yushe: ${label}`);

  reg(POND_PATH, 'exact', async (req, res) => {
    if (!guard(req, res, 'GET')) return;
    const p = pond.list();
    writeJson(res, 200, { ok: true, current: summary(pond.current()), fish: p.fish.map(summary) });
  }, 'pond route');

  reg(ADOPT_PATH, 'exact', async (req, res) => {
    if (!guard(req, res, 'POST')) return;
    const body = await readJsonBody(req);
    if (!body) return writeJson(res, 400, { ok: false, error: '请求格式不对' });
    try {
      let fish = pond.adopt(body.spec);
      // 领养时挑的工作区（F-64）：只认 DSH 里真有的；没挑 / 挑「所有工作区」就是 null
      const ws = body.spec?.workspaceId && workspaces ? workspaces.resolve(body.spec.workspaceId) : null;
      if (ws) fish = pond.setWorkspace(fish.id, ws);
      writeJson(res, 200, { ok: true, fish: summary(fish), personaChars: fish.personaText.length });
    } catch (e) { writeJson(res, 200, { ok: false, error: String(e?.message || e) }); }
  }, 'adopt route');

  reg(CURRENT_PATH, 'exact', async (req, res) => {
    if (!guard(req, res, 'POST')) return;
    const body = await readJsonBody(req);
    try { writeJson(res, 200, { ok: true, current: summary(pond.setCurrent(body?.id ?? null)) }); }
    catch (e) { writeJson(res, 200, { ok: false, error: String(e?.message || e) }); }
  }, 'current route');

  reg(FIRST_WORDS_PATH, 'exact', async (req, res) => {
    if (!guard(req, res, 'POST')) return;
    const body = await readJsonBody(req);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    const send = (o) => res.write(JSON.stringify(o) + '\n');
    let fish;
    try { fish = buildFish(body?.spec, { firstEgg: pond.list().fish.length === 0 }); }
    catch (e) { send({ type: 'error', error: String(e?.message || e) }); return res.end(); }
    const call = fish.parentCall;
    const prompt = firstPrompt({ persona: fish.personaText, call });
    try {
      // 破壳第一句不拦（钱花光也说），但照样记账
      const r = wallet ? await wallet.say('first', prompt, (text) => send({ type: 'delta', text }), 45_000, { force: true }) : await hostSay(ctx, prompt, (text) => send({ type: 'delta', text }), 45_000);
      send({ type: 'done', text: r.text, ai: true, ms: r.ms, usage: r.usage });
    } catch (e) {
      // 没有模型 / 出错：回落到规则模板，保证破壳这一刻不卡住
      send({ type: 'done', text: firstWords(fish.pts, call), ai: false, error: String(e?.message || e) });
    }
    res.end();
  }, 'first-words route');

  // 房间里「跟她打个招呼」：当前鱼的人设 + 宿主模型现写一句（NDJSON 流式；失败回落她的第一句）
  reg(GREET_PATH, 'exact', async (req, res) => {
    if (!guard(req, res, 'POST')) return;
    const f = pond.current() || pond.list().fish.at(-1);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    const send = (o) => res.write(JSON.stringify(o) + '\n');
    if (!f) { send({ type: 'error', error: '还没有鱼' }); return res.end(); }
    try { life?.record(f, 'greet', `${f.parentCall}来家里看你，打了个招呼`, { mood: 2, visit: true }); } catch { /* 不影响打招呼 */ }
    const hour = nowDate().getHours();
    const when = hour < 6 ? '深夜' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
    const prompt = greetPrompt({ persona: f.personaText, call: f.parentCall, when, working: Boolean(pond.current()) });
    try {
      const r = await wallet.say('greet', prompt, (text) => send({ type: 'delta', text }), 45_000);
      send({ type: 'done', text: r.text, ai: true });
    } catch (e) {
      send({ type: 'done', text: e?.broke ? `${f.parentCall}，你来啦！（零花钱花光了，本鱼省着点说话～）` : (f.firstWords || `${f.parentCall}，你来啦！`), ai: false, error: String(e?.message || e) });
    }
    res.end();
  }, 'greet route');

  reg(GAME_PATH, 'prefix', async (req, res) => {
    if (!guard(req, res, 'GET')) return;
    const file = resolveGameFile(req.url || '');
    if (!file || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end('not found'); }
    res.statusCode = 200;
    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    res.setHeader('cache-control', extname(file) === '.html' ? 'no-store' : 'max-age=300');
    res.end(readFileSync(file));
  }, 'game static route');
}

/** 人设段落：当前上工的鱼的人设；没有鱼就返回空串（宿主会过滤掉，最安全的闭嘴方式）。 */
export function registerPersona(ctx, pond, life, work = null) {
  if (!ctx.systemPrompt?.section) return null;
  let order = 0;
  try { const o = ctx.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX'); if (Number.isFinite(o)) order = o; } catch { /* 默认 0 */ }
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'yushe:persona',
    order,
    text: (context) => {
      const f = pond.current();
      if (!f) return '';
      // 只在爸妈自己开的对话里出现；干了几次活改成按爸妈发的消息数（work-sessions.js，F-63）
      if (work && !work.inUserSession(context)) return '';
      // 人设跟着她长：用现在的五维重新渲染 + 「最近的你」；出错就用领养时的原文
      try { return personaFor(f, life?.state(f)?.growth) || f.personaText || ''; } catch { return f.personaText || ''; }
    },
    interpolate: false,
  }), 'dsh-yushe: persona section');
  return order;
}
