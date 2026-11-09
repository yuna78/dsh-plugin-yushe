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
 *   memory.summarize(fish, wallet, {day}) 三期：写完日记、反思之后写周记 / 章节（一晚最多各一篇）
 *   GET /api/dsh-yushe/memory            给页面：各阶段几条、认识几个人、最近记得的事
 *
 * 存 <storage>/memory/<fishId>.json，一条鱼一个文件。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowMs } from './clock.js';
import { emptyMemory, migrateMemory, makeEpisode, meet, settleMemory, recall, knownPeople, aboutPerson, memoryText, memoryStats, stageOf, STAGE_TEXT, reflectCandidates, reflectPrompt, applyReflection, settleBeliefs, beliefsFor, activeBeliefs, tell, untell, localDay, defang, logOp, toldDueAge, toldLine, pickWeek, pickMonth, weekMaterial, monthMaterial, checkWeekly, checkChapter, weeklyPrompt, chapterPrompt, settleWeeklies, mergeChapters, recentLines, weeklyStage, weeklyStatus, nextId, WEEKLY_STAGE_TEXT, MAX_PINNED, cleanTold, dueOf, fixBelief, fixLogText, dropItem, dropLogText, findTarget } from '../shared/memory.js';
import { personaFor } from '../shared/growth.js';
import { homeMemKind } from '../shared/home.js'; // F-87 在家：读到哪层 → 记多重

export const MEMORY_PATH = '/api/dsh-yushe/memory';
const KEY_WINDOW = 3 * 86400e3; // 记号窗口：只留游标前 3 天内的 key，按时间清，不按条数截（一期-2 E）
const PROPOSAL_MS = 30 * 60e3; // 四期-3：起草单 30 分钟有效、用一次就删、只对同一条鱼（和配置三件套一个规矩）
const fixKindLog = (pfx) => (pfx === 'T' ? '爸妈让记的' : '认识');
const shown = (item) => String(item?.text ?? item?.headline ?? '');
const EVENT_KINDS = { born: 'born', mood: 'mood', nap: 'nap', 'late-work': 'late-work', feed: 'feed', news: 'news' }; // 聊天从 chat 记录抄（带她怎么回的），不从事件抄
const FOOT_KINDS = { comment: 'comment', reply: 'reply', post: 'post', dyncomment: 'dyncomment', dm: 'dm', like: 'like', comment_like: 'comment_like', collect: 'collect', follow: 'follow', unfollow: 'unfollow' };
const FOOT_WHAT = { comment: '评论了视频', reply: '回复了评论', post: '发了动态', dyncomment: '评论了动态', dm: '回了私信', like: '点赞了视频', comment_like: '给评论点了赞', collect: '收藏了视频', follow: '关注了', unfollow: '取关了' };
const short = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** 给人看的认识（规格 4）：规则词不出门，state 一律白话。带 id（四期-1 A：她说「别提那条认识」时好对号，页面不显示）。 */
const shownBelief = (b) => ({ id: b.id, text: b.text, why: b.why || '', effect: b.effect || '', about: b.about, state: b.status === '暂定' ? '还在想' : '想明白了', times: b.n || 1, since: b.at, source: b.source || 'reflect' }); // source 也给页面（四期-3 K：爸妈纠的标「纠正过」，只显示）

