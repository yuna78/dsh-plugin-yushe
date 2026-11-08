/**
 * 私信 + 爸妈专线（M5 任务 46）：她醒着时每 20 分钟看一眼 B站私信，有人先找她就回。
 *
 *   dms.poll(fish)               宿主 10 分钟定时器调；自己控制成 20 分钟一次（爸妈专线要回得快一点）
 *   GET  /api/dsh-yushe/dms      最近的对话（谁、说了什么、她回了什么、是不是爸妈）+ 没看过几条
 *   POST /api/dsh-yushe/dms      {seen:true} 打开信箱时标成看过；{refresh:true} 马上看一眼
 *
 * 规矩（shared/dm.js）：只回真人的文字私信、只回对方先说的；第一次只记进度不回旧消息；
 * 爸妈专线不占上限、马上发；陌生人占「每天最多回几条」、按「在 B站说话」的方式（自己发 / 要我批准）。
 * 回的话走闸门（gate.propose kind 'dm'）。一轮最多处理 3 个人，省读次数和零花钱。存 <storage>/dms.json。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accountFile } from './account.js';
import { readJsonBody } from './game-routes.js';
import { createGates } from './gates.js';
import { nowDate, nowMs } from './clock.js';
import { lifeSection } from './life-engine.js';
import { pendingTalkers, newTexts, dmPrompt, parseDmReply } from '../shared/dm.js';

export const DMS_PATH = '/api/dsh-yushe/dms';
const EVERY = 20 * 60_000, PER_POLL = 3, KEEP = 12;

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
      if (!force && st.lastPoll && nowMs() - Date.parse(st.lastPoll) < EVERY) return { ok: false, why: '20 分钟看一次' };
      if (!force && G.closed('act')) return { ok: false, why: G.open('act').why }; // 出口闸（F-79）
      busy = true;
      try {
        const sessions = await biliRead.dmSessions();
        const me = biliRead.myMid();
        const parentMid = habits.get().parentMid;
        st.lastPoll = nowDate().toISOString();
        const todo = pendingTalkers(sessions, me, st.talkers);
        if (!st.seeded) { // 第一次：只记进度，不回旧消息
          for (const s of sessions || []) if (s?.session_type === 1 && !s.system_msg_type) st.talkers[String(s.talker_id)] = { who: null, lastSeqno: Number(s.max_seqno) || 0, history: [], seen: true };
          st.seeded = true; save(st);
          return { ok: true, seeded: true, handled: 0 };
        }
        // 爸妈先回
        todo.sort((a, b) => (b.mid === parentMid) - (a.mid === parentMid));
        let handled = 0;
        for (const t of todo.slice(0, PER_POLL)) {
          const conv = st.talkers[t.mid] || (st.talkers[t.mid] = { who: null, lastSeqno: 0, history: [] });
          conv.who = t.who || conv.who || '网友';
          const parent = Boolean(parentMid) && t.mid === parentMid;
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
        log?.warn?.(`[dsh-yushe] 私信：${String(e?.message || e).slice(0, 80)}`);
        return { ok: false, why: String(e?.message || e).slice(0, 80) };
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
