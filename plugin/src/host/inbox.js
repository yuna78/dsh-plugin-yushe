/**
 * 收件箱（M5 任务 45）：每小时看一眼她的 B站——有人回她、给她点赞、关注她。只读。
 *
 *   inbox.poll(fish)              宿主 10 分钟定时器调；自己控制成一小时一次、醒着才看
 *   GET  /api/dsh-yushe/inbox     最近的回复 / 点赞 / 新粉丝 + 没看过几条 + 粉丝数 + 每条足迹的赞和回复
 *   POST /api/dsh-yushe/inbox     {seen:true} 打开信箱时标成看过了
 *
 * 省读次数：每轮 unread + stat 两次；回复 / 点赞有未读或 6 小时没看才拉；粉丝列表只在粉丝数变多时拉。
 * 外面的人写的字只展示、只当资料（截短、加引号进「今天」），她不照着做。存 <storage>/inbox.json。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accountFile } from './account.js';
import { readJsonBody } from './game-routes.js';
import { createGates } from './gates.js';
import { nowDate, nowMs } from './clock.js';
import { emptyInbox, mergeInbox, newsEvents, footStats, whatToFetch, newestFirst } from '../shared/inbox.js';

export const INBOX_PATH = '/api/dsh-yushe/inbox';
const EVERY = 60 * 60_000;

export function createInbox({ storage, life, biliRead, gate, log, gates = null }) {
  const file = () => accountFile(storage, 'inbox.json'); // G5：按号分开存，换号从零开始
  const load = () => { try { return { ...emptyInbox(), ...JSON.parse(readFileSync(file(), 'utf8')) }; } catch { return emptyInbox(); } };
  const save = (v) => { mkdirSync(storage, { recursive: true }); const f = file(); mkdirSync(dirname(f), { recursive: true }); writeFileSync(`${f}.tmp`, JSON.stringify(v)); renameSync(`${f}.tmp`, f); };
  let busy = false;
  const G = gates || createGates({}); // 没传就自己建一个

  const inbox = {
    /** 看一眼。force 跳过一小时间隔和睡觉（测试 / 手动刷新用）。返回 { ok, news?, why? }。 */
    async poll(fish, { force = false } = {}) {
      if (busy) return { ok: false, why: '正在看' };
      if (!biliRead?.loggedIn?.()) return { ok: false, why: '她还没登录 B站' };
      const st = load();
      if (!force && st.lastPoll && nowMs() - Date.parse(st.lastPoll) < EVERY) return { ok: false, why: '一小时看一次' };
      if (!force && G.closed('act')) return { ok: false, why: G.open('act').why }; // 出口闸（F-79）
      busy = true;
      try {
        const [unread, stat] = await Promise.all([biliRead.unread().catch(() => null), biliRead.myStat().catch(() => null)]);
        const want = whatToFetch(st, { unread, fanCount: stat?.follower ?? null }, nowMs());
        const got = { fanCount: stat?.follower ?? null };
        if (want.reply) got.replies = await biliRead.repliesToMe().catch(() => null);
        if (want.like) got.likes = await biliRead.likesToMe().catch(() => null);
        if (want.fans && stat) got.fans = await biliRead.followers().catch(() => null);
        const { state, news } = mergeInbox(st, got, nowDate().toISOString());
        save(state);
        if (fish) for (const e of newsEvents(news)) life.record(fish, e.kind, e.text, { mood: e.mood });
        const n = news.reply.length + news.like.length + news.follow.length;
        if (n) log?.info?.(`[dsh-yushe] 收件箱：${news.reply.length} 回复 / ${news.like.length} 点赞 / ${news.follow.length} 新粉丝`);
        return { ok: true, news: { reply: news.reply.length, like: news.like.length, follow: news.follow.length } };
      } finally { busy = false; }
    },
    unseen: () => load().items.filter((x) => !x.seen).length,
    all: () => load().items.slice(), // 记忆从这里抄（F-76）
    markSeen() { const st = load(); let n = 0; for (const x of st.items) if (!x.seen) { x.seen = true; n += 1; } if (n) save(st); return n; },
    view() {
      const st = load();
      // 最新在前（按通知时间排，不再靠追加顺序反转）
      return { loggedIn: Boolean(biliRead?.loggedIn?.()), items: newestFirst(st.items, 40), unseen: st.items.filter((x) => !x.seen).length, fanCount: st.fanCount, lastPoll: st.lastPoll, foot: footStats(gate?.footprints?.() || [], st.items) };
    },
    recent: (n = 10) => newestFirst(load().items, n).map((x) => ({ kind: x.kind, who: x.who, said: x.text || null, toWhat: x.mine || null, count: x.count || null, at: x.at || x.got, url: x.url || null })),
  };
  return inbox;
}

export function registerInboxRoutes({ scope, pond, inbox, isLoopbackRequest, writeJson }) {
  scope.effect(() => scope.webServer.register({ kind: 'exact', path: INBOX_PATH, handler: async (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
    if (req.method === 'GET') return writeJson(res, 200, { ok: true, ...inbox.view() });
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    const b = await readJsonBody(req);
    if (b?.seen) return writeJson(res, 200, { ok: true, marked: inbox.markSeen() });
    if (b?.refresh) return writeJson(res, 200, await inbox.poll(pond.current() || pond.list().fish.at(-1) || null, { force: true }));
    writeJson(res, 400, { ok: false, error: '请求格式不对' });
  } }), 'dsh-yushe: inbox route');
}