/** 档案 → 一串「候选经历」（带去重 key）。纯函数，verify 直接测。 */
export function archiveItems({ fish, life = {}, footprints = [], inbox = [], dms = [], parentMid = '', chatFrom = '' }) {
  const call = fish?.parentCall || '爸妈';
  const out = [];
  const dedup = new Set(); // F-87：同一天同一条视频只出一条（key 按视频 + 本地日子去重，取第一次）
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
    if (j.final && j.text) out.push({ key: `j:${j.trip || j.at}:card`, at: j.at, kind: 'postcard', text: `出门回来给${call}写明信片：${short(j.text, 100)}` }); // F-84 以后明信片在路上寄（album），这页只有读过清单
    for (const x of j.seen || []) if (x?.url) {
      const bvid = String(x.url).match(/BV[0-9A-Za-z]{10}/)?.[0];
      const where = `${bvid ? '在 B站看了' : `在${short(x.source, 10) || '网上'}看到`}《${defang(short(x.title, 50))}》`;
      // F-82：便利贴记得更清楚——「学到的」「好点子」imp 3，带上标签、她的一句话和讲了啥（讲了啥是转述外部内容，防投毒）
      if (j.note) out.push({ key: `s:${bvid || x.url}`, at: j.at, kind: ['学到的', '好点子'].includes(j.note.tag) ? 'note' : 'seen', text: `${where}，记了一张「${short(j.note.tag, 4)}」：${defang(short(j.text, 50))}${j.note.gist ? `（讲的是：${defang(short(j.note.gist, 40))}）` : ''}`, url: x.url, keys: { bvid, tag: x.tag, who: x.up, mid: x.mid } });
      else out.push({ key: `s:${bvid || x.url}`, at: j.at, kind: 'seen', text: `${where}${!j.final && j.text ? `，${short(j.text, 40)}` : ''}`, url: x.url, keys: { bvid, tag: x.tag, who: x.up, mid: x.mid } });
    }
  }
  // F-87 在家-1：清单「刷过的」里点开过的每条都进记忆（读多深定 imp，只扫标题的不进，流水账里查得到）。
  // 带态度：喜欢 / 不喜欢（带理由）照抄她的话，踩雷也是她。别人写的标题先防投毒。
  // 在家写了便利贴的那条，便利贴已经记过一次（note / seen），清单卡里同一天同一条不再记
  const homeNoted = new Set((life.journal || []).filter((j) => j?.home && j.note && j.at).flatMap((j) => (j.seen || []).map((x) => `${String(x?.url || '').match(/BV[0-9A-Za-z]{10}/)?.[0] || x?.url}:${localDay(j.at)}`)));
  for (const card of life.homeCards || []) {
    if (!card?.at) continue;
    const day = localDay(card.at);
    if (!day) continue;
    for (const x of card.read || []) {
      if (!x?.url) continue;
      const kind = homeMemKind(x.depth, x.acts);
      if (!kind) continue;
      const bvid = String(x.url).match(/BV[0-9A-Za-z]{10}/)?.[0];
      const key = `h:${bvid || x.url}:${day}`;
      if (dedup.has(key) || homeNoted.has(`${bvid || x.url}:${day}`)) continue;
      dedup.add(key);
      const like = String(x.like || '').slice(0, 4);
      const why = short(x.why, 20);
      const att = like === '不喜欢' ? `，不喜欢${why ? `：${why}` : ''}` : like === '喜欢' ? `，说了喜欢${why ? `，因为${why}` : ''}` : like ? `，觉得${like}` : '';
      out.push({ key, at: card.at, kind, text: `在家刷 B站点开了《${defang(short(x.title, 50))}》${att}`, url: x.url, keys: { bvid, tag: x.tag, who: x.up } });
    }
  }
  // F-84/F-85：路上寄回的明信片（没拍成照片的那张）。她说哪种就记成哪种（想你的 / 口信明信片）；见闻照旧带着是看《什么》时写的
  const SAY_TEXT = { 想你: '想你的', 口信: '口信' };
  for (const p of life.album || []) if (!p.photo && p.pc && p.at && p.text) out.push({ key: `j:${p.trip || p.at}:card`, at: p.at, kind: 'postcard', text: `在外面给${call}寄了张${SAY_TEXT[p.say] ? `${SAY_TEXT[p.say]}明信片` : `明信片${p.ref?.title ? `（看《${defang(short(p.ref.title, 30))}》时）` : ''}`}：${short(p.text, 80)}`, url: p.ref?.url || undefined });
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
  const proposals = new Map(); // 四期-3：起草单（fix / drop 共用一张：yushe_remember 的 forget 也是这张）：proposalId → { fishId, kind, target, text, at }；30 分钟有效、用一次就删、只对同一条鱼
  let proposalSeq = 0;
  /** 四期-3：单还有没有效（30 分钟内、没过期、属于这条鱼）。不认识 / 不是这条鱼 / 过期 → ok:false，什么都不改。 */
  const takeProposal = (fish, proposalId) => {
    const pid = String(proposalId ?? '').trim();
    const p = proposals.get(pid);
    if (!p) return { ok: false, why: '这张单子已经不在了（可能那件已经办完，或者起草错了号码），把爸妈的意思再给本鱼说一遍，重新起草一次' };
    if (p.fishId !== String(fish.id)) return { ok: false, why: '这张单子不是这条鱼的单，本鱼办不了' };
    if (tnow() - p.at > PROPOSAL_MS) { proposals.delete(pid); return { ok: false, why: '起草已经过了 30 分钟，单子作废了；重新起草一次，爸妈再确认一遍' }; }
    return { ok: true, p };
  };

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
        settleWeeklies(m, now, days()); // 三期：周记也慢慢模糊（半衰期 × 6）；章节不忘
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
    /** 她主动想起来：加深（只有主动回忆算；同一条 7 天内最多加深 1 次，四期-1 B）。 */
    reinforce(fish, ids = []) {
      if (!ids.length) return 0;
      const m = load(fish); const now = tnow(); const set = new Set(ids); let n = 0;
      for (const ep of m.episodes) {
        if (!set.has(ep.id)) continue;
        if (ep.reinforcedAt && now - Date.parse(ep.reinforcedAt) < 7 * 86400e3) continue; // 距上次加深不到 7 天：跳过、不计数、reinforcedAt 不动
        ep.reinforced = Math.min(5, (ep.reinforced || 0) + 1);
        ep.reinforcedAt = new Date(now).toISOString();
        n += 1;
      }
      if (n) save(fish, m);
      return n;
    },
    /** 最近评论 / 回复过的视频（出门时提醒别重复评论）：只算还清楚记得的。 */
    recentlyCommented(fish, n = 6) {
      const m = memory.sync(fish), now = tnow();
      return m.episodes.filter((e) => ['comment', 'reply'].includes(e.kind) && e.keys?.bvid && stageOf(e, now, days()) === 'clear').slice(-n).map((e) => e.keys.bvid);
    },
    /** 给模型的一段。scope 'public' 用在对外说话的地方；quotes=false（主会话）时别人的原话只给概括。 */
    section(fish, { query = '', scope = 'all', limit = recallN(), people = 3, beliefs = 5, title, tail, quotes = true, excludeKinds = null } = {}) {
      try {
        const items = memory.recall(fish, { query, scope, limit, quotes, excludeKinds });
        const ppl = people ? memory.people(fish, { limit: people, parents: false }) : [];
        const m = load(fish);
        const bl = beliefs ? beliefsFor(m, { scope, limit: beliefs }) : []; // 只给想明白了的（二期：暂定的先不注入）
        const today = localDay(tnow()); // 四期-1 C：带日子的嘱咐按「现在」解释（due 在记下那一刻就定死了）；没日子的那行一字不差
        const told = scope === 'public' ? [] : (m.told || []).filter((x) => !x.muted).map((x) => ({ ...x, text: toldLine(x, today) })).filter((x) => x.text).slice(-8); // 先滤掉不提的（四期-2 D）和过期 > 7 天的再取最后 8 条，到日子的那条不会被挤出窗 // 爸妈让记的只在家里说
        const recent = scope === 'all' ? recentLines(m, { now: tnow(), baseDays: days() }) : []; // 三期【这阵子】：只在家里（主会话 / 鱼社房间），出门没有
        return memoryText(items, ppl, { title, tail, beliefs: bl, told, recent });
      } catch { return ''; }
    },
    /** 她的认识（生效 + 暂定）：每条带白话 state，规则词不出门（yushe_recall 的 beliefs 用）。不再提的（四期-2 D）不还它。 */
    beliefs(fish, { scope = 'all', limit = 30 } = {}) {
      const active = activeBeliefs(memory.sync(fish), { scope, limit });
      return active.filter((b) => !b.muted).map(shownBelief);
    },
    /** 想法怎么变的（最近的变化记录，新的在前）：yushe_recall 的 changes 和页面用。不再提的认识的变化不在里面（四期-2 补 R4）。 */
    changes(fish, { limit = 10, scope = 'all' } = {}) {
      const m = memory.sync(fish);
      const mutedTexts = new Set((m.beliefs || []).filter((b) => b.muted).map((b) => b.text)); // 这条变化记的是不再提的认识的原话 → 也不给翻回来（四期-2 补 R4）
      const c = (m.changes || [])
        .filter((x) => !mutedTexts.has(x.before) && !mutedTexts.has(x.after))
        .filter((x) => scope !== 'public' || x.scope === 'public'); // 出门只给 B站范围的变化；老记录没写范围的按家里算
      return c.slice(-limit).reverse().map((x) => ({ kind: x.kind, before: x.before, after: x.after, why: x.why, at: x.at }));
    },
    /**
     * 睡前反思（写完日记后调，一天一次）：先收尾 beliefs（暂定 → 生效 / 放下，规则 3.4），再让模型从还记得的事里提炼认识，规则验依据、去重、上限。
     * 花零花钱（wallet.say 'reflect'）；花光了就不想。返回 { ok, added, merged, dropped, rejected } 或 { ok: false, why }。
     */
    async reflect(fish, wallet, { day, force = false } = {}) {
      if (!fish || !wallet?.say) return { ok: false, why: '没有模型' };
      let m = memory.sync(fish, { minGapMs: 0 });
      if (!force && day && m.cursors.reflectDay === day) return { ok: false, why: '今天想过了' };
      const now = tnow();
      const settled = settleBeliefs(m, { now, baseDays: days(), day }); // 调模型之前先收尾：暂定的去留不交给模型（规则 3.4）
      save(fish, m); // 站住了 / 放下的这步先落盘
      const settledN = settled.confirmed.length + settled.retired.length + settled.superseded.length + settled.dropped.length;
      if (settledN) log?.info?.(`[dsh-yushe] 认识收尾：站住了 ${settled.confirmed.length} 条、换成新说法 ${settled.superseded.length} 条、放下 ${settled.dropped.length + settled.retired.length} 条`);
      const eps = reflectCandidates(m, { now, baseDays: days() });
      if (eps.length < 3) return { ok: false, why: '还记得的事太少，先不想' };
      const s = life?.state?.(fish) || {};
      const persona = (() => { try { return personaFor(fish, s.growth) || fish.personaText || ''; } catch { return fish.personaText || ''; } })();
      let raw = '';
      try { raw = (await wallet.say('reflect', reflectPrompt({ persona, call: fish.parentCall, episodes: eps, beliefs: activeBeliefs(m, { limit: 30 }).filter((b) => !b.muted) }), null, 60_000)).text; } // 不再提的认识不进反思提示词（四期-2 补 R2）
      catch (e) { return { ok: false, why: e?.broke ? '零花钱花光了，先不想' : `没想出来：${String(e?.message || e).slice(0, 60)}` }; }
      m = load(fish); // 等模型的时候可能又同步过
      const r = applyReflection(m, raw, { now: tnow(), baseDays: days(), at: new Date(tnow()).toISOString() });
      m.cursors.reflectDay = day || m.cursors.reflectDay;
      if (r.parsed) logOp(m, { op: 'reflect', at: new Date(tnow()).toISOString(), text: `新 ${r.added.length} 条，加深 ${r.merged.length} 条，放下 ${r.dropped.length} 条` }); // 改动日志
      save(fish, m);
      log?.info?.(`[dsh-yushe] 睡前反思：新认识 ${r.added.length} 条，加深 ${r.merged.length} 条，放下 ${r.dropped.length} 条${r.rejected.length ? `，没依据丢掉 ${r.rejected.length} 条` : ''}`);
      return { ok: r.parsed, ...r };
    },
    /**
     * 三期 · 回忆录（写完日记、反思之后调，一晚一次）：最多写一篇周记 + 一章。规则挑哪周 / 哪个月、算统计、验收，
     * 引用不够或编了标题 / 数字就打回重写一次；零花钱花光就跳过（下次再补）。返回 { weekly, chapter, merged }。
     */
    async summarize(fish, wallet, { day, force = false } = {}) {
      if (!fish || !wallet?.say) return { ok: false, why: '没有模型' };
      let m = memory.sync(fish, { minGapMs: 0 });
      const now = tnow(), today = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : localDay(now);
      if (!force && m.cursors.summarizeDay === today) return { ok: false, why: '今晚写过了' };
      m.cursors.summarizeDay = today;
      const merged = mergeChapters(m); // 超了先按规则合并最早的两章
      save(fish, m);
      const s = life?.state?.(fish) || {};
      const persona = (() => { try { return personaFor(fish, s.growth) || fish.personaText || ''; } catch { return fish.personaText || ''; } })();
      const opts = { now, baseDays: days() };
      const write = async (kind, makePrompt, check, keep) => {
        let fix = '';
        for (let round = 1; round <= 2; round++) {
          let raw = '';
          try { raw = (await wallet.say(kind, makePrompt(fix), null, 60_000)).text; }
          catch (e) { return { ok: false, why: e?.broke ? '零花钱花光了，下次再写' : `没写出来：${String(e?.message || e).slice(0, 60)}` }; }
          const r = check(raw);
          if (r.ok) { m = load(fish); const entry = keep(r.entry); save(fish, m); return { ok: true, id: entry.id }; }
          if (!r.retry || round === 2) return { ok: false, why: r.why };
          fix = r.why;
        }
        return { ok: false, why: '没写成' };
      };
      const out = { ok: true, merged, weekly: null, chapter: null };
      const week = pickWeek(m, today, opts);
      if (week) {
        const mat = weekMaterial(m, week, s, opts);
        out.weekly = await write('weekly', (fix) => weeklyPrompt({ persona, call: fish.parentCall, mat, fix }), (raw) => checkWeekly(mat, raw), (entry) => {
          const at = new Date(tnow()).toISOString(), w = { id: nextId(m.weeklies, 'W'), ...entry, at };
          m.weeklies = [...(m.weeklies || []), w];
          logOp(m, { op: 'weekly', at, text: `${w.from}–${w.to}：${w.headline}` });
          return w;
        });
        log?.info?.(`[dsh-yushe] 周记（${week} 那周）：${out.weekly.ok ? '写好了' : out.weekly.why}`);
      }
      m = load(fish);
      const month = pickMonth(m, today, s);
      if (month) {
        const mat = monthMaterial(m, month, s);
        out.chapter = await write('chapter', (fix) => chapterPrompt({ persona, call: fish.parentCall, mat, fix }), (raw) => checkChapter(mat, raw), (entry) => {
          const at = new Date(tnow()).toISOString(), c = { id: nextId(m.chapters, 'C'), ...entry, at };
          m.chapters = [...(m.chapters || []), c];
          logOp(m, { op: 'chapter', at, text: `${c.month}「${c.title}」` });
          return c;
        });
        log?.info?.(`[dsh-yushe] 回忆录（${month}）：${out.chapter.ok ? '写好了一章' : out.chapter.why}`);
      }
      return out;
    },
    /** 周记（新的在前，白话阶段）：yushe_recall 的 weekly 和页面用。带 id（四期-1 A）。不再提的周记不在里面（四期-2 补 R4）。 */
    weeklies(fish, { limit = 8 } = {}) {
      const m = memory.sync(fish), now = tnow();
      return (m.weeklies || []).filter((w) => !w.muted).sort((a, b) => String(b.from).localeCompare(String(a.from))).slice(0, limit) // 先滤再截，不再提的不占名额
        .map((w) => ({ id: w.id, from: w.from, to: w.to, headline: w.headline, text: w.text, stage: WEEKLY_STAGE_TEXT[weeklyStage(w, now, days())] || '只剩印象' }));
    },
    /** 章节（新的在前）。 */
    chapters(fish) {
      return (memory.sync(fish).chapters || []).slice().sort((a, b) => String(b.month).localeCompare(String(a.month)))
        .map((c) => ({ month: c.toMonth && c.toMonth !== c.month ? `${c.month}～${c.toMonth}` : c.month, title: c.title, headline: c.headline, text: c.text }));
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
    /**
     * 四期-3 I / J：两步走的第一步——只起草、不办事，按 now() 存起草单（30 分钟有效、用一次就删、只对同一条鱼）。
     * tool 拿返回值把 before / after（fix）或 what（drop）用大白话复述给爸妈，爸妈说对了再带 proposalId + confirm:true 调确认。
     * kind 'fix'：B 认识 / T 爸妈让记的（M 经历不给改，指路让忘掉再记对的）；kind 'drop'：M / B / T / W。报错都是白话。
     */
    propose(fish, kind, target, text = '') {
      if (kind !== 'fix' && kind !== 'drop') return { ok: false, why: '要说是「改掉记错的」还是「忘掉一件事」' };
      const m = load(fish), now = tnow(), at = new Date(now).toISOString();
      if (kind === 'fix' && String(target ?? '').trim()[0] === 'W') return { ok: false, why: '周记是她自己回想着写的，记错了就让她忘掉这篇（yushe_memory_drop）' }; // 规格 I：fix 只收 B / T（reviewer 11-09）
      if (kind === 'fix' && String(target ?? '').trim()[0] === 'M') return { ok: false, why: '经历记错了就让她忘掉，再让她记住对的（先 yushe_memory_drop 把这条忘掉，再让她记一条对的）' };
      const fnd = findTarget(m, target);
      if (!fnd.ok) return fnd;
      const pfx = fnd.item.id[0];
      let after = '', before = '';
      if (kind === 'fix') {
        if (pfx === 'B' && !['生效', '暂定'].includes(fnd.item.status || '生效')) return { ok: false, why: '这条认识已经不算数了，不用改' };
        const c = cleanTold(text);
        if (!c.ok) return { ok: false, why: c.why };
        before = shown(fnd.item);
        after = pfx === 'B' ? c.text.slice(0, 30) : c.text; // 认识的说法截到 30（认识的长度上限）
      } else {
        after = `${fnd.kind.what}：${shown(fnd.item).slice(0, 40)}`; // 复述给爸妈的：白话种类 + 那条的前 40 字
      }
      const id = `P${now.toString(36)}${(proposalSeq += 1).toString(36)}`;
      proposals.set(id, { fishId: String(fish.id), kind, target: fnd.item.id, text: after, at: now, atIso: at });
      return { ok: true, proposalId: id, before, after, what: after, kind: fnd.kind.what, log: kind === 'fix' ? fixKindLog(pfx) : fnd.kind.log };
    },
    /** 四期-3 I：确认改（认识 / 爸妈让记的）。返回 { ok, id, text } 或 { ok: false, why }；单用一次就删。 */
    applyFix(fish, proposalId) {
      const t = takeProposal(fish, proposalId);
      if (!t.ok) return t;
      proposals.delete(String(proposalId ?? '').trim()); // 用一次就删：办没办成都算用过
      const m = load(fish), now = tnow(), at = new Date(now).toISOString();
      if (t.p.kind !== 'fix') return { ok: false, why: '这张单子是「忘掉」用的，不是「改」，重新起草' }; // 确认只办起草时说的那件事（reviewer 11-09）
      const fnd = findTarget(m, t.p.target);
      if (!fnd.ok) return fnd;
      if (!['beliefs', 'told'].includes(fnd.kind.arr)) return { ok: false, why: '只有认识和爸妈让记的能改' };
      if (fnd.kind.arr === 'beliefs') {
        if (!['生效', '暂定'].includes(fnd.item.status || '生效')) return { ok: false, why: '这条认识已经不算数了，不用改' };
        const nb = fixBelief(m, fnd.item, t.p.text, { at, call: fish.parentCall }); // 旧的被取代、新的 source 'parent'、changes 带 by 'parent'（规则都在 shared/memory.js）
        logOp(m, { op: 'fix', at, text: fixLogText('认识', fnd.item.text) }); // 改动日志：种类 + 旧说法前 20 字（I4）
        save(fish, m);
        return { ok: true, id: nb.id, text: t.p.text, kind: '认识', changed: t.p.text };
      }
      const head = shown(fnd.item), due = dueOf(t.p.text, now); // 爸妈让记的：直接换成新的说法，due 按这一刻重算（I11），记 fixedAt
      fnd.item.text = t.p.text; fnd.item.at = at;
      if (due) fnd.item.due = due; else delete fnd.item.due;
      fnd.item.fixedAt = at;
      logOp(m, { op: 'fix', at, text: fixLogText('爸妈让记的', head) });
      save(fish, m);
      return { ok: true, id: fnd.item.id, text: t.p.text, kind: '爸妈让记的', changed: t.p.text, fixedAt: at };
    },
    /** 四期-3 J：确认忘掉（M / B / T / W）。档案（日记、笔记本、足迹…）一个字都不动，返回里说明。 */
    applyDrop(fish, proposalId) {
      const t = takeProposal(fish, proposalId);
      if (!t.ok) return t;
      proposals.delete(String(proposalId ?? '').trim()); // 用一次就删
      if (t.p.kind !== 'drop') return { ok: false, why: '这张单子是「改」用的，不是「忘掉」，重新起草' }; // 确认只办起草时说的那件事（reviewer 11-09）
      const m = load(fish);
      const r = dropItem(m, t.p.target);
      if (!r.ok) return r;
      logOp(m, { op: 'drop', at: new Date(tnow()).toISOString(), text: dropLogText(r.kind) }); // 改动日志只写种类、不写内容（J8：忘掉的就别在日志里留着）
      save(fish, m);
      return { ok: true, kind: r.kind.log, item: r.item.id, text: shown(r.item), archive: '档案页照旧能看到（笔记本、日记、足迹都在），只是她这里忘掉了这件事' };
    },
    /**
     * 四期-2 D/E：按编号前缀找到那一条，改标记（不再提 / 记牢）。M 经历、B 认识、T 爸妈让记的、W 周记。
     * 只改标记不动内容：不删、能 unmute 恢复；pin 只对 M / B（T 本来就不忘）。报错都是白话。
     */
    mark(fish, id, op) {
      const cmd = op === 'mute' || op === 'unmute' || op === 'pin' || op === 'unpin' ? op : '';
      if (!cmd) return { ok: false, error: '要说是「不再提 / 再提」还是「记牢 / 不用记牢」了' };
      const m = load(fish);
      const sid = String(id ?? '').trim();
      const pfx = sid[0];
      const KIND = { M: { name: '一件经历', list: () => m.episodes }, B: { name: '一条认识', list: () => m.beliefs }, T: { name: '爸妈让记的', list: () => m.told }, W: { name: '一篇周记', list: () => m.weeklies } };
      const k = KIND[pfx];
      if (!k) return { ok: false, error: '没有这一条（编号不对，先用 yushe_recall 按爸妈说的话找到编号）' };
      if ((cmd === 'pin' || cmd === 'unpin') && pfx !== 'M' && pfx !== 'B') {
        if (pfx === 'T') return { ok: false, error: '爸妈让记的本来就不会忘，不用记牢' };
        return { ok: false, error: '记牢是给经历和认识的（M / B 开头的编号），别的用不上' };
      }
      const item = (k.list() || []).find((x) => x && x.id === sid);
      if (!item) return { ok: false, error: '没有这一条（先用 yushe_recall 按爸妈说的话找到编号）' };
      const now = tnow(), at = new Date(now).toISOString();
      if (cmd === 'mute' || cmd === 'unmute') {
        if (cmd === 'mute' && item.muted) return { ok: false, error: `这一条已经在不提了，不用再办` };
        if (cmd === 'unmute' && !item.muted) return { ok: false, error: `这一条本来就在提着，没有动` };
        if (cmd === 'mute') { item.muted = true; item.mutedAt = at; } else { delete item.muted; delete item.mutedAt; }
      } else {
        if (cmd === 'pin' && item.pinned) return { ok: false, error: `这一条本来就记牢了，不用再钉` };
        if (cmd === 'unpin' && !item.pinned) return { ok: false, error: `这一条没有记牢，不用松` };
        if (cmd === 'pin') {
          const nPinned = (m.episodes || []).filter((e) => e.pinned && stageOf(e, now, days()) !== 'forgotten').length // 额度只数还在的：已经忘了的经历不占（四期-2 补 R7）
            + (m.beliefs || []).filter((b) => b.pinned && (!b.status || ['生效', '暂定'].includes(b.status))).length; // 退役 / 被取代的认识不占（四期-2 补 R7）
          if (nPinned >= MAX_PINNED) return { ok: false, error: `钉住的已经有 ${MAX_PINNED} 条了，先松开一条` };
          item.pinned = true; item.pinnedAt = at;
        } else { delete item.pinned; delete item.pinnedAt; }
      }
      logOp(m, { op: cmd, at, text: `${k.name}「${String(item.text || item.headline || '').slice(0, 20)}」` }); // 改动记录：种类 + 前 20 字，爸妈好核对办的是哪条
      save(fish, m);
      return { ok: true, id: item.id, mark: cmd, kind: k.name, text: String(item.text || item.headline || '').slice(0, 60), muted: Boolean(item.muted), pinned: Boolean(item.pinned) };
    },
    /** 爸妈让她记住的（yushe_remember 的 list 用）：每条带 due（可能没有）和 past（布尔），四期-1 C16。muted / pinned（四期-2）也带。 */
    told(fish) {
      const today = localDay(tnow());
      return (load(fish).told || []).map((x) => {
        const age = toldDueAge(x, today);
        return { id: x.id, text: x.text, at: x.at, ...(x.due ? { due: x.due } : {}), past: age != null && age > 0, muted: Boolean(x.muted), pinned: Boolean(x.pinned) };
      });
    },
    view(fish) {
      const m = memory.sync(fish, { minGapMs: 0 }), now = tnow();
      return {
        days: days(), recallN: recallN(), ...memoryStats(m, { now, baseDays: days() }),
        recent: m.episodes.slice(-20).reverse().map((e) => ({ id: e.id, at: e.at, kind: e.kind, scope: e.scope, stage: STAGE_TEXT[stageOf(e, now, days())], text: e.text, pinned: Boolean(e.pinned), muted: Boolean(e.muted) })), // 钉住的永远「清晰」（stageOf 四期-2 E）；pinned / muted 给页面标「记牢了」「不再提」
        people: knownPeople(m, { now, baseDays: days(), limit: 20 }),
        told: (m.told || []).slice().reverse().map((x) => { const age = toldDueAge(x, localDay(now)); return { id: x.id, text: x.text, at: x.at, ...(x.due ? { due: x.due } : {}), past: age != null && age > 0, muted: Boolean(x.muted), pinned: Boolean(x.pinned) }; }), // 四期-1：带 id、due、past（页面给带日子的那条显示日子）；四期-2：带 pinned / muted
        log: (m.log || []).slice(-20).reverse(), // 改动日志：最近的 20 条，新的在前
        beliefs: activeBeliefs(m, { limit: 30 }).map((b) => ({ ...shownBelief(b), home: b.scope === 'home', pinned: Boolean(b.pinned), muted: Boolean(b.muted) })), // 四期-2：带 pinned / muted（页面标「记牢了」「不再提」；muted 的在这块还看得到，只是不注入）
        changes: (m.changes || []).slice(-30).reverse().map((x) => ({ kind: x.kind, before: x.before, after: x.after, why: x.why, at: x.at })).slice(0, 20), // 想法怎么变的：最近 20 条，新的在前
        reflectDay: m.cursors.reflectDay || null,
        weeklies: memory.weeklies(fish, { limit: 8 }), // 三期 · 回忆录：最近 8 篇周记（白话阶段）
        chapters: memory.chapters(fish),
        weeklyStatus: weeklyStatus(m, localDay(now), { now, baseDays: days() }), // 空的时候页面按真实状态说
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
