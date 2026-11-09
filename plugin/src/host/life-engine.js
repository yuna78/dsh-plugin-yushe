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
import { workDrain, lateNight } from '../shared/mood.js';
import { emotionWord, EMOTIONS, EVENT_FEELS, MAX_EMOTIONS, temperOf, feelEvent, settleFeel, moodOf, feelWord, feelSection, migrateFeel, MOOD_WORD } from '../shared/feel.js';
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
export const LIFE_VERSION = 8;

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
  // v7 → v8（F-88 心情一期-2）：有来由的情绪三层。feel 从老 mood 折回去；两套每天 +5 的账（爱意每日上限、在家喜欢）退役、字段从档里去掉；其他字段不动（mood 留着给老调用方）
  if (m.version < 8) {
    m = { ...m, version: 8, feel: migrateFeel(m.mood) };
    delete m.moodGain; delete m.homeMood;
  }
  // 手改过 / 旧版降级过的存档：数组字段兜一下，别让一次迭代直接抛
  for (const k of ['events', 'journal', 'chat', 'diary', 'album', 'letters']) if (!Array.isArray(m[k])) m[k] = [];
  return m;
}
const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
const clampF = (v) => Math.max(0, Math.min(100, Math.round(v * 1e4) / 1e4)); // 心情 / 精力小步结算，不能每步取整（房间每 15 秒刷一次，每步的变化会被四舍五入吃掉，F-60）
export const dayOf = (d = nowDate()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hourOf = (d) => d.getHours() + d.getMinutes() / 60;

/** 睡觉窗口（F-90）：默认 00:00–07:30，可以按爸妈的设置改；跨午夜（比如 23:00–07:00）也认。 */
const SLEEP_WIN = { from: SLEEP_FROM, to: WAKE_AT };
function parseHHMM(v, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return fallback;
  const h = Number(m[1]), mm = Number(m[2]);
  if (!(h >= 0 && h < 24 && mm >= 0 && mm < 60)) return fallback;
  return h + mm / 60;
}
/** 宿主把设置里的睡觉时间接进来（启动时 + 每次改设置后各调一次）。 */
export function setSleepWindow({ from, to } = {}) {
  SLEEP_WIN.from = parseHHMM(from, SLEEP_FROM);
  SLEEP_WIN.to = parseHHMM(to, WAKE_AT);
  return { ...SLEEP_WIN };
}
export function sleepWindow() { return { ...SLEEP_WIN }; }

/** 这个时刻她是不是在睡觉（窗口可配，默认 00:00–07:30）。 */
export function asleepAt(d = nowDate()) {
  const h = hourOf(d);
  const { from, to } = SLEEP_WIN;
  return from <= to ? h >= from && h < to : h >= from || h < to; // 右边小于左边 = 跨午夜
}

/** 心情 → 一个词 + 图标名（assets/icons/mood1–5.webp，给 UI 用；界面里不放 emoji）。词表只有一份，转调 feel.js。 */
export function moodWord(mood) {
  return MOOD_WORD(mood);
}

/** 情绪变化 → 「今天」里的一句话（cause + 往哪边变，不写数字）。涨：「……，心里暖暖的」；消：「……，没那么委屈了」。 */
const MOOD_UP = { joy: '开心起来了', curious: '有点好奇', proud: '有点小得意', loved: '心里暖暖的', miss: '有点想你', hurt: '有点委屈', frustrated: '有点受挫', down: '有点低落', worried: '有点担心', cranky: '有点烦躁' };
const MOOD_DOWN = { joy: '没那么开心了', curious: '没那么好奇了', proud: '没那么得意了', loved: '没那么暖了', miss: '没那么想了', hurt: '没那么委屈了', frustrated: '缓过来一点了', down: '没那么低落了', worried: '没那么担心了', cranky: '没那么烦了' };
const moodEventText = (change) => {
  const say = ((change?.delta || 0) < 0 ? MOOD_DOWN : MOOD_UP)[change?.kind] || '心情变了一点';
  const cause = String(change?.cause || '').replace(/[0-9０-９]+(\.[0-9]+)?/g, '几').slice(0, 60);
  return cause ? `${cause}，${say}` : `本鱼${say}`;
};

/** 老调用方兜底（心情-一期-2 C）：kind 不在情绪表里但 effect.mood 有值 → 正数当 joy、负数当 down，about self，强度 |mood|×3。纯 PSA：拷贝着改，不动传入的 feel。 */
const injectFeelMood = (inputFeel, amount, cause, now) => {
  const f = feelEvent(inputFeel, { kind: 'nap' }).feel; // 拿一份补全过的拷贝（nap 不产生情绪、不改 lastAt）
  const kind = amount > 0 ? 'joy' : 'down';
  const got = Math.min(100 - (f.emotions.find((x) => x.kind === kind && x.about === 'self')?.intensity || 0), Math.abs(amount));
  if (got > 0) {
    let e = f.emotions.find((x) => x.kind === kind && x.about === 'self');
    if (!e) { e = { kind, about: 'self', intensity: 0, cause: '', at: '' }; f.emotions.push(e); }
    e.intensity = Math.round((e.intensity + got) * 100) / 100;
    e.cause = String(cause || e.cause || '').slice(0, 40);
    e.at = now ? new Date(now).toISOString() : e.at;
    f.valence = Math.max(-100, Math.min(100, Math.round((f.valence + (amount > 0 ? 1 : -1) * got * 0.3) * 100) / 100));
    f.emotions.sort((a, b) => b.intensity - a.intensity || (a.kind < b.kind ? -1 : 1));
    f.emotions = f.emotions.slice(0, MAX_EMOTIONS);
  }
  return f;
};

/**
 * 从 lastTick 结算到 now：醒着每小时精力 -4，夜里睡着 +12，午睡 +30（30 分钟 = +15，06 文档 2.8）。
 * 逐小时步进，跨越睡醒边界也对。数值：每天来一次（聊一句 + 喂一次）能稳住。
 * 心情（心情-一期-2）：时间流逝走 settleFeel（想念慢慢涨、情绪按半衰期淡），不再是「没人来每小时 -0.75」；
 * 结算完 s.mood = moodOf(s.feel)，老调用方照旧读这个数。
 */
/** 午睡每小时回多少精力：30 分钟 = +15（F-34 / 06 文档 2.8）。 */
export const NAP_PER_HOUR = 30;
/** 累倒（F-82）：精力 < 15 撑不住、就地睡着；睡到 40 才起（passedOut 做迟滞，免得 15 上下反复睡醒）。 */
export const EXHAUST_FROM = 15, EXHAUST_UNTIL = 40, EXHAUST_PER_HOUR = 10;
/** 出门 / 回家各扣多少精力（原来 −15 / −8，一天两趟 −46，占掉半管血）。 */
export const TRIP_OUT_ENERGY = -10, TRIP_BACK_ENERGY = -5;

export function settle(state, now = nowMs()) {
  const s = { ...state };
  if (!s.feel) s.feel = migrateFeel(s.mood); // 老测试 / 手改存档没有 feel：先补上
  let t = Math.max(s.lastTickAt || now, now - 72 * 3600_000);
  const outSpans = []; // 累倒的那几段：情绪结算也当睡着（衰减加倍、不想你）
  while (t < now) {
    // 午睡结束那一刻切一刀：不然一步跨过 napUntil 时，整步都按午睡算会多回精力
    const napLeft = s.napUntil && s.napUntil > t ? s.napUntil - t : Infinity;
    const step = Math.min(3600_000, now - t, napLeft);
    const hrs = step / 3600_000;
    const at = new Date(t + step / 2);
    const night = asleepAt(at);
    const napping = !night && s.napUntil && at.getTime() < s.napUntil;
    // 累倒（F-82）：< 15 撑不住就地睡着，睡到 40 才起；迟滞避免在 15 上下反复睡醒
    if (!night && !napping) {
      if (s.passedOut) { if (s.energy >= EXHAUST_UNTIL) s.passedOut = false; }
      else if (s.energy < EXHAUST_FROM) s.passedOut = true;
    }
    const exhausted = !night && !napping && Boolean(s.passedOut);
    const resting = night || napping || exhausted; // 夜里睡 / 午睡 / 累倒
    if (napping) s.energy = clampF(s.energy + NAP_PER_HOUR * hrs);
    else if (night) s.energy = clampF(s.energy + 12 * hrs);
    else if (exhausted) s.energy = clampF(s.energy + EXHAUST_PER_HOUR * hrs);
    else s.energy = clampF(s.energy - 4 * hrs);
    if (exhausted) outSpans.push([t, t + step]);
    t += step;
  }
  // 情绪 / 想念按小时步进（最多补 72 小时）；睡着（夜里睡 / 午睡 / 累倒）衰减加倍、不想你
  s.feel = settleFeel(s.feel, {
    from: s.lastTickAt || now,
    to: now,
    temper: temperOf(s.growth),
    asleep: (d) => { const x = d.getTime(); return asleepAt(d) || Boolean(s.napUntil && s.napUntil > x) || outSpans.some(([a, b]) => x >= a && x < b); },
    lastVisitAt: s.lastVisitAt || s.bornAt,
  });
  s.mood = moodOf(s.feel);
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
  // 回家的心情改走情绪（心情-一期-2 D）：逛完 = joy，空手而归 = frustrated；精力照旧
  if (!tr.failed) s.energy = clampF(s.energy + TRIP_BACK_ENERGY);
  s.feel = feelEvent(s.feel, { kind: tr.failed ? 'back-failed' : 'back', cause: tr.failed ? '出门转了一圈，没带回什么就回家了' : '出门转了一圈，逛完回家了', at: tr.returnAt || now }, { temper: temperOf(s.growth), energy: s.energy, call: fish.parentCall }).feel;
  s.mood = moodOf(s.feel);
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
  const fresh = (fish) => ({ journal: [], bag: { items: {}, gear: null }, trip: null, lastBackAt: 0, growth: fish.pts ? freshGrowth(fish, dayOf()) : null, version: LIFE_VERSION, dream: null, dreamTries: { day: '', n: 0 }, lastDreamDay: '', fishId: fish.id, mood: 72, feel: migrateFeel(72), energy: 82, bornAt: Date.parse(fish.createdAt) || nowMs(), lastTickAt: nowMs(), lastVisitAt: nowMs(), events: [], chat: [], diary: [], album: [], work: {}, letters: [], napUntil: 0, workAcc: 0 });
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
    /** 记一件事（她今天经历的）；effect: 心情 / 精力变化（心情改走情绪事件，心情-一期-2 C）。 */
    record(fish, kind, text, effect = {}, now = nowMs()) {
      const s = settle(load(fish), now);
      s.events = [...s.events, { at: new Date(now).toISOString(), day: dayOf(new Date(now)), kind, text: String(text).slice(0, 120) }].slice(-MAX_EVENTS);
      // mood 事件只在和好 / 重逢时另记一条（事件本身已在「今天」里；再记普通情绪事件会刷屏、还会灌进记忆）
      const noteMood = (ch) => { s.events = [...s.events, { at: new Date(now).toISOString(), day: dayOf(new Date(now)), kind: 'mood', text: String(moodEventText(ch)).slice(0, 120) }].slice(-MAX_EVENTS); };
      if (EVENT_FEELS[kind]) {
        const r = feelEvent(s.feel, { kind, cause: text, at: now, visit: effect.visit }, { temper: temperOf(s.growth), energy: s.energy, call: fish.parentCall });
        s.feel = r.feel;
        // 重逢（心情-一期-2 F）：想念变重逢了，另记一条 mood 事件，文字用 feel 给的 cause（「来了」），不写数字
        if (r.reunion) noteMood(r.changes.find((ch) => ch.kind === 'joy' && ch.about === 'parent') || { kind: 'joy', about: 'parent', cause: `${fish.parentCall || '妈妈'}来了` });
      } else if (effect.mood) {
        s.feel = injectFeelMood(s.feel, effect.mood, text, now);
      }
      s.mood = moodOf(s.feel);
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
    /** 在家刷一轮（F-87，docs/设计/15-在家上网.md §3.4）：清单卡一张、0–1 张便利贴、今天一条事件、精力 −2；不涨五维。 */
    homeRound(fish, { read = [], scanned = 0, note = null, cap = 100 } = {}, now = nowMs()) {
      const s = settle(load(fish), now);
      const day = dayOf(new Date(now));
      const at = new Date(now).toISOString();
      const card = { at, read: (read || []).slice(0, 30), scanned: Number(scanned) || 0 };
      // 最多留 cap 张，多了丢最早的；单独存 homeCards，不挤占 journal
      s.homeCards = [...(s.homeCards || []), card].slice(-Math.max(1, Number(cap) || 100));
      if (note) s.journal = [...(s.journal || []), { ...noteEntry(note, null, now), home: true }].slice(-JOURNAL_MAX);
      // 刷到喜欢的东西会开心（home-liked 过情绪表，边际递减自己管住，一轮只涨一点，一天刷十几轮也涨不对头）；不再有每天 +5 的在场记账
      const liked = (card.read || []).some((x) => x.like === '喜欢');
      if (liked) {
        s.feel = feelEvent(s.feel, { kind: 'home-liked', cause: '刷到了喜欢的东西', at: now }, { temper: temperOf(s.growth), energy: s.energy, call: fish.parentCall }).feel;
      }
      s.mood = moodOf(s.feel);
      s.energy = clampF(s.energy - 2);
      s.events = [...(s.events || []), { at, day, kind: 'home', text: `刷了一会儿 B站，点开 ${card.read.length} 条${note ? `，记了一张《${String(note.title || '').slice(0, 30)}》` : ''}` }].slice(-MAX_EVENTS);
      s.lastHomeAt = Number(now);
      save(s);
      return card;
    },
    /** 记一次在家刷的尝试（一轮没成也算试过，免得每 10 分钟重试）。 */
    homeTry(fish, now = nowMs()) {
      const s = settle(load(fish), now);
      s.lastHomeAt = Number(now);
      save(s);
      return s.lastHomeAt;
    },
    /** 在家刷开始（F-87）：这几分钟就显示「在刷 B站」，别等跑完才显示。 */
    homeStart(fish, minutes = 5, now = nowMs()) {
      const s = settle(load(fish), now);
      s.browse = { at: new Date(now).toISOString(), until: now + minutes * 60_000 };
      save(s);
      return s.browse;
    },
    /** 在家刷结束：把「在刷 B站」收掉。 */
    homeEnd(fish, now = nowMs()) {
      const s = settle(load(fish), now);
      if (s.browse) { s.browse = null; save(s); }
      return s.browse;
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
      // 替你干活也累（F-34）：爸妈每发 10 条消息精力 −2（F-61 起按消息算，不再按请求）；深夜 −4（dr.mood 那点直接扣的心情退役，改走 late-work 情绪事件）
      const late = lateNight(new Date(now));
      const dr = workDrain(flushed, s.workAcc || 0, late);
      s.workAcc = dr.rest; s.energy = clampF(s.energy + dr.energy);
      const units = Math.abs(dr.energy) / (late ? 4 : 2); // 这次结算里满了几个「10 次」
      for (let i = 0; i < units && s.growth; i++) s.growth = gainXp(s.growth, 'work10', { ageDays: Math.floor((now - (s.bornAt || now)) / 86400e3), at: new Date(now).toISOString() });
      const day = dayOf(new Date(now));
      if (late && dr.energy && !(s.events || []).some((e) => e.kind === 'late-work' && e.day === day)) {
        s.events = [...(s.events || []), { at: new Date(now).toISOString(), day, kind: 'late-work', text: `深夜还在帮${fish.parentCall || '爸妈'}干活，好困……` }].slice(-MAX_EVENTS);
        // 当天第一次记这条事件时，同时过一次 late-work 情绪（烦躁对自己）；一天一次
        s.feel = feelEvent(s.feel, { kind: 'late-work', cause: `深夜还在帮${fish.parentCall || '爸妈'}干活，好困……`, at: now }, { temper: temperOf(s.growth), energy: s.energy, call: fish.parentCall }).feel;
      }
      s.mood = moodOf(s.feel);
      for (const key of [...workMem.keys()]) if (key.startsWith(`${fish.id}|`)) workMem.delete(key);
      save(s);
    },
    /** 聊天信号 → 情绪（心情-一期-2 E）：信号事件没有 cause，按种类补上；每条 change 记一条 kind:'mood' 事件（聊天的原因照旧进「今天」，不写数字）。返回 { state, reconciled }。 */
    applyFeel(fish, events, now = nowMs()) {
      const s = settle(load(fish), now);
      const call = fish.parentCall || '妈妈';
      const causes = { 'sig-affection': `${call}说了暖心的话`, 'sig-hurt': `${call}的话让本鱼难过了`, 'sig-apology': `${call}道歉了` };
      let reconciled = false;
      const changes = [];
      for (const ev of events || []) {
        if (!ev || !EVENT_FEELS[ev.kind]) continue;
        const r = feelEvent(s.feel, { ...ev, cause: causes[ev.kind] || ev.cause, at: now }, { temper: temperOf(s.growth), energy: s.energy, call });
        s.feel = r.feel;
        reconciled = reconciled || Boolean(r.reconciled);
        changes.push(...r.changes);
      }
      s.mood = moodOf(s.feel);
      for (const ch of changes) s.events = [...s.events, { at: new Date(now).toISOString(), day: dayOf(new Date(now)), kind: 'mood', text: String(moodEventText(ch)).slice(0, 120) }].slice(-MAX_EVENTS);
      save(s);
      return { state: s, reconciled };
    },
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
  /** 在家正刷着 B站（F-87）：这一轮里不出门（trips.autoTick 用）。 */
  api.isBrowsing = (fish) => { const s = load(fish); return Boolean(s.browse && s.browse.until > nowMs()); };
  /** 她现在在做什么（三态 + 正在干的事）。busy 来自钱包（哪个 AI 调用正在跑）。 */
  api.activity = (fish, s, busy = null, now = nowDate()) => {
    const snap = snapshot(s, now);
    const a = activityOf({ out: api.isOut(fish), sleeping: snap.where === 'sleep', dreaming: snap.dreaming, busy, workedAgoMs: now.getTime() - (lastWorkAt.get(fish.id) || 0) });
    return { activity: a, activityText: ACTIVITY_TEXT[a] };
  };
  return api;
}

/** 她此刻的样子（UI / 小条 / 近况共用）。feel：情绪清单只给一个（名字 / 种类 / 对谁 / 原因 / 程度词），不给数字强度。 */
export function snapshot(s, now = nowDate()) {
  const napping = Boolean(s.napUntil && now.getTime() < s.napUntil);
  const dreaming = Boolean(s.dream && s.dream.until && now.getTime() < s.dream.until); // F-79：梦游那二十几分钟
  const browsing = Boolean(s.browse && s.browse.until > now.getTime()); // F-87：在家正刷着 B站的这几分钟
  const sleeping = asleepAt(now) || s.energy < 8 || napping || Boolean(s.passedOut); // 累倒也算睡着（F-82）
  const feel = s.feel || migrateFeel(s.mood); // 老存档没有 feel：先从 mood 折回去
  const [word, moodIcon] = feelWord(feel);
  const today = dayOf(now);
  const todayEvents = (s.events || []).filter((e) => e.day === today);
  return {
    mood: Math.round(s.mood), energy: Math.round(s.energy), moodWord: word, moodIcon,
    feel: { emotions: (feel.emotions || []).map((e) => ({ name: EMOTIONS[e.kind]?.name || '情绪', word: emotionWord(e), kind: e.kind, about: e.about, cause: e.cause || '', level: (Number(e.intensity) || 0) >= 50 ? '很' : (Number(e.intensity) || 0) >= 20 ? '' : '有点' })) },
    where: sleeping ? 'sleep' : 'home',
    whereText: dreaming ? '在梦游' : sleeping ? (asleepAt(now) ? '在睡觉' : napping ? '在午睡' : '累得睡着了') : browsing ? '在刷 B站' : '在家', // 梦游 / 睡着优先，醒着正刷着才说在刷
    exhausted: Boolean(s.passedOut),
    napping, dreaming, browsing, unreadLetters: (s.letters || []).filter((l) => !l.read).length,
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
  const fs = feelSection(s.feel || migrateFeel(s.mood), { call: fish.parentCall, temper: temperOf(s.growth), scene: 'work' }); // 心情-一期-2 G：工作时的状态提醒换成「此刻的你」（feelSection），正事不打折那句在 prompts/feel-work.md 里
  if (fs) parts.push(fs);
  parts.push('这些是你的小生活，用你自己的话自然地带出来，别像报告一样复述，也别报数字；正事优先，困了可以撒娇一句，但活照样干好。');
  return parts.join('').slice(0, 320);
}
