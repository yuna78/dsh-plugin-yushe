/**
 * M3 · 回家：她的日常路由 + 近况段落。
 *
 *   GET  /api/dsh-yushe/life          状态快照 + 今天的事 + 最近聊天 + 日记；顺手把缺的往日日记补一篇（后台）
 *   POST /api/dsh-yushe/chat          {text} → 跟她聊天（宿主模型，NDJSON 流式）
 *   POST /api/dsh-yushe/feed          喂零食（规则，不花零花钱）
 *   POST /api/dsh-yushe/diary         {day?} → 让她把（今天的）日记写出来（宿主模型）
 *
 * 近况段落 yushe:life：≤320 字，跟在人设后面；没有上工的鱼就返回空串。
 */
import { nowMs } from './clock.js';
import { readJsonBody } from './game-routes.js';
import { snapshot, lifeSection, dayOf } from './life-engine.js';
import { SIG_INSTRUCTION, sigFilter, parseSignals, sigEvents } from '../shared/mood.js';
import { feelSection, temperOf } from '../shared/feel.js';
import { gainXp, leanOnce, feedInterests, growthView } from '../shared/growth.js';
import { asksAboutGame, kbText } from '../shared/tips.js';
import { nowDate } from './clock.js';
// 提示词本体在 src/prompts/diary.md、chat.md（+「此刻」/ 说明书的可选段，F-80 搬家-2b）：这里只准备变量再 fill
import { fill, DROP, dropLines } from '../shared/prompt.js';
import PROMPTS from '../prompts/_all.js';

export const LIFE_PATH = '/api/dsh-yushe/life';
export const CHAT_PATH = '/api/dsh-yushe/chat';
export const FEED_PATH = '/api/dsh-yushe/feed';
export const DIARY_PATH = '/api/dsh-yushe/diary';

const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);

function diaryPrompt(fish, s, day, life) {
  const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const events = life.eventsOf(s, day).map((e) => `- ${hhmm(e.at)} ${e.text}`);
  const work = s.work?.[day] || 0;
  if (work) events.push(`- 这一天你在 DSH 里帮${fish.parentCall}干了 ${work} 次活`);
  const chats = (s.chat || []).filter((c) => dayOf(new Date(c.at)) === day).slice(-10).map((c) => `${c.role === 'user' ? fish.parentCall : '你'}：${c.text}`);
  return diaryText({ persona: fish.personaText, day, call: fish.parentCall, events, chats });
}

/** 睡前日记的提示词（本体在 prompts/diary.md，搬家-2b）。events / chats：已经拼好的行。 */
export function diaryText({ persona, day, call, events = [], chats = [] }) {
  return dropLines(fill(PROMPTS.diary, {
    persona: persona || '', day, call,
    eventsLine: events.length ? events.join('\n') : DROP,
    quietLine: events.length ? DROP : fill(PROMPTS['diary-quiet'], {}),
    chatsBlock: chats.length ? `\n\n你们聊过的话（节选）：\n${chats.join('\n')}` : '',
  }));
}

/** 鱼社房间聊天的提示词（本体在 prompts/chat.md，搬家-2b）。memoryText / kb 空串 = 不带那一段。 */
export function chatPrompt({ persona, lifeText, sleeping, call, moodText, memoryText = '', history = [], kb = '', text, sig = SIG_INSTRUCTION }) {
  // 可选段「有就连着前后空行一起填，没有就整段不加」，保证和搬家前一字不差；说明书那句在 prompts/chat-kb.md
  const extraBlock = [
    memoryText ? `\n${memoryText}\n` : '',
    history.length ? `\n刚才的对话：\n${history.join('\n')}\n` : '',
    kb ? `\n${fill(PROMPTS['chat-kb'], { call })}\n${kb}\n` : '',
  ].join('');
  return fill(PROMPTS.chat, {
    persona: persona || '', lifeText: lifeText || '', call, text, moodText, sig, extraBlock,
    nowLine: fill(PROMPTS[sleeping ? 'chat-sleep' : 'chat-home'], { call }),
  });
}

/** 她在调工具时页面上显示的一行（F-86 用户审查：别让爸妈对着「…」以为卡住了）。 */
export const TOOL_STATUS = { yushe_seen: '在翻今天的见闻…', yushe_recall: '在想以前的事…', bili_video: '回 B站看那条视频了…', bili_subtitle: '在看那条视频讲了啥…' };

