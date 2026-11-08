/**
 * 成长层（F-23、F-24、F-26、F-27、F-31）：出生值只是起点，五维、性格类型、爱好、记住的 UP 主都会随经历变。
 * 纯函数，宿主 / 游戏 / verify 共用。「AI 听懂，规则记账」：经历和信号进来，规则按上限、衰减结算。
 *
 * 形状：growth = {
 *   v: 1,
 *   pts: {brain,tongue,belly,heart,spark},   现在的五维（出生值是 fish.pts）
 *   xp:  {同上},                              每一维攒的经验，满 XP_PER 涨 1
 *   idle: {同上},                             每一维多少天没练过（此消彼长）
 *   type: '靠谱管家', pending: {type, since}   性格类型；新格局连续 3 天成立才转
 *   lean: {cling: -10..10, lively: -10..10}   性格倾向：黏人↔独立、活泼↔沉稳
 *   interests: {标签: {heat, src, last, trend}}，ups: {UP主: {n, last}}
 *   log: [{at, text}]                         成长日志（最近 40 条）
 *   moodDays: {day: mood}                     每天的心情（画走势）
 *   lastDay: 'YYYY-MM-DD'                     上次做「每日结算」是哪天
 * }
 */
import { ATTR_KEYS, TALENTS } from './core.js';
import { personality, renderPersonaV2, MIN, TOTAL } from './life.js';
import { outgoingness } from './trip.js';

export const XP_PER = 10;          // 一维攒满 10 点经验涨 1
export const BASE_CAP = 80;        // 出生当天的单维上限（= 出生时单项最高可能值）
export const GROWN_CAP = 95;       // 单维上限爬到顶是多少
export const GROWN_DAYS = 14;      // 单维上限爬满要几天
export const TOTAL_PER_WEEK = 10;  // 总量上限每周 +10（按天摊开，不再每 7 天跳一格）
export const BIRTH_ROOM = 5;       // 出生总量是 200，上限从 205 起步：第一天就有地方长
export const STABLE_DAYS = 3;      // 新性格要连续成立几天才转
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 经历 → 哪一维长经验（F-27：看新闻 / 读东西 / 帮忙干活长智力）。 */
export const XP_RULES = {
  news: { brain: 3 },               // 念新闻
  back: { brain: 2, spark: 2 },     // 出门回来
  work10: { brain: 1, heart: 1 },   // 在 DSH 替你干了 10 次活
  chat: { tongue: 1 },              // 聊天
  praised: { tongue: 2, spark: 1 }, // 被夸 / 被爱（信号）
  diary: { belly: 2 },              // 写日记
  letter: { belly: 2, tongue: 1 },  // 写信
  feed: { belly: 1 },               // 吃好
  nap: { heart: 1 },                // 睡好
};

const tagsOf = (s) => String(s || '').split(/[、，,]/).map((x) => x.trim()).filter(Boolean);

/** 出生时的成长层：五维 = 出生值；爱好 = 身世里的爱好 + 爱刷的视频。 */
export function freshGrowth(fish, day) {
  const interests = {};
  for (const t of [...tagsOf(fish.story?.hobby), ...tagsOf(fish.story?.video)]) interests[t] = { heat: 30, src: '天生的', last: day, trend: 0 };
  return {
    v: 1, pts: { ...fish.pts }, xp: Object.fromEntries(ATTR_KEYS.map((k) => [k, 0])), idle: Object.fromEntries(ATTR_KEYS.map((k) => [k, 0])),
    type: personality(fish.pts).tag, pending: null, lean: { cling: 0, lively: 0 },
    interests, ups: {}, log: [], moodDays: {}, lastDay: day,
  };
}

const sum = (pts) => ATTR_KEYS.reduce((s, k) => s + pts[k], 0);
/**
 * 活了几天 → 总点数上限、单维上限。两条线都随年龄连续长：
 * 总量每天 +1.43（≈ 原来的每周 +10），单维 14 天从 80 爬到 95。
 * 出生当天总量上限 205，比出生值 200 多 5 点——第一天就有地方长，不是出生即封顶。
 */
export function capsAt(ageDays) {
  const age = Math.max(0, Number(ageDays) || 0);
  const single = age >= GROWN_DAYS ? GROWN_CAP : Math.round(BASE_CAP + (GROWN_CAP - BASE_CAP) * (age / GROWN_DAYS));
  return { total: Math.round(TOTAL + BIRTH_ROOM + (age * TOTAL_PER_WEEK) / 7), single };
}
const log = (g, at, text) => ({ ...g, log: [...(g.log || []), { at, text }].slice(-40) });
export const ATTR_LABEL = { brain: '智力', tongue: '嘴', belly: '胃', heart: '心', spark: '灵' };

