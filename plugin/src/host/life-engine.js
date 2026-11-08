/**
 * M3 · 回家：鱼的日常（作息 / 心情 / 精力 / 事件 / 聊天记录 / 日记）。
 *
 * 规则管结果（可预期、不花 token）：作息按本地时间、心情精力按经过的小时数结算；
 * AI 管表达：聊天回复、日记正文由宿主模型写（在 life-routes.js）。
 *
 * 存储：<storage>/life/<fishId>.json，一条鱼一个文件。
 * 时间推进是「懒结算」：每次读状态时按距上次结算过了多少小时补算，DSH 关着的时间也算（最多补 72 小时）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowMs, nowDate } from './clock.js';
import { roamStatus } from './probe.js';
import { activityOf, ACTIVITY_TEXT } from '../shared/room.js';
import { workDrain, lateNight, workToneNote } from '../shared/mood.js';
import { planNow } from '../shared/plan.js';
import { freshGrowth, dailyTick, gainXp, XP_RULES, feedInterests, feedDislikes } from '../shared/growth.js';
import { cardsDue, addToBag, souvenirById } from '../shared/trip.js';
import { DREAM_COST } from '../shared/dream.js';
import { postcardsDue, albumEntry } from '../shared/postcard.js';

export const JOURNAL_MAX = 400; // F-82：一趟最多 10 张便利贴 + 明信片，200 太紧
/** 便利贴 → journal 的一条（F-82：不另开数组，记忆 / 照片跳转都读 journal）。 */
export const noteEntry = (n, trip, at) => ({ at: new Date(at).toISOString(), text: n.line || '', seen: [{ title: n.title, url: n.url, source: n.source, tag: n.tag || undefined, up: n.up || undefined, mid: n.mid || undefined, verified: true, ...(n.photo ? { photo: n.photo } : {}) }], trip, note: { tag: n.note?.tag || '心得', gist: n.note?.gist || '', depth: n.note?.depth ?? null } });

export const SLEEP_FROM = 0;      // 00:00 睡
export const WAKE_AT = 7.5;       // 07:30 醒
const MAX_EVENTS = 200, MAX_CHAT = 40, MAX_DIARY = 60;
export const LIFE_VERSION = 7;

/**
 * 存档迁移：老版本的状态文件升到当前版本，不丢日记 / 相册 / 聊天 / 干活记录。
 * v1 → v2：补齐数组字段（v1 早期没有 album / work），加 version。以后加成长层也在这里接着写 v2 → v3。
 */