/** 问的是「你看过 / 刷到 / 看到什么」吗（F-86 见闻-2）：是 → 聊天先用工具翻流水账；「今天开心吗」「我爱你」这类家常话不算。 */
const SEEN_RE = /(?:看|刷|逛)(?:了|到|过)?.{0,4}(?:什么|啥)|(?:视频|新闻|B\s*站|见闻)/i;
export function asksAboutSeen(text) {
  return SEEN_RE.test(String(text || ''));
}

/** 房间聊天的工具版提示词（本体在 prompts/chat-tools.md，F-86 见闻-2）：多一个 overview（今天的见闻概览，空就整段不加）。 */
export function chatToolsPrompt({ persona, lifeText, sleeping, call, moodText, memoryText = '', history = [], kb = '', text, overview = '', sig = SIG_INSTRUCTION }) {
  const extraBlock = [
    memoryText ? `\n${memoryText}\n` : '',
    history.length ? `\n刚才的对话：\n${history.join('\n')}\n` : '',
    kb ? `\n${fill(PROMPTS['chat-kb'], { call })}\n${kb}\n` : '',
  ].join('');
  return dropLines(fill(PROMPTS['chat-tools'], {
    persona: persona || '', lifeText: lifeText || '', call, text, moodText, sig, extraBlock,
    overview: overview || DROP, // 今日见闻概览有自己的段（chat-tools.md 的 {{overview}}）；空就整行删
    nowLine: fill(PROMPTS[sleeping ? 'chat-sleep' : 'chat-home'], { call }),
  }));
}

/** 零花钱花光时的日记：规则把今天的事串成流水账（ai: false）。 */
export function ruleDiary(fish, s, day, life) {
  const ev = life.eventsOf(s, day).map((e) => e.text).slice(-6);
  if (!ev.length) return `今天很安静，没什么事。零花钱花光了，本鱼就早点睡啦。${fish.parentCall}晚安。`;
  return `今天${ev.join('，')}。零花钱花光了，日记就先记个流水账吧。${fish.parentCall}晚安。`;
}

/** 写一篇日记（23:30 定时、打开房间补写、点按钮都走这里）：模型写；零花钱花光写流水账。返回 { text, ai, diary }。 */
export async function writeDiary({ wallet, life, memory = null }, fish, day) {
  const s = life.state(fish);
  try {
    const r = await wallet.say('diary', diaryPrompt(fish, s, day, life), null, 60_000);
    const diary = life.putDiary(fish, day, r.text, true);
    // F-76 第二步：写完日记顺便睡前反思（后台，一天一次，不挡日记）
    if (memory?.reflect) memory.reflect(fish, wallet, { day }).catch(() => {}).then(() => memory.summarize?.(fish, wallet, { day })).catch(() => {}); // 反思完写周记 / 章节（三期，后台）
    return { text: r.text, ai: true, diary };
  } catch (e) {
    if (e?.broke) { const text = ruleDiary(fish, s, day, life); return { text, ai: false, broke: true, diary: life.putDiary(fish, day, text, false) }; }
    throw e;
  }
}