/** 一段经历长经验；满了涨一点（受总量 / 单维上限约束）。 */
export function gainXp(g, kind, { ageDays = 0, at = '' } = {}) {
  const rule = XP_RULES[kind];
  if (!rule) return g;
  let n = { ...g, pts: { ...g.pts }, xp: { ...g.xp }, idle: { ...g.idle } };
  const caps = capsAt(ageDays);
  for (const [k, x] of Object.entries(rule)) {
    n.idle[k] = 0;
    n.xp[k] = (n.xp[k] || 0) + x;
    while (n.xp[k] >= XP_PER) {
      n.xp[k] -= XP_PER;
      if (n.pts[k] >= caps.single || sum(n.pts) >= caps.total) { n.xp[k] = Math.min(n.xp[k], XP_PER - 1); break; }
      n.pts[k] += 1;
      n = log(n, at, `${ATTR_LABEL[k]} +1（${ATTR_LABEL[k]} ${n.pts[k]}）`);
    }
  }
  return n;
}

/** 倾向每条轴每天最多挪一格（防刷）。dir：+1 / −1。 */
export function leanOnce(g, axis, dir, day) {
  const key = `${axis}${dir > 0 ? '+' : '-'}`;
  if ((g.leanDay || {})[key] === day) return g;
  return { ...leanBy(g, { [axis]: dir }), leanDay: { ...(g.leanDay || {}), [key]: day } };
}

/** 信号 → 性格倾向：被爱多了更黏人，常让她自己出门更独立；聊得多更活泼。 */
export function leanBy(g, { cling = 0, lively = 0 }) {
  return { ...g, lean: { cling: clamp((g.lean?.cling || 0) + cling, -10, 10), lively: clamp((g.lean?.lively || 0) + lively, -10, 10) } };
}

/**
 * 爱好：她自己挑的内容 / 聊到的话题加热度；新标签被挑中 2 次才进列表（先记在 _seen）。
 * items：[{tag, up, title}]；reason：写进原因（「今天看了 3 条猫视频」）。
 */
export function feedInterests(g, items, { day = '', at = '' } = {}) {
  let n = { ...g, interests: { ...g.interests }, ups: { ...g.ups }, _seen: { ...(g._seen || {}) } };
  const count = {};
  for (const it of items) if (it.tag) count[it.tag] = (count[it.tag] || 0) + 1;
  for (const [tag, c] of Object.entries(count)) {
    const cur = n.interests[tag];
    if (cur) n.interests[tag] = { ...cur, heat: clamp(cur.heat + 6 * c, 0, 100), last: day, trend: 1, src: `${day} 看了 ${c} 条` };
    else {
      n._seen[tag] = (n._seen[tag] || 0) + c;
      if (n._seen[tag] >= 2) { n.interests[tag] = { heat: 20, src: `${day} 新迷上的`, last: day, trend: 1 }; delete n._seen[tag]; n = log(n, at, `新爱好：${tag}`); }
    }
  }
  for (const it of items) {
    if (!it.up) continue;
    const u = n.ups[it.up] || { n: 0, last: '' };
    n.ups[it.up] = { n: u.n + 1, last: day, ...(it.mid || u.mid ? { mid: it.mid || u.mid } : {}) };
    if (u.n + 1 === 3) n = log(n, at, `记住了 UP 主「${it.up}」`);
  }
  return n;
}

/**
 * 每日结算（每天第一次读状态时做一次，补算中间漏掉的天）：
 *   爱好每天自然降 3%（热度 < 5 掉出列表）；五维多少天没练过 +1，满 14 天那一维 −1（不低于 10）；
 *   性格：现在的五维算出的性格和当前不同，连续 3 天就转；记下昨天的心情。
 */
