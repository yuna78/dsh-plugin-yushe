/**
 * 私信 + 爸妈专线（M5 任务 46）：她醒着时冷 8 分钟看一次，聊起来 3 分钟一轮；夜里只给爸妈专线回。
 *
 *   dms.poll(fish)               宿主 2 分钟互动定时器调；自己控制节奏（冷 / 热 / 夜里）
 *   GET  /api/dsh-yushe/dms      最近的对话（谁、说了什么、她回了什么、是不是爸妈）+ 没看过几条
 *   POST /api/dsh-yushe/dms      {seen:true} 打开信箱时标成看过；{refresh:true} 马上看一眼
 *
 * 规矩（shared/dm.js）：只回真人的文字私信、只回对方先说的；第一次只记进度不回旧消息；
 * 爸妈专线不占上限、马上发；陌生人占「每天最多回几条」、按「在 B站说话」的方式（自己发 / 要我批准）。
 * 回的话走闸门（gate.propose kind 'dm'）。一轮最多处理 5 个人，省读次数和零花钱。存 <storage>/dms.json。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accountFile } from './account.js';
import { readJsonBody } from './game-routes.js';
import { createGates } from './gates.js';
import { nowDate, nowMs } from './clock.js';
import { asleepAt, lifeSection } from './life-engine.js';
import { pendingTalkers, newTexts, dmPrompt, parseDmReply } from '../shared/dm.js';

export const DMS_PATH = '/api/dsh-yushe/dms';
// F-81：私信优先——冷 8 分钟、聊起来 3 分钟；夜里只给爸妈专线留 20 分钟一轮（陌生人不打扰睡觉）。
const COLD = 8 * 60_000, HOT = 3 * 60_000, NIGHT = 20 * 60_000, HOT_WINDOW = 20 * 60_000, PER_POLL = 5, KEEP = 12;
export const DMS_EVERY = { cold: COLD, hot: HOT, night: NIGHT, perPoll: PER_POLL };

export function createDms({ storage, life, wallet, habits, biliRead, gate, log, gates = null }) {
  const file = () => accountFile(storage, 'dms.json'); // G5：按号分开存，换号从零开始
  const empty = () => ({ seeded: false, talkers: {}, lastPoll: null });
  const load = () => { try { return { ...empty(), ...JSON.parse(readFileSync(file(), 'utf8')) }; } catch { return empty(); } };
  const save = (v) => { mkdirSync(storage, { recursive: true }); const f = file(); mkdirSync(dirname(f), { recursive: true }); writeFileSync(`${f}.tmp`, JSON.stringify(v)); renameSync(`${f}.tmp`, f); };
  let busy = false;

  async function replyTo(fish, st, t, incoming) {
    const parent = Boolean(habits.get().parentMid) && habits.get().parentMid === t.mid;
    const conv = st.talkers[t.mid];
    if (!parent && !habits.get().dmsPerDay) { conv.note = '上网习惯里不回陌生人私信'; return; }
    if (wallet.view().broke) { conv.note = '零花钱花光了，没回'; return; }
    const prompt = dmPrompt({ fish, lifeText: parent ? lifeSection(fish, life.state(fish), nowDate()) : '', who: conv.who, parent, history: conv.history.slice(0, -incoming.length), incoming });
    let raw = '';
    try { raw = (await wallet.say('dm', prompt, undefined, 45_000)).text; } catch (e) { conv.note = `没写出来：${String(e?.message || e).slice(0, 40)}`; return; }
    const text = parseDmReply(raw, parent);
    if (!text) { conv.note = '她决定不回'; return; }
    const r = gate.propose(fish, { kind: 'dm', text, target: { mid: t.mid, who: conv.who, parent } });
    if (!r.ok) { conv.note = `没发：${(r.problems || []).join('、')}`; return; }
    conv.history.push({ from: 'me', text, at: nowDate().toISOString(), draft: r.id });
    conv.note = null;
  }

  const G = gates || createGates({ habits }); // 没传就自己建一个
  const dms = {
    async poll(fish, { force = false } = {}) {
      if (busy) return { ok: false, why: '正在看' };
      if (!biliRead?.loggedIn?.()) return { ok: false, why: '她还没登录 B站' };
      const st = load();
      const asleep = asleepAt();
      const parentMid = habits.get().parentMid;
      if (!force && G.closed('act') && !parentMid) return { ok: false, why: G.open('act').why }; // 出口闸（F-79）：睡着不看别人的私信
      // 醒了第一眼：上一轮还在睡觉，这一轮不按冷热节奏等
      const wasAsleep = st.lastPoll ? asleepAt(new Date(st.lastPoll)) : false;
      const hot = Object.values(st.talkers || {}).some((c) => c.at && nowMs() - Date.parse(c.at) < HOT_WINDOW);
      const every = asleep ? NIGHT : hot ? HOT : COLD; // 夜里只给爸妈专线留 20 分钟一轮
      if (!force && st.lastPoll && nowMs() - Date.parse(st.lastPoll) < every && !(wasAsleep && !asleep)) return { ok: false, why: asleep ? '夜里 20 分钟看一次（只回爸妈）' : hot ? '聊着天，3 分钟看一次' : '8 分钟看一次' };
      busy = true;
      try {
        const sessions = await biliRead.dmSessions();
        const me = biliRead.myMid();
        st.lastPoll = nowDate().toISOString();
        let todo = pendingTalkers(sessions, me, st.talkers);
        if (!st.seeded) { // 第一次：只记进度，不回旧消息
          for (const s of sessions || []) if (s?.session_type === 1 && !s.system_msg_type) st.talkers[String(s.talker_id)] = { who: null, lastSeqno: Number(s.max_seqno) || 0, history: [], seen: true };
          st.seeded = true; save(st);
          return { ok: true, seeded: true, handled: 0 };
        }
        if (asleep) todo = todo.filter((t) => t.mid === parentMid); // 睡觉时只回爸妈专线
        // 爸妈先回
        todo.sort((a, b) => (b.mid === parentMid) - (a.mid === parentMid));
        let handled = 0;
        for (const t of todo.slice(0, PER_POLL)) {
          const conv = st.talkers[t.mid] || (st.talkers[t.mid] = { who: null, lastSeqno: 0, history: [] });
          conv.who = t.who || conv.who || '网友';
          const parent = Boolean(parentMid) && t.mid === parentMid;
          if (!parent) { // 心情二期-2a B3：她烦躁 / 受挫时先不回陌生人——拉消息之前就跳过，不推进 lastSeqno、不记 dm-in、不算处理过，情绪过了再拉到再回
            const hd = gate?.held?.(fish);
            if (hd?.held) { conv.note = '她现在有点烦，过会儿再回'; continue; }
          }
          const msgs = await biliRead.dmMessages(t.mid).catch(() => []);
          const incoming = newTexts(msgs, t.mid, conv.lastSeqno);
          conv.lastSeqno = Math.max(conv.lastSeqno, t.maxSeqno, ...incoming.map((m) => m.seqno));
          if (!incoming.length) continue; // 只有图片 / 表情之类，不回
          conv.history.push(...incoming.map((m) => ({ from: 'them', text: m.text, at: m.at })));
          conv.seen = false; conv.parent = parent; conv.at = incoming.at(-1).at || nowDate().toISOString();
          if (fish) life.record(fish, parent ? 'dm-parent' : 'dm-in', parent ? `${fish.parentCall}在 B站给本鱼发私信：「${incoming.at(-1).text.slice(0, 24)}」` : `B站上 ${conv.who} 给本鱼发了私信`, { mood: parent ? 5 : 1 });
          if (fish) await replyTo(fish, st, t, incoming);
          conv.history = conv.history.slice(-KEEP);
          handled += 1;
        }
        save(st);
        if (handled) log?.info?.(`[dsh-yushe] 私信：处理了 ${handled} 个人`);
        return { ok: true, handled };
      } catch (e) {
        const why = String(e?.message || e).slice(0, 80);
        if (!/用完了|歇歇眼睛|这一小时|风控/.test(why)) log?.warn?.(`[dsh-yushe] 私信：${why}`); // 预算 / 风控不算故障，别每 2 分钟刷一条日志
        return { ok: false, why };
      } finally { busy = false; }
    },
    unseen: () => Object.values(load().talkers).filter((c) => c.seen === false).length,
    markSeen() { const st = load(); let n = 0; for (const c of Object.values(st.talkers)) if (c.seen === false) { c.seen = true; n += 1; } if (n) save(st); return n; },
    view() {
      const st = load(), h = habits.get();
      const drafts = Object.fromEntries((gate?.view?.().recent || []).filter((d) => d.kind === 'dm').map((d) => [d.id, d.status]));
      const convs = Object.entries(st.talkers).filter(([, c]) => c.history?.length).map(([mid, c]) => ({ mid, who: c.who, parent: Boolean(h.parentMid) && mid === h.parentMid, at: c.at, unseen: c.seen === false, note: c.note || null,
        history: c.history.map((x) => ({ from: x.from, text: x.text, at: x.at, status: x.draft ? drafts[x.draft] || 'pending' : null })) }))
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      return { loggedIn: Boolean(biliRead?.loggedIn?.()), parentSet: Boolean(h.parentMid), perDay: h.dmsPerDay, convs: convs.slice(0, 10), unseen: convs.filter((c) => c.unseen).length, lastPoll: st.lastPoll };
    },
    recent: (n = 5) => dms.view().convs.slice(0, n).map((c) => ({ who: c.parent ? '爸妈（专线）' : c.who, lines: c.history.slice(-4).map((x) => `${x.from === 'me' ? '我' : '对方'}：${x.text}`) })),
  };
  return dms;
}

export function registerDmsRoutes({ scope, pond, dms, isLoopbackRequest, writeJson }) {
  scope.effect(() => scope.webServer.register({ kind: 'exact', path: DMS_PATH, handler: async (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
    if (req.method === 'GET') return writeJson(res, 200, { ok: true, ...dms.view() });
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    const b = await readJsonBody(req);
    if (b?.seen) return writeJson(res, 200, { ok: true, marked: dms.markSeen() });
    if (b?.refresh) return writeJson(res, 200, await dms.poll(pond.current() || pond.list().fish.at(-1) || null, { force: true }));
    writeJson(res, 400, { ok: false, error: '请求格式不对' });
  } }), 'dsh-yushe: dms route');
}