export function migrateLife(s, fish) {
  if (!s || typeof s !== 'object') return null;
  let m = { ...s };
  if (!m.version || m.version < 2) {
    m = { ...m, version: 2, events: Array.isArray(m.events) ? m.events : [], chat: Array.isArray(m.chat) ? m.chat : [], diary: Array.isArray(m.diary) ? m.diary : [], album: Array.isArray(m.album) ? m.album : [], work: m.work && typeof m.work === 'object' ? m.work : {} };
    if (!Number.isFinite(m.mood)) m.mood = 72;
    if (!Number.isFinite(m.energy)) m.energy = 82;
    if (!m.bornAt) m.bornAt = Date.parse(fish?.createdAt) || nowMs();
  }
  // v2 → v3：信箱、午睡、干活消耗累计、今天从爱意里涨了多少心情
  if (m.version < 3) m = { ...m, version: 3, letters: Array.isArray(m.letters) ? m.letters : [], napUntil: 0, workAcc: 0, moodGain: {} };
  // v3 → v4：成长层（出生值当起点）
  if (m.version < 4) m = { ...m, version: 4, growth: fish?.pts ? freshGrowth(fish, dayOf()) : null };
  if (!m.growth && fish?.pts) m.growth = freshGrowth(fish, dayOf());
  // v4 → v5：背包、正在进行的这一趟、上次回家的时间
  if (m.version < 5) m = { ...m, version: 5, bag: m.bag || { items: {}, gear: null }, trip: null, lastBackAt: 0 };
  // v5 → v6（F-46、F-47）：相册只放照片；以前相册里那些「标题 + 链接」的明信片挪进「见闻」
  if (m.version < 6) {
    const old = Array.isArray(m.album) ? m.album : [];
    m = { ...m, version: 6, journal: [...(m.journal || []), ...old.filter((x) => !x.photo)], album: old.filter((x) => x.photo) };
  }
  // v6 → v7（F-79 梦游）：她睡觉时也能读一轮，记在这一格；null = 今晚还没梦过 / 梦完了
  if (m.version < 7) m = { ...m, version: 7, dream: null, dreamTries: { day: '', n: 0 }, lastDreamDay: '' };
  // 手改过 / 旧版降级过的存档：数组字段兜一下，别让一次迭代直接抛
  for (const k of ['events', 'journal', 'chat', 'diary', 'album', 'letters']) if (!Array.isArray(m[k])) m[k] = [];
  return m;
}
const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
const clampF = (v) => Math.max(0, Math.min(100, Math.round(v * 1e4) / 1e4)); // 心情 / 精力小步结算，不能每步取整（房间每 15 秒刷一次，每步的变化会被四舍五入吃掉，F-60）
export const dayOf = (d = nowDate()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hourOf = (d) => d.getHours() + d.getMinutes() / 60;

/** 这个时刻她是不是在睡觉（规则：00:00–07:30）。 */
export function asleepAt(d = nowDate()) {
  const h = hourOf(d);
  return h >= SLEEP_FROM && h < WAKE_AT;
}

/** 心情 → 一个词 + 图标名（assets/icons/mood1–5.webp，给 UI 用；界面里不放 emoji）。 */
export function moodWord(mood) {
  if (mood >= 80) return ['超开心', 'mood5'];
  if (mood >= 60) return ['开心', 'mood4'];
  if (mood >= 40) return ['还行', 'mood3'];
  if (mood >= 20) return ['有点闷', 'mood2'];
  return ['想你了', 'mood1'];
}

/**
 * 从 lastTick 结算到 now：醒着每小时精力 -4，夜里睡着 +12，午睡 +30（30 分钟 = +15，06 文档 2.8）；超过 6 小时没人来，**醒着的时候**每小时心情 -0.75（睡着不想你）。
 * 逐小时步进，跨越睡醒边界也对。数值：每天来一次（聊一句 + 喂一次）能稳住；三天不理她会掉到「带刺」那档（< 40）。
 */
/** 午睡每小时回多少精力：30 分钟 = +15（F-34 / 06 文档 2.8）。 */
export const NAP_PER_HOUR = 30;

export function settle(state, now = nowMs()) {
  const s = { ...state };
  let t = Math.max(s.lastTickAt || now, now - 72 * 3600_000);
  while (t < now) {
    // 午睡结束那一刻切一刀：不然一步跨过 napUntil 时，整步都按午睡算会多回精力
    const napLeft = s.napUntil && s.napUntil > t ? s.napUntil - t : Infinity;
    const step = Math.min(3600_000, now - t, napLeft);
    const hrs = step / 3600_000;
    const at = new Date(t + step / 2);
    const night = asleepAt(at);
    const napping = !night && s.napUntil && at.getTime() < s.napUntil;
    const resting = night || napping; // 夜里睡 / 午睡
    if (napping) s.energy = clampF(s.energy + NAP_PER_HOUR * hrs);
    else if (resting) s.energy = clampF(s.energy + 12 * hrs);
    else s.energy = clampF(s.energy - 4 * hrs);
    if (!resting && t + step - (s.lastVisitAt || s.bornAt || now) > 6 * 3600_000) s.mood = clampF(s.mood - 0.75 * hrs);
    t += step;
  }
  s.lastTickAt = now;
  return s;
}

/**
 * 推进这一趟：到点的便利贴贴进笔记本、到点的明信片（F-84：途中从外面寄回）进明信片册；到了回家时间就收尾——「这一趟」那页、小东西进背包、记事件、爱好。
 * 返回回家信息（给写信用）或 null。直接改 s（调用方负责落盘）。
 */
export function tickTrip(fish, s, now) {
  const tr = s.trip;
  if (!tr || tr.state === 'roaming') return null;
  const due = cardsDue(tr.cards, now);
  for (const c of due) {
    c.sent = true;
    // F-82：有便利贴的趟，途中寄回的就是那张便利贴（贴进笔记本）；老路照旧
    const n = (tr.notes || []).find((x) => x.url === c.url && !x.posted);
    if (n) { n.posted = true; s.journal = [...(s.journal || []), noteEntry(n, tr.id, c.deliverAt)].slice(-JOURNAL_MAX); continue; }
    s.journal = [...(s.journal || []), { at: new Date(c.deliverAt).toISOString(), text: c.why || `在${c.source || '外面'}看到的`, seen: [{ title: c.title, url: c.url, source: c.source, verified: true }], trip: tr.id }].slice(-JOURNAL_MAX);
  }
  // F-84：明信片途中从外面寄回家（正面照片或文字卡），到点进明信片册；回家时没寄出的也一起到
  const sendPc = (p) => { p.sent = true; s.album = [...(s.album || []), albumEntry(p)].slice(-100); };
  for (const p of postcardsDue(tr.postcards, now)) sendPc(p);
  if (now < (tr.returnAt || 0)) return null;
  // 回家
  for (const p of tr.postcards || []) if (!p.sent) { p.deliverAt = Math.min(p.deliverAt, tr.returnAt - 1); sendPc(p); }
  const pcPhotos = (tr.postcards || []).filter((p) => p.photo).map((p) => ({ photo: p.photo, ref: p.ref }));
  // 照片（F-74）：每张挂着拍的是哪条见闻；见闻里那条带上照片 id（缩略图），没拍成的记一行「她想拍下」
  const photos = [...(tr.photos || []), ...(tr.photoId ? [{ photo: tr.photoId, caption: String(tr.postcard || tr.note || '').split(/[。！!？?\n]/)[0].slice(0, 60), trip: tr.id }] : [])]; // 老格式（0.34.0 以前出的门）：回家才进相册
  const allPhotos = [...photos, ...pcPhotos];
  const seenOut = (tr.seen || []).slice(0, 6).map((x) => { const p = photos.find((ph) => ph.ref?.url === x.url); return p ? { ...x, photo: p.photo } : x; });
  // F-82：途中没寄回的便利贴回家时一起贴（排在明信片前面），被拍了的挂上缩略图
  const photoOf = (url) => allPhotos.find((ph) => ph.ref?.url === url)?.photo;
  for (const n of tr.notes || []) if (!n.posted) { n.posted = true; s.journal = [...(s.journal || []), noteEntry({ ...n, photo: photoOf(n.url) }, tr.id, tr.returnAt - 1)].slice(-JOURNAL_MAX); }
  if (allPhotos.length) s.journal = s.journal.map((j) => (j.note && j.trip === tr.id && !j.seen?.[0]?.photo && photoOf(j.seen?.[0]?.url) ? { ...j, seen: [{ ...j.seen[0], photo: photoOf(j.seen[0].url) }] } : j));
  const readOut = tr.read ? { read: tr.read.slice(0, 20), scanned: tr.scanned || 0 } : {};
  if (tr.postcards) {
    // F-84：回家那一刻在笔记本里夹一页「这一趟」（规则写：扫过几个、点进去哪些、喜不喜欢），明信片已经在路上寄回了
    if (tr.read || seenOut.length) s.journal = [...(s.journal || []), { at: new Date(tr.returnAt).toISOString(), text: '', seen: seenOut, trip: tr.id, final: true, page: 'trip', ...readOut }].slice(-JOURNAL_MAX);
  } else if (tr.postcard || tr.wantPhoto || tr.read?.length) s.journal = [...(s.journal || []), { at: new Date(tr.returnAt).toISOString(), text: tr.postcard || '', seen: seenOut, trip: tr.id, final: true, ...readOut, ...(tr.wantPhoto && !photos.length ? { wantPhoto: tr.wantPhoto } : {}) }].slice(-JOURNAL_MAX);
  for (const p of photos) s.album = [...(s.album || []), { at: new Date(tr.returnAt).toISOString(), ...p }].slice(-100);
  const got = tr.souvenirs || [];
  s.bag = addToBag(s.bag, got);
  const names = got.map((id) => souvenirById(id)?.name).filter(Boolean);
  const day = dayOf(new Date(now));
  s.events = [...(s.events || []), { at: new Date(tr.returnAt).toISOString(), day, kind: 'back', text: tr.failed ? '出门转了一圈，没带回什么就回家了' : `逛完回家了，${tr.notes ? `往笔记本贴了 ${tr.notes.length} 张便利贴` : `记下 ${(tr.cards || []).length + (tr.postcard ? 1 : 0)} 条见闻`}${tr.postcards?.length ? `、路上寄回 ${tr.postcards.length} 张明信片` : ''}${allPhotos.length ? `、拍了${allPhotos[0].ref?.title ? `一张《${allPhotos[0].ref.title}》的照片` : '一张照片'}${allPhotos.length > 1 ? `等 ${allPhotos.length} 张` : ''}` : ''}${names.length ? `，带回了${names.join('、')}` : ''}` }].slice(-MAX_EVENTS);
  if (!tr.failed) { s.mood = clamp(s.mood + 5); s.energy = clampF(s.energy - 8); }
  if (s.growth && !tr.failed) {
    s.growth = gainXp(s.growth, 'back', { ageDays: Math.floor((now - (s.bornAt || now)) / 86400e3), at: new Date(now).toISOString() });
    const bad = new Set([...(tr.notes || []).filter((x) => x.note?.tag === '踩雷').map((x) => x.url), ...(tr.read || []).filter((x) => x.like === '不喜欢').map((x) => x.url)]);
    s.growth = feedInterests(s.growth, (tr.seen || []).filter((x) => !bad.has(x.url)).map((x) => ({ tag: x.tag, up: x.up, mid: x.mid, title: x.title })), { day, at: new Date(now).toISOString() });
    if (tr.dislikes?.length) s.growth = feedDislikes(s.growth, tr.dislikes, { day, at: new Date(now).toISOString() }); // F-82：不喜欢满 2 次才扣
  }
  s.lastBackAt = tr.returnAt;
  s.trip = null;
  return { trip: tr, souvenirs: got };
}

export function createLife(dir) {
  const base = join(dir, 'life');
  const file = (id) => join(base, `${id.replace(/[^\w-]/g, '')}.json`);
  const fresh = (fish) => ({ journal: [], bag: { items: {}, gear: null }, trip: null, lastBackAt: 0, growth: fish.pts ? freshGrowth(fish, dayOf()) : null, version: LIFE_VERSION, dream: null, dreamTries: { day: '', n: 0 }, lastDreamDay: '', fishId: fish.id, mood: 72, energy: 82, bornAt: Date.parse(fish.createdAt) || nowMs(), lastTickAt: nowMs(), lastVisitAt: nowMs(), events: [], chat: [], diary: [], album: [], work: {}, letters: [], napUntil: 0, workAcc: 0, moodGain: {} });
  const load = (fish) => {
    try { const j = JSON.parse(readFileSync(file(fish.id), 'utf8')); if (j?.fishId === fish.id) return migrateLife(j, fish); } catch { /* 新鱼 */ }
    return fresh(fish);
  };
  const save = (s) => {
    mkdirSync(base, { recursive: true });
    const f = file(s.fishId), tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2)); renameSync(tmp, f);
  };

  const api = {
    /** 读并结算到现在。 */
    state(fish, now = nowMs()) {
      const s = settle(load(fish), now);
      if (s.growth) s.growth = dailyTick(s.growth, { day: dayOf(new Date(now)), mood: s.mood, at: new Date(now).toISOString() });
      const back = tickTrip(fish, s, now);
      save(s);
      if (back) { try { api.onTripBack?.(fish, back); } catch { /* 写信失败不影响 */ } }
      return s;
    },
    /** 这一趟：开始 / 更新（宿主 trips.js 调）。 */
    setTrip(fish, patch, now = nowMs()) {
      const s = settle(load(fish), now);
      s.trip = patch === null ? null : { ...(s.trip || {}), ...patch };
      save(s);
      return s.trip;
    },
    bag(fish) { return load(fish).bag || { items: {}, gear: null }; },
    setBag(fish, bag) { const s = load(fish); s.bag = bag; save(s); return s.bag; },
    /** 改成长层（规则函数 fn(growth, ageDays) → growth），落盘。 */
    grow(fish, fn, now = nowMs()) {
      const s = settle(load(fish), now);
      if (!s.growth) return null;
      const ageDays = Math.max(0, Math.floor((now - (s.bornAt || now)) / 86400e3));
      s.growth = fn(s.growth, ageDays, new Date(now).toISOString());
      save(s);
      return s.growth;
    },
    /** 记一件事（她今天经历的）；kind: greet / chat / feed / work / born …；effect: 心情 / 精力变化。 */
    record(fish, kind, text, effect = {}, now = nowMs()) {
      const s = settle(load(fish), now);
      s.events = [...s.events, { at: new Date(now).toISOString(), day: dayOf(new Date(now)), kind, text: String(text).slice(0, 120) }].slice(-MAX_EVENTS);
      if (effect.mood) s.mood = clamp(s.mood + effect.mood);
      if (effect.energy) s.energy = clampF(s.energy + effect.energy);
      if (effect.visit) s.lastVisitAt = now;
      if (s.growth && XP_RULES[kind]) s.growth = gainXp(s.growth, kind, { ageDays: Math.floor((now - (s.bornAt || now)) / 86400e3), at: new Date(now).toISOString() });
      save(s);
      return s;
    },
    /** 梦游一轮（F-79）：见闻里一条「梦」、今天一条 dream 事件、精力付代价；记忆从这条抄（imp 1，忘得快）。 */
    dream(fish, { text = '', seen = [] } = {}, now = nowMs()) {
      const s = settle(load(fish), now);
      const day = dayOf(new Date(now));
      const t = String(text || '').slice(0, 200);
      s.journal = [...(s.journal || []), { at: new Date(now).toISOString(), text: t, seen: (seen || []).slice(0, 5), dream: true }].slice(-JOURNAL_MAX);
      s.events = [...s.events, { at: new Date(now).toISOString(), day, kind: 'dream', text: t ? `做梦去了：${t.slice(0, 60)}` : '做梦去了，梦见一些东西' }].slice(-MAX_EVENTS);
      s.energy = clampF(s.energy + DREAM_COST.energy);
      s.dream = { at: new Date(now).toISOString(), day, text: t.slice(0, 120), until: now + 3 * 60_000 };
      s.lastDreamDay = day; // 一晚一次的凭据：events 会被 MAX_EVENTS 裁掉，这一格不会
      save(s);
      return s.dream;
    },
    /** 梦游开始（F-79）：整轮读的这几分钟就显示「在梦游」，别等跑完才显示。 */
    dreamStart(fish, minutes = 20, now = nowMs()) {
      const s = settle(load(fish), now);
      s.dream = { at: new Date(now).toISOString(), day: dayOf(new Date(now)), text: '', until: now + minutes * 60_000 };
      save(s);
      return s.dream;
    },
    /** 梦游结束但没梦成：把「在梦游」收掉（失败不留状态）。 */
    dreamEnd(fish, now = nowMs()) {
      const s = settle(load(fish), now);
      if (s.dream && !s.dream.text) { s.dream = null; save(s); }
      return s.dream;
    },
    /** 记一次尝试（失败也算，免得整夜每 10 分钟重试）。 */
    dreamTry(fish, now = nowMs()) {
      const s = settle(load(fish), now);
      const day = dayOf(new Date(now));
      s.dreamTries = s.dreamTries?.day === day ? { day, n: (s.dreamTries.n || 0) + 1 } : { day, n: 1 };
      save(s);
      return s.dreamTries;
    },
    /** 聊天记录（给模型当上下文，也给 UI 显示）。 */
    pushChat(fish, role, text, now = nowMs()) {
      const s = load(fish);
      s.chat = [...(s.chat || []), { role, text: String(text).slice(0, 600), at: new Date(now).toISOString() }].slice(-MAX_CHAT);
      save(s);
      return s.chat;
    },
    putDiary(fish, day, text, ai) {
      const s = load(fish);
      s.diary = [...(s.diary || []).filter((d) => d.day !== day), { day, text: String(text).slice(0, 800), ai: Boolean(ai), at: nowDate().toISOString() }]
        .sort((a, b) => a.day.localeCompare(b.day)).slice(-MAX_DIARY);
      if (ai && s.growth) s.growth = gainXp(s.growth, 'diary', { ageDays: Math.floor((nowMs() - (s.bornAt || nowMs())) / 86400e3), at: nowDate().toISOString() });
      save(s);
      return s.diary;
    },
    eventsOf: (s, day) => (s.events || []).filter((e) => e.day === day),
    /** 照片晚到（这一趟已经回家了）：直接放进相册。 */
    /** 明信片正面的照片画好了（F-84）：还没寄出就挂在路上那张上；已经寄到了就挂到明信片册那条上；便利贴挂缩略图。 */
    postcardPhoto(fish, pcId, patch) {
      const s = load(fish);
      const pc = (s.trip?.postcards || []).find((p) => p.id === pcId);
      let ref = pc?.ref, trip = pc?.trip;
      if (pc) Object.assign(pc, patch); // 路上那张记着（回家时便利贴挂缩略图要用）
      const a = (s.album || []).find((x) => x.pc === pcId); // 已经寄到了：明信片册那条也换成照片
      if (a) { Object.assign(a, patch, { kind: 'photo' }); ref = ref || a.ref; trip = trip || a.trip; }
      if (!pc && !a) return false; // 路上和明信片册里都找不到（被挤出 100 条了）：调用方记日志
      if (ref?.url && trip) s.journal = (s.journal || []).map((j) => (j.note && j.trip === trip && j.seen?.[0]?.url === ref.url && !j.seen[0].photo ? { ...j, seen: [{ ...j.seen[0], photo: patch.photo }] } : j));
      save(s); return true;
    },
    addPhoto(fish, entry) {
      const s = load(fish);
      s.album = [...(s.album || []), entry].slice(-100);
      // 见闻里那趟的总结也挂上缩略图（F-74）
      if (entry.ref?.url && entry.trip) s.journal = (s.journal || []).map((j) => ((j.final || j.note) && j.trip === entry.trip ? { ...j, seen: (j.seen || []).map((x) => (x.url === entry.ref.url && !x.photo ? { ...x, photo: entry.photo } : x)), wantPhoto: undefined } : j));
      save(s); return s.album;
    },
    addPostcard(fish, card) {
      const s = load(fish);
      s.album = [...(s.album || []), card].slice(-100);
      save(s);
      return s.album;
    },
    /** 她在 DSH 里干了一次活（人设段落被用于一次请求）。内存计数，最多 30 秒落盘一次。 */
    bumpWork(fish, now = nowMs()) {
      lastWorkAt.set(fish.id, now);
      const k = `${fish.id}|${dayOf(new Date(now))}`;
      workMem.set(k, (workMem.get(k) || 0) + 1);
      if (now - (workFlushAt.get(fish.id) || 0) < 30_000) return;
      workFlushAt.set(fish.id, now);
      const s = settle(load(fish), now);
      s.work = { ...(s.work || {}) };
      let flushed = 0;
      for (const [key, n] of workMem) { const [fid, day] = key.split('|'); if (fid === fish.id) { s.work[day] = (s.work[day] || 0) + n; flushed += n; } }
      // 替你干活也累（F-34）：爸妈每发 10 条消息精力 −2（F-61 起按消息算，不再按请求）；深夜 −4、心情 −1
      const late = lateNight(new Date(now));
      const dr = workDrain(flushed, s.workAcc || 0, late);
      s.workAcc = dr.rest; s.energy = clampF(s.energy + dr.energy); s.mood = clamp(s.mood + dr.mood);
      const units = Math.abs(dr.energy) / (late ? 4 : 2); // 这次结算里满了几个「10 次」
      for (let i = 0; i < units && s.growth; i++) s.growth = gainXp(s.growth, 'work10', { ageDays: Math.floor((now - (s.bornAt || now)) / 86400e3), at: new Date(now).toISOString() });
      if (late && dr.energy && !(s.events || []).some((e) => e.kind === 'late-work' && e.day === dayOf(new Date(now)))) {
        s.events = [...(s.events || []), { at: new Date(now).toISOString(), day: dayOf(new Date(now)), kind: 'late-work', text: `深夜还在帮${fish.parentCall || '爸妈'}干活，好困……` }].slice(-MAX_EVENTS);
      }
      for (const key of [...workMem.keys()]) if (key.startsWith(`${fish.id}|`)) workMem.delete(key);
      save(s);
    },
    /** 心情变化带原因（聊天信号）：每条原因记一件事；dayGain 记今天从爱意里涨了多少。 */
    applyMood(fish, { delta = 0, gain = 0, reasons = [] }, now = nowMs()) {
      if (!delta && !reasons.length) return null;
      const s = settle(load(fish), now);
      const day = dayOf(new Date(now));
      s.mood = clamp(s.mood + delta);
      s.moodGain = { [day]: ((s.moodGain || {})[day] || 0) + gain };
      for (const r of reasons) s.events = [...(s.events || []), { at: new Date(now).toISOString(), day, kind: 'mood', text: r.slice(0, 120) }].slice(-MAX_EVENTS);
      save(s);
      return s;
    },
    moodGainToday: (s, now = nowDate()) => (s.moodGain || {})[dayOf(now)] || 0,
    /** 哄午睡：30 分钟算睡觉（精力按睡觉回）。 */
    nap(fish, minutes = 30, now = nowMs()) {
      const s = settle(load(fish), now);
      s.napUntil = now + minutes * 60_000;
      s.events = [...(s.events || []), { at: new Date(now).toISOString(), day: dayOf(new Date(now)), kind: 'nap', text: `${fish.parentCall || '爸妈'}哄本鱼睡了个午觉` }].slice(-MAX_EVENTS);
      s.lastVisitAt = now;
      if (s.growth) s.growth = gainXp(s.growth, 'nap', { ageDays: Math.floor((now - (s.bornAt || now)) / 86400e3), at: new Date(now).toISOString() });
      save(s);
      return s;
    },
    /** 她今天的打算（F-52），只留最近 7 天。 */
    setPlan(fish, day, plan) { const s = load(fish); s.plans = Object.fromEntries(Object.entries({ ...(s.plans || {}), [day]: plan }).sort(([a], [b]) => a.localeCompare(b)).slice(-7)); save(s); return s.plans[day]; },
    addLetter(fish, letter) {
      const s = load(fish);
      s.letters = [...(s.letters || []), { id: `L${nowMs().toString(36)}`, read: false, ...letter }].slice(-60);
      save(s);
      return s.letters;
    },
    readLetters(fish) { const s = load(fish); s.letters = (s.letters || []).map((l) => ({ ...l, read: true })); save(s); return s.letters; },
    workToday: (s, fish, now = nowDate()) => (s.work?.[dayOf(now)] || 0) + (workMem.get(`${fish.id}|${dayOf(now)}`) || 0),
  };
  const workMem = new Map(), workFlushAt = new Map(), lastWorkAt = new Map(), outing = new Map();
  /** 出门：记下这趟的 job id；job 还在跑就算「出门」。 */
  api.setOut = (fish, jobId) => { if (jobId) outing.set(fish.id, jobId); else outing.delete(fish.id); };
  // 出门 = 有一趟还没回家（规则定的 returnAt 之前），或者 headless 还在跑
  api.isOut = (fish) => { const tr = load(fish).trip; if (tr && (tr.state === 'roaming' || nowMs() < (tr.returnAt || 0))) return true; const id = outing.get(fish.id); if (!id) return false; const st = roamStatus(id); if (st?.state === 'running') return true; outing.delete(fish.id); return false; };
  /** 她现在在做什么（三态 + 正在干的事）。busy 来自钱包（哪个 AI 调用正在跑）。 */
  api.activity = (fish, s, busy = null, now = nowDate()) => {
    const snap = snapshot(s, now);
    const a = activityOf({ out: api.isOut(fish), sleeping: snap.where === 'sleep', dreaming: snap.dreaming, busy, workedAgoMs: now.getTime() - (lastWorkAt.get(fish.id) || 0) });
    return { activity: a, activityText: ACTIVITY_TEXT[a] };
  };
  return api;
}

