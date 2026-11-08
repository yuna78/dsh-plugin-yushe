/**
 * 记忆存储 + 从档案同步（F-76，docs/设计/09-记忆.md）。
 *
 * 档案（见闻 / 足迹 / 信箱 / 私信 / 日记 / 事件）不动；这里把档案里新出现的东西抄成「经历」，按规则慢慢忘。
 * 模型只通过这里拿记忆（recall / section），拿不到档案。
 *
 *   memory.sync(fish)                    抄新的、推进遗忘（宿主 10 分钟定时器 + 读之前调）
 *   memory.recall(fish, { query, scope }) 召回；scope 'public' = 对外说话，只给 B站范围
 *   memory.reinforce(fish, ids)          她主动想起来了：加深（半衰期变长）
 *   memory.section(fish, …)              给模型的一段「你记得的事」
 *   GET /api/dsh-yushe/memory            给页面：各阶段几条、认识几个人、最近记得的事
 *
 * 存 <storage>/memory/<fishId>.json，一条鱼一个文件。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowMs } from './clock.js';
import { emptyMemory, makeEpisode, meet, settleMemory, recall, knownPeople, aboutPerson, memoryText, memoryStats, stageOf, STAGE_TEXT } from '../shared/memory.js';

export const MEMORY_PATH = '/api/dsh-yushe/memory';
const MAX_KEYS = 1500;
const EVENT_KINDS = { born: 'born', mood: 'mood', nap: 'nap', 'late-work': 'late-work', chat: 'chat', feed: 'feed', news: 'news' };
const FOOT_KINDS = { comment: 'comment', reply: 'reply', post: 'post', dyncomment: 'dyncomment', dm: 'dm', like: 'like', comment_like: 'comment_like', collect: 'collect', follow: 'follow', unfollow: 'unfollow' };
const FOOT_WHAT = { comment: '评论了视频', reply: '回复了评论', post: '发了动态', dyncomment: '评论了动态', dm: '回了私信', like: '点赞了视频', comment_like: '给评论点了赞', collect: '收藏了视频', follow: '关注了', unfollow: '取关了' };
const short = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 档案 → 一串「候选经历」（带去重 key）。纯函数，verify 直接测。 */
export function archiveItems({ fish, life = {}, footprints = [], inbox = [], dms = [], parentMid = '' }) {
  const call = fish?.parentCall || '爸妈';
  const out = [];
  for (const e of life.events || []) {
    const kind = EVENT_KINDS[e.kind];
    if (kind && e.at) out.push({ key: `e:${e.at}:${e.kind}`, at: e.at, kind, text: e.text });
  }
  for (const d of life.diary || []) if (d.ai && d.at) out.push({ key: `d:${d.day}`, at: d.at, kind: 'diary', text: `写日记（${d.day}）：${short(d.text, 100)}` });
  for (const j of life.journal || []) {
    if (!j.at) continue;
    if (j.final) out.push({ key: `j:${j.trip || j.at}:card`, at: j.at, kind: 'postcard', text: `出门回来给${call}写明信片：${short(j.text, 100)}` });
    for (const x of j.seen || []) if (x?.url) {
      const bvid = String(x.url).match(/BV[0-9A-Za-z]{10}/)?.[0];
      out.push({ key: `s:${bvid || x.url}`, at: j.at, kind: 'seen', text: `${bvid ? '在 B站看了' : `在${short(x.source, 10) || '网上'}看到`}《${short(x.title, 50)}》${!j.final && j.text ? `，${short(j.text, 40)}` : ''}`, url: x.url, keys: { bvid, tag: x.tag, who: x.up, mid: x.mid } });
    }
  }
  for (const f of footprints) {
    const kind = FOOT_KINDS[f.kind];
    if (!kind || !f.at) continue;
    const t = f.target || {};
    const who = t.who || null, mid = t.mid || null;
    const what = FOOT_WHAT[kind];
    const text = kind === 'follow' || kind === 'unfollow' ? `在 B站${what} ${short(who || f.text, 20)}` : `在 B站${what}${t.title ? `《${short(t.title, 30)}》` : ''}${['comment', 'reply', 'post', 'dyncomment', 'dm'].includes(kind) ? `：「${short(f.text, 50)}」` : ''}`;
    out.push({ key: `f:${f.id || f.at}`, at: f.at, kind, text, url: f.url || undefined, keys: { bvid: t.bvid, mid, who }, person: (mid || who) && kind !== 'unfollow' ? { mid, who, what: `本鱼${what}${kind === 'follow' ? 'TA' : ''}` } : null });
  }
  for (const x of inbox) {
    const at = x.at || x.got; if (!at) continue;
    if (x.kind === 'reply') out.push({ key: `i:${x.id}`, at, kind: 'got-reply', text: `${short(x.who, 20)}在 B站回了本鱼${x.mine ? `那句「${short(x.mine, 20)}」` : ''}：「${short(x.text, 50)}」`, url: x.url || undefined, keys: { who: x.who, mid: x.mid }, person: { mid: x.mid, who: x.who, what: `回了本鱼：「${short(x.text, 20)}」` } });
    else if (x.kind === 'follow') out.push({ key: `i:${x.id}`, at, kind: 'got-follow', text: `${short(x.who, 20)}关注了本鱼`, keys: { who: x.who, mid: String(x.id || '').replace(/^f/, '') }, person: { mid: String(x.id || '').replace(/^f/, '') || null, who: x.who, what: '关注了本鱼' } });
    else if (x.kind === 'like') out.push({ key: `i:${String(x.id).split(':')[0]}`, at, kind: 'got-like', text: `本鱼在 B站说的${x.mine ? `「${short(x.mine, 20)}」` : '话'}被${short(x.who, 20)}${x.count > 1 ? ` 等 ${x.count} 人` : ''}点赞了` });
  }
  for (const c of dms) {
    const parent = Boolean(parentMid) && String(c.mid) === String(parentMid);
    for (const h of c.history || []) {
      if (h.from !== 'them' || !h.at) continue;
      out.push(parent
        ? { key: `m:${c.mid}:${h.at}`, at: h.at, kind: 'dm-parent', text: `${call}在 B站私信本鱼：「${short(h.text, 40)}」`, person: { mid: c.mid, who: call, what: '发私信', parent: true } }
        : { key: `m:${c.mid}:${h.at}`, at: h.at, kind: 'dm-in', text: `${short(c.who, 20) || '网友'}给本鱼发私信：「${short(h.text, 40)}」`, keys: { mid: c.mid, who: c.who }, person: { mid: c.mid, who: c.who, what: `私信说：「${short(h.text, 20)}」` } });
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** 把候选并进记忆（去重），顺便认人。返回加了几条。 */
export function ingest(mem, items) {
  const keys = new Set(mem.cursors.keys || []);
  let added = 0;
  for (const it of items) {
    if (keys.has(it.key)) continue;
    keys.add(it.key);
    mem.episodes.push(makeEpisode(mem, it));
    if (it.person) meet(mem, { ...it.person, at: it.at });
    added += 1;
  }
  mem.cursors.keys = [...keys].slice(-MAX_KEYS);
  return added;
}

export function createMemory({ storage, life, gate, inbox, dms, habits, log }) {
  const base = join(storage, 'memory');
  const file = (id) => join(base, `${String(id).replace(/[^\w-]/g, '')}.json`);
  const load = (fish) => { try { const j = JSON.parse(readFileSync(file(fish.id), 'utf8')); return { ...emptyMemory(), ...j, cursors: { ...(j.cursors || {}) } }; } catch { return emptyMemory(); } };
  const save = (fish, m) => { mkdirSync(base, { recursive: true }); const f = file(fish.id); writeFileSync(`${f}.tmp`, JSON.stringify(m)); renameSync(`${f}.tmp`, f); };
  const days = () => Number(habits?.get?.().memoryDays) || 30;
  const recallN = () => Number(habits?.get?.().memoryRecall) || 5;
  const lastSync = new Map();

  const memory = {
    /** 抄新的 + 推进遗忘。minGapMs 内重复调直接用存档（读路径上频繁调用）。 */
    sync(fish, { minGapMs = 60_000 } = {}) {
      if (!fish) return emptyMemory();
      const now = nowMs();
      if (now - (lastSync.get(fish.id) || 0) < minGapMs) return load(fish);
      lastSync.set(fish.id, now);
      const m = load(fish);
      try {
        const s = life?.state?.(fish) || {};
        const items = archiveItems({ fish, life: s, footprints: gate?.footprints?.() || [], inbox: inbox?.all?.() || [], dms: dms?.view?.().convs || [], parentMid: habits?.get?.().parentMid || '' });
        const added = ingest(m, items);
        const { forgot, faded } = settleMemory(m, now, days());
        save(fish, m);
        if (added || forgot) log?.info?.(`[dsh-yushe] 记忆：新记下 ${added} 条，变模糊 ${faded} 条，忘掉 ${forgot} 条`);
      } catch (e) { log?.warn?.(`[dsh-yushe] 记忆同步出错：${String(e?.message || e).slice(0, 120)}`); }
      return m;
    },
    recall(fish, { query = '', scope = 'all', limit = recallN(), chars = 600, kinds = null } = {}) {
      return recall(memory.sync(fish), { query, scope, limit, chars, kinds, now: nowMs(), baseDays: days() });
    },
    people(fish, { limit = 5, parents = true } = {}) { return knownPeople(memory.sync(fish), { now: nowMs(), baseDays: days(), limit, parents }); },
    aboutPerson(fish, who) { return aboutPerson(memory.sync(fish), who || {}, { now: nowMs(), baseDays: days() }); },
    /** 她主动想起来：加深（只有主动回忆算）。 */
    reinforce(fish, ids = []) {
      if (!ids.length) return 0;
      const m = load(fish); const set = new Set(ids); let n = 0;
      for (const ep of m.episodes) if (set.has(ep.id)) { ep.reinforced = Math.min(5, (ep.reinforced || 0) + 1); n += 1; }
      if (n) save(fish, m);
      return n;
    },
    /** 最近评论 / 回复过的视频（出门时提醒别重复评论）：只算还清楚记得的。 */
    recentlyCommented(fish, n = 6) {
      const m = memory.sync(fish), now = nowMs();
      return m.episodes.filter((e) => ['comment', 'reply'].includes(e.kind) && e.keys?.bvid && stageOf(e, now, days()) === 'clear').slice(-n).map((e) => e.keys.bvid);
    },
    /** 给模型的一段。scope 'public' 用在对外说话的地方。 */
    section(fish, { query = '', scope = 'all', limit = recallN(), people = 3, title, tail } = {}) {
      try {
        const items = memory.recall(fish, { query, scope, limit });
        const ppl = people ? memory.people(fish, { limit: people, parents: false }) : [];
        return memoryText(items, ppl, { title, tail });
      } catch { return ''; }
    },
    view(fish) {
      const m = memory.sync(fish, { minGapMs: 0 }), now = nowMs();
      return {
        days: days(), recallN: recallN(), ...memoryStats(m, { now, baseDays: days() }),
        recent: m.episodes.slice(-20).reverse().map((e) => ({ id: e.id, at: e.at, kind: e.kind, scope: e.scope, stage: STAGE_TEXT[stageOf(e, now, days())], text: e.text })),
        people: knownPeople(m, { now, baseDays: days(), limit: 20 }),
      };
    },
  };
  return memory;
}

export function registerMemoryRoutes({ scope, pond, memory, isLoopbackRequest, writeJson }) {
  scope.effect(() => scope.webServer.register({ kind: 'exact', path: MEMORY_PATH, handler: async (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    const f = pond.current() || pond.list().fish.at(-1);
    if (!f) return writeJson(res, 200, { ok: true, fish: null });
    writeJson(res, 200, { ok: true, ...memory.view(f) });
  } }), 'dsh-yushe: memory route');
}