export function registerLifeRoutes({ ctx, scope, pond, life, wallet, letters, gate, inbox, dms, memory = null, storage, isLoopbackRequest, writeJson, chatTools = null, seenLog = null }) {
  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) { writeJson(res, 403, { ok: false, error: 'loopback requests only' }); return false; }
    if (method && req.method !== method) { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return false; }
    return true;
  };
  const reg = (path, handler, label) => scope.effect(() => scope.webServer.register({ kind: 'exact', path, handler }), `dsh-yushe: ${label}`);
  const homeFish = () => pond.current() || pond.list().fish.at(-1) || null;
  const ndjson = (res) => { res.statusCode = 200; res.setHeader('content-type', 'application/x-ndjson; charset=utf-8'); res.setHeader('cache-control', 'no-store'); return (o) => res.write(JSON.stringify(o) + '\n'); };

  // 往日日记：打开房间时如果发现「有事发生但没写日记」的过去某天，后台补一篇（一次一篇，不阻塞）
  let writing = false;
  async function backfill(fish) {
    if (writing) return;
    const s = life.state(fish);
    const today = dayOf();
    const days = [...new Set((s.events || []).map((e) => e.day))].filter((d) => d < today && !(s.diary || []).some((x) => x.day === d));
    if (!days.length) return;
    writing = true;
    const day = days.at(-1);
    try { await writeDiary({ wallet, life, memory }, fish, day); } catch { /* 下次再补 */ } finally { writing = false; }
  }

  reg(LIFE_PATH, async (req, res) => {
    if (!guard(req, res, 'GET')) return;
    const f = homeFish();
    if (!f) return writeJson(res, 200, { ok: true, fish: null });
    const s = life.state(f);
    const today = dayOf();
    writeJson(res, 200, {
      ok: true,
      fish: { id: f.id, name: f.name, proto: f.proto, rarity: f.rarity, parentCall: f.parentCall, working: pond.current()?.id === f.id, workspace: f.workspace || null },
      ...snapshot(s), workToday: life.workToday(s, f), ...life.activity(f, s, wallet.busy), wallet: wallet.view(),
      growth: s.growth ? growthView(s.growth, f, { ageDays: Math.max(0, Math.floor((nowMs() - (s.bornAt || nowMs())) / 86400e3)) }) : null,
      bagCount: Object.keys(s.bag?.items || {}).length,
      pendingDrafts: (() => { try { const v = gate ? gate.view() : null; return v ? v.pending.length + v.queued.length : 0; } catch { return 0; } })(),
      inboxUnseen: (() => { try { return (inbox ? inbox.unseen() : 0) + (dms ? dms.unseen() : 0); } catch { return 0; } })(),
      trip: s.trip ? { note: s.trip.note, returnAt: s.trip.returnAt, state: s.trip.state, sent: (s.trip.cards || []).filter((c) => c.sent).length, total: (s.trip.cards || []).length, pcSent: (s.trip.postcards || []).filter((p) => p.sent).length, pcTotal: (s.trip.postcards || []).length, gear: s.trip.gear } : null,
      events: life.eventsOf(s, today).slice(-20),
      chat: (s.chat || []).slice(-20),
      diary: (s.diary || []).slice(-30).reverse(),
    });
    backfill(f);
    // 写信的由头（后台，不阻塞）：心情跌到谷底 / 晚上的感悟
    try { if (snapshot(s).mood < 25) letters?.maybe(f, 'low'); else if (nowDate().getHours() >= 20) letters?.maybe(f, 'reflect'); } catch { /* 不影响 */ }
  }, 'life route');

  reg(CHAT_PATH, async (req, res) => {
    if (!guard(req, res, 'POST')) return;
    const body = await readJsonBody(req);
    const text = cleanText(body?.text, 300);
    const send = ndjson(res);
    const f = homeFish();
    if (!f) { send({ type: 'error', error: '还没有鱼' }); return res.end(); }
    if (!text) { send({ type: 'error', error: '说点什么吧' }); return res.end(); }
    const before = life.state(f);
    const history = (before.chat || []).slice(-12).map((c) => `${c.role === 'user' ? f.parentCall : '你'}：${c.text}`);
    life.pushChat(f, 'user', text);
    const s = life.record(f, 'chat', `和${f.parentCall}聊天：「${text.slice(0, 30)}」`, { mood: 3, visit: true });
    const snap = snapshot(s);
    // F-86 见闻-2：有 wallet.loop + 房间工具 → 聊天走工具循环（先翻流水账再答）；从上面拿的就是「能不能起循环」
    const roomTools = (() => { try { if (typeof wallet?.loop !== 'function') return null; const defs = typeof chatTools === 'function' ? chatTools() : null; return Array.isArray(defs) && defs.length ? defs : null; } catch { return null; } })();
    // F-76：爸妈这句话让她想起的事（本地召回，不花 token）；问到鱼社怎么玩才带说明书（F-42，平常聊天不带，省 token）
    // F-86 见闻-2：问「看了啥」时排掉聊天类经历，不复读她自己的含糊话
    const askSeen = asksAboutSeen(text);
    const memoryText = (() => { try { return memory?.section?.(f, { query: text, scope: 'all', people: 0, title: '【这句话让你想起的事】', ...(askSeen ? { excludeKinds: ['chat'] } : {}) }) || ''; } catch { return ''; } })();
    const sayArgs = { persona: f.personaText, lifeText: lifeSection(f, s), sleeping: snap.where === 'sleep', call: f.parentCall, moodText: feelSection(s.feel, { call: f.parentCall, temper: temperOf(s.growth), scene: 'home' }), memoryText, history, kb: asksAboutGame(text) ? kbText() : '', text };
    /** 说完共用的收尾：剥信号、记聊天、记心情、长成长、给页面 done（老路和工具路一样）。 */
    const finishChat = (r, filt) => {
      const rest = filt.end(); if (rest) send({ type: 'delta', text: rest });
      // 工具路一句话可能分好几轮：只认最后一个信号块（前面轮里的丢掉，parseSignals 只取第一个）
      const sigs = String(r.text || '').match(/<sig>[\s\S]*?<\/sig>/gi) || [];
      const { clean, sig } = parseSignals(sigs.length > 1 ? String(r.text).replace(/<sig>[\s\S]*?<\/sig>/gi, '') + sigs.at(-1) : r.text);
      life.pushChat(f, 'fish', clean);
      // 心情-一期-2 E：信号过 sigEvents → 生活引擎里的 applyFeel（情绪事件，每条 change 记进「今天」）
      const beforeMood = life.state(f).mood;
      const ap = life.applyFeel(f, sigEvents(sig));
      // 成长：被爱 → 嘴和灵长经验、更黏人；天天聊 → 更活泼；和好让她更黏一点；聊到的话题 → 爱好
      try {
        const day = dayOf();
        life.grow(f, (g, age, at) => {
          let n = leanOnce(g, 'lively', 1, day);
          if (sig?.affection) n = leanOnce(gainXp(n, 'praised', { ageDays: age, at }), 'cling', 1, day);
          if (sig?.hurt) n = leanOnce(n, 'cling', -1, day);
          if (ap.reconciled) n = leanOnce(n, 'cling', 1, day); // 和好了：更黏你一点（心情-一期-2 E）
          if (sig?.topics?.length) n = feedInterests(n, sig.topics.map((tag) => ({ tag })), { day, at });
          return n;
        });
      } catch { /* 成长记账失败不影响聊天 */ }
      const after = snapshot(ap.state);
      try { letters?.onMood(f, beforeMood, after.mood); } catch { /* 不影响 */ }
      send({ type: 'done', text: clean, moodDelta: after.mood - beforeMood, ...(r.tokens ? { tokens: r.tokens, toolCalls: (r.calls || []).length } : {}), ...after }); // tokens：这一句花了多少（用户审查：钱花在哪要看得见）
    };
    const brokeLine = () => {
      const line = snap.where === 'sleep' ? '……呼……（零花钱花光了，睡得更香了）' : `${f.parentCall}，零花钱花光啦，本鱼先躺平～去右上角的设置里给我放点零花钱嘛。`;
      life.pushChat(f, 'fish', line);
      send({ type: 'done', text: line, ai: false, broke: true, ...snapshot(life.state(f)) });
    };
    try {
      if (roomTools) {
        // 工具路：今天的见闻概览拿不到就当空；字照旧过 sigFilter 再推给页面
        const overview = (() => { try { return seenLog?.overview?.(f) || ''; } catch { return ''; } })();
        const filt = sigFilter();
        let r = null, streamed = false;
        try {
          r = await wallet.loop('chat', {
            prompt: chatToolsPrompt({ ...sayArgs, overview }),
            tools: roomTools, maxCalls: 4,
            onDelta: (t) => { const out = filt.push(t); if (out) { streamed = true; send({ type: 'delta', text: out }); } }, // 信号行 <sig>…</sig> 不给人看：照旧流式过滤
            beforeCall: (name) => send({ type: 'tool', name, text: TOOL_STATUS[name] || '在翻东西…' }),
            timeoutMs: 90_000,
          });
        } catch (e) {
          filt.end(); // 这一轮报废：扣着的字丢掉，别连到后面的老路回话上
          if (e?.broke) { brokeLine(); return res.end(); }
          if (e?.noLoop || !streamed) { /* 宿主模型 / 工具用不了，或一个字没说就出错（比如模型不支持工具）：退回老路 */ }
          else { send({ type: 'error', error: `她没听清：${String(e?.message || e)}` }); return res.end(); }
        }
        if (r && parseSignals(r.text).clean) { finishChat(r, filt); return res.end(); }
        if (r) filt.end(); // 只调了工具、一句没说（超时 / 次数用完）：当没成，退回老路
      }
      // 老路：chatPrompt + wallet.say（和搬家前一字不差）
      const filt = sigFilter();
      const r = await wallet.say('chat', chatPrompt(sayArgs), (t) => { const out = filt.push(t); if (out) send({ type: 'delta', text: out }); }, 60_000);
      finishChat(r, filt);
    } catch (e) {
      if (e?.broke) {
        brokeLine();
      } else send({ type: 'error', error: `她没听清：${String(e?.message || e)}` });
    }
    res.end();
  }, 'chat route');

  reg(FEED_PATH, async (req, res) => {
    if (!guard(req, res, 'POST')) return;
    const f = homeFish();
    if (!f) return writeJson(res, 200, { ok: false, error: '还没有鱼' });
    const s0 = life.state(f);
    const lastFeed = (s0.events || []).filter((e) => e.kind === 'feed').at(-1);
    const full = lastFeed && nowMs() - Date.parse(lastFeed.at) < 60 * 60_000;
    const s = full
      ? life.record(f, 'feed', `${f.parentCall}又喂了零食（吃不下了）`, { mood: 1, visit: true })
      : life.record(f, 'feed', `${f.parentCall}喂了本鱼零食`, { mood: 8, energy: 6, visit: true });
    const snap = snapshot(s);
    const line = full ? `${f.parentCall}～本鱼吃饱啦，肚子圆滚滚的……` : snap.where === 'sleep' ? `……（迷迷糊糊吃了一口）谢谢${f.parentCall}……` : `哇，是零食！谢谢${f.parentCall}～`;
    writeJson(res, 200, { ok: true, line, full: Boolean(full), ...snap });
  }, 'feed route');

  reg(DIARY_PATH, async (req, res) => {
    if (!guard(req, res, 'POST')) return;
    const body = await readJsonBody(req);
    const f = homeFish();
    if (!f) return writeJson(res, 200, { ok: false, error: '还没有鱼' });
    const day = /^\d{4}-\d{2}-\d{2}$/.test(body?.day || '') ? body.day : dayOf();
    const s = life.state(f);
    try {
      const r = await wallet.say('diary', diaryPrompt(f, s, day, life), null, 60_000);
      const diary = life.putDiary(f, day, r.text, true);
      if (memory?.reflect) memory.reflect(f, wallet, { day }).catch(() => {}).then(() => memory.summarize?.(f, wallet, { day })).catch(() => {}); // 睡前反思，再写周记 / 章节（后台）
      writeJson(res, 200, { ok: true, day, text: r.text, diary: diary.slice().reverse() });
    } catch (e) {
      if (e?.broke) { const text = ruleDiary(f, s, day, life); const diary = life.putDiary(f, day, text, false); return writeJson(res, 200, { ok: true, day, text, broke: true, diary: diary.slice().reverse() }); }
      writeJson(res, 200, { ok: false, error: `日记没写出来：${String(e?.message || e)}` });
    }
  }, 'diary route');
}

/** 近况段落：跟在人设段落后面（order + 1）。 */
export function registerLifeSection(ctx, pond, life, personaOrder, work = null, memory = null) {
  if (!ctx.systemPrompt?.section) return false;
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'yushe:life',
    order: personaOrder + 1,
    text: (context) => {
      const f = pond.current();
      if (!f) return '';
      if (work && !work.inUserSession(context)) return '';
      let text = '';
      try { text = lifeSection(f, life.state(f)); } catch { text = ''; }
      // F-76：她记得的事（主会话是跟爸妈说话，家里和 B站的都能想起来；工作内容本来就不进记忆；一期-2 A：quotes:false 不带别人原话）
      try { const m = memory?.section?.(f, { scope: 'all', quotes: false }); if (m) text = text ? `${text}\n${m}` : m; } catch { /* 记忆坏了不影响近况 */ }
      return text;
    },
    interpolate: false,
  }), 'dsh-yushe: life section');
  return true;
}
