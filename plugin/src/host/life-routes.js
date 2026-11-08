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
import { moodTone, SIG_INSTRUCTION, sigFilter, parseSignals, applySignals } from '../shared/mood.js';
import { gainXp, leanOnce, feedInterests, growthView } from '../shared/growth.js';
import { asksAboutGame, kbText } from '../shared/tips.js';
import { nowDate } from './clock.js';

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
  return [
    fish.personaText, '',
    `【今天是 ${day}，睡前写日记】`,
    '这一天真实发生的事：', ...(events.length ? events : ['- （这一天很安静，没人来）']),
    ...(chats.length ? ['', '你们聊过的话（节选）：', ...chats] : []),
    '',
    `用你自己的口吻写一篇日记，80–150 字。只写上面真实发生的事和你的心情，可以写想对${fish.parentCall}说的话；不要编造别的经历、地点、数字或链接。只输出日记正文，不要标题和日期。`,
  ].join('\n');
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
    if (memory?.reflect) memory.reflect(fish, wallet, { day }).catch(() => {});
    return { text: r.text, ai: true, diary };
  } catch (e) {
    if (e?.broke) { const text = ruleDiary(fish, s, day, life); return { text, ai: false, broke: true, diary: life.putDiary(fish, day, text, false) }; }
    throw e;
  }
}

export function registerLifeRoutes({ ctx, scope, pond, life, wallet, letters, gate, inbox, dms, memory = null, storage, isLoopbackRequest, writeJson }) {
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
      trip: s.trip ? { note: s.trip.note, returnAt: s.trip.returnAt, state: s.trip.state, sent: (s.trip.cards || []).filter((c) => c.sent).length, total: (s.trip.cards || []).length, gear: s.trip.gear } : null,
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
    const prompt = [
      f.personaText, '',
      lifeSection(f, s),
      snap.where === 'sleep' ? `【此刻】你正在睡觉，被${f.parentCall}叫醒了，迷迷糊糊地回话，可以撒娇说困。` : `【此刻】你在鱼社的家里，${f.parentCall}来找你聊天。`,
      moodTone(snap.mood, f.parentCall).text,
      // F-76：爸妈这句话让她想起的事（本地召回，不花 token）
      ...(() => { try { const m = memory?.section?.(f, { query: text, scope: 'all', people: 0, title: '【这句话让你想起的事】' }); return m ? ['', m] : []; } catch { return []; } })(),
      ...(history.length ? ['', '刚才的对话：', ...history] : []),
      // 问到鱼社怎么玩：带上系统知识库，只按它答（F-42）；平常聊天不带，省 token
      ...(asksAboutGame(text) ? ['', `【鱼社说明书】（${f.parentCall}在问鱼社怎么玩时，用你自己的口吻、按这份说明回答；说明里没有的就说不知道，别编；「还在做的」要老实说还在做）`, kbText()] : []),
      '', `${f.parentCall}：${text}`, '',
      `回复${f.parentCall}：一到三句话，像发消息一样自然，符合你的性格、口头禅和现在的心情；不要编造具体的事实、数字、链接；${f.parentCall}问到你不知道的事就直说不知道。`,
      SIG_INSTRUCTION,
    ].join('\n');
    try {
      // 信号行 <sig>…</sig> 不给人看：流式过滤，最后解析成心情变化（AI 听懂，规则记账）
      const filt = sigFilter();
      const r = await wallet.say('chat', prompt, (t) => { const out = filt.push(t); if (out) send({ type: 'delta', text: out }); }, 60_000);
      const rest = filt.end(); if (rest) send({ type: 'delta', text: rest });
      const { clean, sig } = parseSignals(r.text);
      life.pushChat(f, 'fish', clean);
      const before = snapshot(life.state(f)).mood;
      const ap = applySignals(sig, { mood: before, call: f.parentCall, dayGain: life.moodGainToday(life.state(f)) });
      if (ap.delta || ap.reasons.length) life.applyMood(f, ap);
      // 成长：被爱 → 嘴和灵长经验、更黏人；天天聊 → 更活泼；聊到的话题 → 爱好
      try {
        const day = dayOf();
        life.grow(f, (g, age, at) => {
          let n = leanOnce(g, 'lively', 1, day);
          if (sig?.affection) n = leanOnce(gainXp(n, 'praised', { ageDays: age, at }), 'cling', 1, day);
          if (sig?.hurt) n = leanOnce(n, 'cling', -1, day);
          if (sig?.topics?.length) n = feedInterests(n, sig.topics.map((tag) => ({ tag })), { day, at });
          return n;
        });
      } catch { /* 成长记账失败不影响聊天 */ }
      const after = snapshot(life.state(f));
      try { letters?.onMood(f, before, after.mood); } catch { /* 不影响 */ }
      send({ type: 'done', text: clean, moodDelta: ap.delta, ...after });
    } catch (e) {
      if (e?.broke) {
        const line = snap.where === 'sleep' ? '……呼……（零花钱花光了，睡得更香了）' : `${f.parentCall}，零花钱花光啦，本鱼先躺平～去右上角的设置里给我放点零花钱嘛。`;
        life.pushChat(f, 'fish', line);
        send({ type: 'done', text: line, ai: false, broke: true, ...snapshot(life.state(f)) });
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
      if (memory?.reflect) memory.reflect(f, wallet, { day }).catch(() => {}); // 睡前反思（后台）
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