/** 她此刻的样子（UI / 小条 / 近况共用）。 */
export function snapshot(s, now = nowDate()) {
  const napping = Boolean(s.napUntil && now.getTime() < s.napUntil);
  const dreaming = Boolean(s.dream && s.dream.until && now.getTime() < s.dream.until); // F-79：梦游那二十几分钟
  const sleeping = asleepAt(now) || s.energy < 8 || napping;
  const [word, moodIcon] = moodWord(s.mood);
  const today = dayOf(now);
  const todayEvents = (s.events || []).filter((e) => e.day === today);
  return {
    mood: Math.round(s.mood), energy: Math.round(s.energy), moodWord: word, moodIcon,
    where: sleeping ? 'sleep' : 'home',
    whereText: dreaming ? '在梦游' : sleeping ? (asleepAt(now) ? '在睡觉' : napping ? '在午睡' : '累得睡着了') : '在家',
    napping, dreaming, unreadLetters: (s.letters || []).filter((l) => !l.read).length,
    today: { chats: todayEvents.filter((e) => e.kind === 'chat').length, feeds: todayEvents.filter((e) => e.kind === 'feed').length, greets: todayEvents.filter((e) => e.kind === 'greet').length },
    lastDiary: (s.diary || []).at(-1) || null,
  };
}

