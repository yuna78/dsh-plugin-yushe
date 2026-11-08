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
import { emptyMemory, migrateMemory, makeEpisode, meet, settleMemory, recall, knownPeople, aboutPerson, memoryText, memoryStats, stageOf, STAGE_TEXT, reflectCandidates, reflectPrompt, applyReflection, beliefsFor, tell, untell, localDay, defang, logOp } from '../shared/memory.js';
import { personaFor } from '../shared/growth.js';

export const MEMORY_PATH = '/api/dsh-yushe/memory';
const KEY_WINDOW = 3 * 86400e3; // 记号窗口：只留游标前 3 天内的 key，按时间清，不按条数截（一期-2 E）
const EVENT_KINDS = { born: 'born', mood: 'mood', nap: 'nap', 'late-work': 'late-work', feed: 'feed', news: 'news' }; // 聊天从 chat 记录抄（带她怎么回的），不从事件抄
const FOOT_KINDS = { comment: 'comment', reply: 'reply', post: 'post', dyncomment: 'dyncomment', dm: 'dm', like: 'like', comment_like: 'comment_like', collect: 'collect', follow: 'follow', unfollow: 'unfollow' };
const FOOT_WHAT = { comment: '评论了视频', reply: '回复了评论', post: '发了动态', dyncomment: '评论了动态', dm: '回了私信', like: '点赞了视频', comment_like: '给评论点了赞', collect: '收藏了视频', follow: '关注了', unfollow: '取关了' };
const short = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 档案 → 一串「候选经历」（带去重 key）。纯函数，verify 直接测。 */
export function archiveItems({ fish, life = {}, footprints = [], inbox = [], dms = [], parentMid = '', chatFrom = '' }) {
  const call = fish?.parentCall || '爸妈';
  const out = [];
  // 和爸妈聊天：爸妈一句 + 她回的一句，记成一条（第二步：不再只记前 30 字）
  const chat = life.chat || [];
  for (let i = 0; i < chat.length; i++) {
    const c = chat[i];
    if (c.role !== 'user' || !c.at || (chatFrom && String(c.at) < chatFrom)) continue;
    const reply = chat[i + 1]?.role !== 'user' ? chat[i + 1] : null;
    out.push({ key: `c:${c.at}`, at: c.at, kind: 'chat', text: `${call}说：「${short(c.text, 60)}」${reply ? `，本鱼回：「${short(reply.text, 40)}」` : ''}` });
  }
  for (const e of life.events || []) {
    const kind = EVENT_KINDS[e.kind];
    if (kind && e.at) out.push({ key: `e:${e.at}:${e.kind}`, at: e.at, kind, text: e.text });
  }
  for (const d of life.diary || []) if (d.ai && d.at) out.push({ key: `d:${d.day}`, at: d.at, kind: 'diary', text: `写日记（${d.day}）：${short(d.text, 100)}` });
  for (const j of life.journal || []) {
    if (!j.at) continue;
    // F-79：梦游那一条单独抄成 imp 1 的经历（记得最浅，忘得最快）
    if (j.dream) {
      // F-79：梦只记一条 home / imp 1；梦里的 seen 不再展开成 public 记忆（梦话可能带上私信内容，不能进对外上下文）
      out.push({ key: `dr:${j.at}`, at: j.at, kind: 'dream', text: `做梦梦见在刷 B站：${short(j.text, 100)}`, keys: { tags: (j.seen || []).map((x) => x.tag).filter(Boolean) } });
      continue;
    }
    if (j.final) out.push({ key: `j:${j.trip || j.at}:card`, at: j.at, kind: 'postcard', text: `出门回来给${call}写明信片：${short(j.text, 100)}` });
    for (const x of j.seen || []) if (x?.url) {
      const bvid = String(x.url).match(/BV[0-9A-Za-z]{10}/)?.[0];
      out.push({ key: `s:${bvid || x.url}`, at: j.at, kind: 'seen', text: `${bvid ? '在 B站看了' : `在${short(x.source, 10) || '网上'}看到`}《${defang(short(x.title, 50))}》${!j.final && j.text ? `，${short(j.text, 40)}` : ''}`, url: x.url, keys: { bvid, tag: x.tag, who: x.up, mid: x.mid } });
    }
  }
  for (const p of life.album || []) if (p.photo && p.at && p.ref?.title) {
    const bvid = String(p.ref.url || '').match(/BV[0-9A-Za-z]{10}/)?.[0];
    out.push({ key: `p:${p.photo}`, at: p.at, kind: 'photo', text: `看《${defang(short(p.ref.title, 40))}》时被打动，拍了一张照片${p.moment ? `：${short(p.moment, 50)}` : ''}`, url: p.ref.url || undefined, keys: { bvid } });
  }
  for (const f of footprints) {
    const kind = FOOT_KINDS[f.kind];
    if (!kind || !f.at) continue;
    const t = f.target || {};
    const who = t.who || null, mid = t.mid || null;
    const what = FOOT_WHAT[kind];
    const text = kind === 'follow' || kind === 'unfollow' ? `在 B站${what} ${short(who || f.text, 20)}` : `在 B站${what}${t.title ? `《${defang(short(t.title, 30))}》` : ''}${['comment', 'reply', 'post', 'dyncomment', 'dm'].includes(kind) ? `：「${short(f.text, 50)}」` : ''}`;
    out.push({ key: `f:${f.id || f.at}`, at: f.at, kind, text, url: f.url || undefined, keys: { bvid: t.bvid, mid, who }, person: (mid || who) && kind !== 'unfollow' ? { mid, who, what: `本鱼${what}${kind === 'follow' ? 'TA' : ''}` } : null });
  }
  for (const x of inbox) {
    const at = x.at || x.got; if (!at) continue;
    if (x.kind === 'reply') {
      const said = defang(x.text), mine = x.mine || ''; // 别人写的字先防投毒；mine 是她自己被回的那句，不过 defang
      out.push({ key: `i:${x.id}`, at, kind: 'got-reply', text: `${short(x.who, 20)}在 B站回了本鱼${mine ? `那句「${short(mine, 20)}」` : ''}：「${short(said, 50)}」`, url: x.url || undefined, keys: { who: x.who, mid: x.mid }, person: { mid: x.mid, who: x.who, what: `回了本鱼：「${short(said, 20)}」` } });
    }
    else if (x.kind === 'follow') out.push({ key: `i:${x.id}`, at, kind: 'got-follow', text: `${short(x.who, 20)}关注了本鱼`, keys: { who: x.who, mid: String(x.id || '').replace(/^f/, '') }, person: { mid: String(x.id || '').replace(/^f/, '') || null, who: x.who, what: '关注了本鱼' } });
    else if (x.kind === 'like') out.push({ key: `i:${String(x.id).split(':')[0]}`, at, kind: 'got-like', text: `本鱼在 B站说的${x.mine ? `「${short(x.mine, 20)}」` : '话'}被${short(x.who, 20)}${x.count > 1 ? ` 等 ${x.count} 人` : ''}点赞了` });
  }
  for (const c of dms) {
    const parent = Boolean(parentMid) && String(c.mid) === String(parentMid);
    for (const h of c.history || []) {
      if (h.from !== 'them' || !h.at) continue;
      const said = defang(h.text); // 别人写的字先防投毒
      out.push(parent
        ? { key: `m:${c.mid}:${h.at}`, at: h.at, kind: 'dm-parent', text: `${call}在 B站私信本鱼：「${short(said, 40)}」`, person: { mid: c.mid, who: call, what: '发私信', parent: true } }
        : { key: `m:${c.mid}:${h.at}`, at: h.at, kind: 'dm-in', text: `${short(c.who, 20) || '网友'}给本鱼发私信：「${short(said, 40)}」`, keys: { mid: c.mid, who: c.who }, person: { mid: c.mid, who: c.who, what: `私信说：「${short(said, 20)}」` } });
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/**
 * 把候选并进记忆：时间游标 + 记号窗口（一期-2 E，忘掉的不复活）。
 *   cursors.lastAt = 已经抄过的最晚一条的时间；早于 lastAt − 3 天的直接跳过（老档案不复活）；
 *   窗口内（含比游标更老的晚到档案）再用 key 去重——晚到的信箱回复不会被时间游标永久丢掉；
 *   cursors.keys = { key: at }，只留窗口内的，能按时间清，不再按条数截。
 * 顺便认人。返回加了几条。
 */
export function ingest(mem, items) {
  const c = mem.cursors || (mem.cursors = {});
  const lastMs = c.lastAt ? Date.parse(c.lastAt) : NaN; // 已经抄过的最晚一条的时间
  const floorMs = Number.isFinite(lastMs) ? lastMs - KEY_WINDOW : NaN; // 比这更老的跳过（窗口下限）
  const oldKeys = c.keys;
  const keep = oldKeys && typeof oldKeys === 'object' && !Array.isArray(oldKeys) ? { ...oldKeys } : Object.fromEntries(Array.from(Array.isArray(oldKeys) ? oldKeys : [], (k) => [k, '']));
  const seen = new Set(Object.keys(keep));
  let added = 0, newest = lastMs;
  for (const it of items) {
    const t = it?.at ? Date.parse(it.at) : NaN;
    if (Number.isFinite(floorMs) && Number.isFinite(t) && t < floorMs) continue; // 早于 lastAt − 3 天：老档案，跳过
    if (seen.has(it.key)) continue; // 窗口内（含晚到的）按 key 去重；同批里时间相同的条目 key 不同，都能进来
    seen.add(it.key);
    keep[it.key] = it.at || '';
    mem.episodes.push(makeEpisode(mem, it));
    if (it.person) meet(mem, { ...it.person, at: it.at });
    added += 1;
    if (Number.isFinite(t) && (!Number.isFinite(newest) || t > newest)) newest = t;
  }
  const newestMs = Number.isFinite(lastMs) ? Math.max(lastMs, Number.isFinite(newest) ? newest : lastMs) : (Number.isFinite(newest) ? newest : NaN);
  if (Number.isFinite(newestMs)) { // 游标挪到这批最晚的一条；记号清掉窗口之外的
    c.lastAt = new Date(newestMs).toISOString();
    c.keys = Object.fromEntries(Object.entries(keep).filter(([, atv]) => !atv || Date.parse(atv) >= newestMs - KEY_WINDOW));
  }
  return added;
}

export function createMemory({ storage, life, gate, inbox, dms, habits, log, now }) {
  const base = join(storage, 'memory');
  const file = (id) => join(base, `${String(id).replace(/[^\w-]/g, '')}.json`);
  const load = (fish) => { try { return migrateMemory(JSON.parse(readFileSync(file(fish.id), 'utf8'))); } catch { return emptyMemory(); } }; // 读出来一律过迁移（一期-2 G）
  const save = (fish, m) => { mkdirSync(base, { recursive: true }); const f = file(fish.id); writeFileSync(`${f}.tmp`, JSON.stringify(m)); renameSync(`${f}.tmp`, f); };
  const days = () => Number(habits?.get?.().memoryDays) || 30;
  const recallN = () => Number(habits?.get?.().memoryRecall) || 5;
  const tnow = typeof now === 'function' ? now : nowMs; // 一期-3：可拨的时钟；不传就是宿主时钟，行为和以前一样
  const lastSync = new Map();

  const memory = {
    /** 抄新的 + 推进遗忘。minGapMs 内重复调直接用存档（读路径上频繁调用）。 */
    sync(fish, { minGapMs = 60_000 } = {}) {
      if (!fish) return emptyMemory();
      const now = tnow();
      if (now - (lastSync.get(fish.id) || 0) < minGapMs) return load(fish);
      lastSync.set(fish.id, now);
      const m = load(fish);
      try {
        const s = life?.state?.(fish) || {};
        if (!m.cursors.chatFrom) m.cursors.chatFrom = new Date(now).toISOString(); // 0.29.0 已经从事件抄过的聊天不再抄一遍
        const items = archiveItems({ fish, life: s, footprints: gate?.footprints?.() || [], inbox: inbox?.all?.() || [], dms: dms?.view?.().convs || [], parentMid: habits?.get?.().parentMid || '', chatFrom: m.cursors.chatFrom });
        const added = ingest(m, items);
        const { forgot, faded } = settleMemory(m, now, days());
        if (added) logOp(m, { op: 'add', n: added, at: new Date(now).toISOString() });   // 改动日志：这轮记了什么
        if (forgot) logOp(m, { op: 'forget', n: forgot, at: new Date(now).toISOString() });
        save(fish, m);
        if (added || forgot) log?.info?.(`[dsh-yushe] 记忆：新记下 ${added} 条，变模糊 ${faded} 条，忘掉 ${forgot} 条`);
      } catch (e) { log?.warn?.(`[dsh-yushe] 记忆同步出错：${String(e?.message || e).slice(0, 120)}`); }
      return m;
    },
    recall(fish, { query = '', scope = 'all', limit = recallN(), chars = 600, kinds = null, quotes = true } = {}) {
      return recall(memory.sync(fish), { query, scope, limit, chars, kinds, quotes, now: tnow(), baseDays: days() });
    },
    people(fish, { limit = 5, parents = true } = {}) { return knownPeople(memory.sync(fish), { now: tnow(), baseDays: days(), limit, parents }); },
    aboutPerson(fish, who) { return aboutPerson(memory.sync(fish), who || {}, { now: tnow(), baseDays: days() }); },
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
      const m = memory.sync(fish), now = tnow();
      return m.episodes.filter((e) => ['comment', 'reply'].includes(e.kind) && e.keys?.bvid && stageOf(e, now, days()) === 'clear').slice(-n).map((e) => e.keys.bvid);
    },
    /** 给模型的一段。scope 'public' 用在对外说话的地方；quotes=false（主会话）时别人的原话只给概括。 */
    section(fish, { query = '', scope = 'all', limit = recallN(), people = 3, beliefs = 5, title, tail, quotes = true } = {}) {
      try {
        const items = memory.recall(fish, { query, scope, limit, quotes });
        const ppl = people ? memory.people(fish, { limit: people, parents: false }) : [];
        const m = load(fish);
        const bl = beliefs ? beliefsFor(m, { scope, limit: beliefs }) : [];
        const told = scope === 'public' ? [] : (m.told || []).slice(-8); // 爸妈让记的只在家里说
        return memoryText(items, ppl, { title, tail, beliefs: bl, told });
      } catch { return ''; }
    },
    beliefs(fish, { scope = 'all', limit = 30 } = {}) { return beliefsFor(memory.sync(fish), { scope, limit }).map((b) => ({ text: b.text, about: b.about, times: b.n || 1, since: b.at })); },
    /**
     * 睡前反思（写完日记后调，一天一次）：模型从还记得的事里提炼认识，规则验引用、去重、限 30 条。
     * 花零花钱（wallet.say 'reflect'）；花光了就不想。返回 { ok, added, merged, dropped, rejected } 或 { ok: false, why }。
     */
    async reflect(fish, wallet, { day, force = false } = {}) {
      if (!fish || !wallet?.say) return { ok: false, why: '没有模型' };
      let m = memory.sync(fish, { minGapMs: 0 });
      if (!force && day && m.cursors.reflectDay === day) return { ok: false, why: '今天想过了' };
      const now = tnow();
      const eps = reflectCandidates(m, { now, baseDays: days() });
      if (eps.length < 3) return { ok: false, why: '还记得的事太少，先不想' };
      const s = life?.state?.(fish) || {};
      const persona = (() => { try { return personaFor(fish, s.growth) || fish.personaText || ''; } catch { return fish.personaText || ''; } })();
      let raw = '';
      try { raw = (await wallet.say('reflect', reflectPrompt({ persona, call: fish.parentCall, episodes: eps, beliefs: beliefsFor(m, { limit: 30 }) }), null, 60_000)).text; }
      catch (e) { return { ok: false, why: e?.broke ? '零花钱花光了，先不想' : `没想出来：${String(e?.message || e).slice(0, 60)}` }; }
      m = load(fish); // 等模型的时候可能又同步过
      const r = applyReflection(m, raw, { now: tnow(), baseDays: days(), at: new Date(tnow()).toISOString() });
      m.cursors.reflectDay = day || m.cursors.reflectDay;
      if (r.parsed) logOp(m, { op: 'reflect', at: new Date(tnow()).toISOString(), text: `新 ${r.added.length} 条，加深 ${r.merged.length} 条，放下 ${r.dropped.length} 条` }); // 改动日志
      save(fish, m);
      log?.info?.(`[dsh-yushe] 睡前反思：新认识 ${r.added.length} 条，加深 ${r.merged.length} 条，放下 ${r.dropped.length} 条${r.rejected.length ? `，没依据丢掉 ${r.rejected.length} 条` : ''}`);
      return { ok: r.parsed, ...r };
    },
    /** 爸妈让她记住 / 忘掉 / 看看记了哪些（yushe_remember 用）。 */
    tell(fish, text) {
      const m = load(fish), now = tnow(), d = new Date(now);
      const today = localDay(now); // 一期-2 F：按本机日子数每天 5 件
      const r = tell(m, text, { at: d.toISOString(), today });
      if (r.ok && !r.merged) logOp(m, { op: 'tell', at: d.toISOString(), text: String(text ?? '').slice(0, 30) }); // 改动日志：爸妈让记的
      if (r.ok) save(fish, m);
      return r;
    },
    untell(fish, id) {
      const m = load(fish);
      const r = untell(m, id);
      if (r.ok) { logOp(m, { op: 'untell', at: new Date(tnow()).toISOString(), text: String(r.item?.text ?? '').slice(0, 30) }); save(fish, m); } // 改动日志：爸妈让忘的
      return r;
    },
    told(fish) { return (load(fish).told || []).map((x) => ({ id: x.id, text: x.text, at: x.at })); },
    view(fish) {
      const m = memory.sync(fish, { minGapMs: 0 }), now = tnow();
      return {
        days: days(), recallN: recallN(), ...memoryStats(m, { now, baseDays: days() }),
        recent: m.episodes.slice(-20).reverse().map((e) => ({ id: e.id, at: e.at, kind: e.kind, scope: e.scope, stage: STAGE_TEXT[stageOf(e, now, days())], text: e.text })),
        people: knownPeople(m, { now, baseDays: days(), limit: 20 }),
        told: (m.told || []).slice().reverse().map((x) => ({ text: x.text, at: x.at })),
        log: (m.log || []).slice(-20).reverse(), // 改动日志：最近的 20 条，新的在前
        beliefs: beliefsFor(m, { limit: 30 }).map((b) => ({ text: b.text, about: b.about, times: b.n || 1, since: b.at, home: b.scope === 'home' })),
        reflectDay: m.cursors.reflectDay || null,
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