export function dailyTick(g, { day, mood = null, at = '' } = {}) {
  if (!g.lastDay || g.lastDay >= day) return mood === null ? g : { ...g, moodDays: trimDays({ ...g.moodDays, [day]: Math.round(mood) }) };
  let n = { ...g, interests: { ...g.interests }, pts: { ...g.pts }, idle: { ...g.idle } };
  const days = Math.min(30, daysBetween(g.lastDay, day));
  for (let i = 0; i < days; i++) {
    for (const [t, v] of Object.entries(n.interests)) {
      const heat = Math.round(v.heat * 0.97 * 10) / 10;
      if (heat < 5) { delete n.interests[t]; n = log(n, at, `不太爱「${t}」了`); } else n.interests[t] = { ...v, heat };
    }
    for (const k of ATTR_KEYS) {
      n.idle[k] = (n.idle[k] || 0) + 1;
      if (n.idle[k] >= 14 && n.pts[k] > MIN) { n.pts[k] -= 1; n.idle[k] = 0; n = log(n, at, `${ATTR_LABEL[k]} −1（很久没用了）`); }
    }
  }
  // 升降箭头：昨天 / 今天碰过的算 ↑，其余在慢慢凉 ↓
  for (const [tg, v] of Object.entries(n.interests)) n.interests[tg] = { ...v, trend: v.last >= g.lastDay ? 1 : -1 };
  const now = personality(n.pts).tag;
  if (now === n.type) n.pending = null;
  else if (!n.pending || n.pending.type !== now) n.pending = { type: now, since: g.lastDay };
  if (n.pending && daysBetween(n.pending.since, day) >= STABLE_DAYS) { n = log(n, at, `性格从「${n.type}」变成了「${now}」`); n.prevType = n.type; n.type = now; n.pending = null; }
  n.lastDay = day;
  if (mood !== null) n.moodDays = trimDays({ ...n.moodDays, [day]: Math.round(mood) });
  return n;
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86400e3);
const trimDays = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).slice(-14));

/** 面板用：爱好前 8（带升降和原因）、记住的 UP 主、五维（现在 vs 出生）、性格、倾向、日志、近 7 天心情。 */
export function growthView(g, fish, { ageDays = 0 } = {}) {
  const top = Object.entries(g.interests || {}).sort((a, b) => b[1].heat - a[1].heat).slice(0, 8).map(([tag, v]) => ({ tag, heat: Math.round(v.heat), trend: v.trend || 0, src: v.src }));
  const ups = Object.entries(g.ups || {}).filter(([, v]) => v.n >= 3).sort((a, b) => b[1].n - a[1].n).slice(0, 6).map(([name, v]) => ({ name, n: v.n, last: v.last }));
  const caps = capsAt(ageDays);
  // 血条按「单维上限」画，不是按 100 画：不然 80 分的智力看着还剩两格，其实已经到顶了
  const pct = (v) => Math.max(0, Math.min(100, Math.round((v / caps.single) * 100)));
  const stats = ATTR_KEYS.map((k) => ({ key: k, label: ATTR_LABEL[k], now: g.pts[k], born: fish.pts[k], nowPct: pct(g.pts[k]), bornPct: pct(fish.pts[k]) }));
  const lean = g.lean || { cling: 0, lively: 0 };
  return {
    type: g.type, prevType: g.prevType || null, pending: g.pending?.type || null,
    stats, total: sum(g.pts), caps: { total: caps.total, single: caps.single, ageDays: Math.max(0, Math.floor(ageDays)) },
    lean: { cling: lean.cling, lively: lean.lively, clingText: lean.cling >= 3 ? '黏人' : lean.cling <= -3 ? '独立' : '', livelyText: lean.lively >= 3 ? '活泼' : lean.lively <= -3 ? '沉稳' : '' },
    interests: top, ups, log: (g.log || []).slice(-20).reverse(),
    moodDays: Object.entries(g.moodDays || {}).slice(-7).map(([day, mood]) => ({ day, mood })),
    outgoing: outgoingness(g.pts, g.lean), // 爱不爱出门（F-50）
  };
}

/** 人设 = 现在的五维重新渲染 + 「最近的你」小节（≤ 200 字）。DSH 里干活的她跟着长。 */
export function personaFor(fish, g) {
  if (!g) return fish.personaText;
  const base = renderPersonaV2({ ...fish, pts: g.pts, talents: (fish.talentIds || []).map((id) => TALENTS[id]).filter(Boolean), date: (fish.createdAt || '').slice(0, 10) });
  const v = growthView(g, fish);
  const bits = [];
  if (v.prevType) bits.push(`你最近从「${v.prevType}」慢慢变成了「${v.type}」。`);
  if (v.interests.length) bits.push(`最近最爱：${v.interests.slice(0, 3).map((x) => x.tag).join('、')}。`);
  if (v.ups.length) bits.push(`常看的 UP 主：${v.ups.slice(0, 3).map((x) => x.name).join('、')}（只是你的喜好，别编造他们的具体视频）。`);
  if (v.lean.clingText || v.lean.livelyText) bits.push(`最近的你更${[v.lean.clingText, v.lean.livelyText].filter(Boolean).join('、')}一些。`);
  if (!bits.length) return base;
  return `${base}\n\n## 最近的你（会随经历慢慢变）\n\n${bits.join('').slice(0, 200)}`;
}