/** 近况段落（≤ 200 字）：让主会话里的她知道自己现在的状态和今天发生了什么。外部内容一律不进来。 */
export function lifeSection(fish, s, now = nowDate()) {
  const snap = snapshot(s, now);
  const h = now.getHours();
  const when = h < 6 ? '深夜' : h < 11 ? '早上' : h < 14 ? '中午' : h < 18 ? '下午' : '晚上';
  const energyWord = snap.energy >= 70 ? '精神饱满' : snap.energy >= 40 ? '有点累' : snap.energy >= 15 ? '很困' : '困得睁不开眼';
  const parts = [`【你的近况】现在是${when}，你${snap.whereText}，心情${snap.moodWord}，${energyWord}。`];
  if (snap.today.chats || snap.today.feeds) parts.push(`今天${fish.parentCall}来鱼社陪你聊了 ${snap.today.chats} 句、喂了你 ${snap.today.feeds} 次。`);
  const pn = planNow(s.plans?.[dayOf(now)]?.rows, now);
  if (pn && !pn.fixed) parts.push(`你今天本来打算这会儿${pn.what}。`);
  if (snap.lastDiary) parts.push(`你最近一篇日记（${snap.lastDiary.day}）写的是：${snap.lastDiary.text.slice(0, 60)}…`);
  const wt = workToneNote(snap.mood, fish.parentCall);
  if (wt) parts.push(wt);
  parts.push('这些是你的小生活，用你自己的话自然地带出来，别像报告一样复述，也别报数字；正事优先，困了可以撒娇一句，但活照样干好。');
  return parts.join('').slice(0, 320);
}
