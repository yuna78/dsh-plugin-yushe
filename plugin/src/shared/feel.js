/**
 * 有来由的情绪（F-88 心情一期-1，docs/设计/16-心情.md 第 3、4 节）。纯函数，宿主 / 游戏 / verify 共用。
 *
 * 三层：性情 temper（现算现用，不存）→ 心境 feel.valence（慢变，回到性情基线）→ 情绪 feel.emotions
 * （最多 3 个，每个带：what 是什么、强度多少、about 对谁、cause 因为什么、at 什么时候，按时间淡掉）。
 *
 * 规则管结果：事件 → 情绪的映射、边际递减、久别加成、衰减、想念、兼容的心情分都由这些纯函数决定；
 * AI 管表达：「此刻的你」那一小段话交给 prompts/feel-home.md / feel-work.md / feel-public.md，
 * 这里只准备变量再 fill（情绪名、程度词、表露习惯是短句数据表，同 letterPrompt 的由头表）。
 *
 * 数据形状（任务书）：feel = { v: 1, valence, emotions: [{kind, intensity, about, cause, at}],
 *   seen: { kind: { day, n, lastAt } }, lastAt }。
 * 不读时钟、不读文件、不用随机数：时间一律从参数传进来。
 */
import { fill } from './prompt.js';
import PROMPTS from '../prompts/_all.js';

const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
const round2 = (x) => Math.round(x * 100) / 100;
const clip = (s) => String(s || '').slice(0, 40);
const isoOf = (ts) => new Date(ts).toISOString();
/** 「哪一天」按本机时区算（不拿 ISO 字符串的前 10 位当日子）。 */
const dayOfTs = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 事件时间 → 毫秒（ISO 字符串 / 数字 / Date 都收）。 */
const tsOf = (at) => {
  if (at == null) return 0;
  if (at instanceof Date) return at.getTime();
  if (typeof at === 'number') return at;
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
};

/* ---------------- A. 情绪表 ---------------- */

/**
 * 一期 10 种。name：给模型看的说法；sign：正负；half：半衰期（小时，真实时间）。
 * miss 不按时间衰减（重逢把它换掉，settleFeel 里醒着才按小时涨）；负面的半衰期在 settleFeel 里再 × 0.7 × temper.recovery。
 */
export const EMOTIONS = {
  joy:        { name: '开心', sign: 1,  half: 6 },
  curious:    { name: '好奇', sign: 1,  half: 4 },
  proud:      { name: '得意', sign: 1,  half: 8 },
  loved:      { name: '被爱', sign: 1,  half: 10 },
  miss:       { name: '想念', sign: -1, half: null },
  hurt:       { name: '委屈', sign: -1, half: 10 },
  frustrated: { name: '受挫', sign: -1, half: 4 },
  down:       { name: '低落', sign: -1, half: 6 },
  worried:    { name: '担心', sign: -1, half: 12 },
  cranky:     { name: '烦躁', sign: -1, half: 3 },
};
export const MAX_EMOTIONS = 3;

/** 说法（relay 出给模型看的话；一个词，不出现数字）。 */
const FEEL_WORDS = {
  joy:        { strong: '很开心',     mild: '有点开心' },
  curious:    { strong: '好奇心冒泡', mild: '有点好奇' },
  proud:      { strong: '特别得意',   mild: '有点得意' },
  loved:      { strong: '心里暖暖的', mild: '有点被暖到' },
  miss:       { strong: '好想念',     mild: '有点想念' },
  hurt:       { strong: '很委屈',     mild: '有点委屈' },
  frustrated: { strong: '很受挫',     mild: '有点受挫' },
  down:       { strong: '很低落',     mild: '有点低落' },
  worried:    { strong: '很担心',     mild: '有点担心' },
  cranky:     { strong: '很烦躁',     mild: '有点烦躁' },
};
/** about 的说法（写名字的来历）。 */
const ABOUT_TEXT = { parent: '是家里的事', web: '是 B站上的事', world: '是外面看到的', self: '是你自己的处境' };
/** 表露习惯（temper.display → 一句话）。 */
const DISPLAY_NOTE = {
  嘴硬: '就算心里很在意，嘴上也得说「才没有」，不承认',
  直白: '心里怎么想，就直接怎么说',
  含蓄: '一般不明说，但话里听得出来',
};

/* ---------------- B. 性情 ---------------- */

const n01 = (v) => clampN((Number.isFinite(Number(v)) ? Number(v) : 40) - 10, 0, 85) / 85;
const side = (v) => n01(v) * 2 - 1; // −1..1

/**
 * 性情：从成长层算出来的底色，现算现用（不存档）。同一个输入永远同一个输出。
 *   baseline −20..20      心境的归宿：活泼（lean.lively 高）、灵（pts.spark）高就偏开心
 *   reactivity 0.7..1.4   情绪来得猛不猛：活泼的大，心（严谨）高的小
 *   recovery  0.7..1.4    负面情绪记多久：心高的大（记仇一点），活泼的小
 *   display '嘴硬'|'直白'|'含蓄'
 * 没有 growth（老鱼 / 测试）→ 默认值，不抛异常。
 */
export function temperOf(growth, fish) {
  const pts = (growth && growth.pts) || (fish && fish.pts) || null;
  if (!pts) return { baseline: 0, reactivity: 1, recovery: 1, display: '含蓄' };
  const lean = (growth && growth.lean) || {};
  const liv = clampN(Number(lean.lively) || 0, -10, 10) / 10;
  const cling = clampN(Number(lean.cling) || 0, -10, 10) / 10;
  const heart = side(pts.heart);
  const baseline = round2(10 * liv + 8 * side(pts.spark));
  const reactivity = round2(clampN(1 + 0.25 * liv - 0.06 * heart, 0.7, 1.4));
  const recovery = round2(clampN(1 + 0.12 * heart - 0.03 * liv, 0.7, 1.4));
  const display = cling <= -0.3 ? '嘴硬' : (Number(pts.tongue) >= 55 ? '直白' : '含蓄');
  return { baseline, reactivity, recovery, display };
}

/* ---------------- C. 事件 → 情绪 ---------------- */

const DAY_MS = 86400e3;
/** 同一类事件当天第 1/2/3/4/5+ 次的强度倍数（边际递减；跨天重新算）。 */
export const DAY_FACTORS = [1, 0.6, 0.35, 0.2, 0.1];
const ABSENT_BONUS = 1.3;   // 同一类事件距上次 ≥ 3 天 → 加成
const NEG_BIAS = 1.5;       // 负面偏差：坏事比好事分量重
const TIRED_NEG = 1.3;      // 累了更容易烦
const TIRED_POS = 0.8;
const VALENCE_K = 0.3;      // 情绪强度 → 心境的系数
const APOLOGY_RELIEF = 40;  // 道歉一次削掉的委屈（≥ 30）

/**
 * 事件种类表：n = 基础强度；sig = 按模型给的档（1–3）每档强度。
 * nap：睡觉本身不产生情绪。sig-apology 单独走「哄一个过程 / 和好」那条路（feelEvent 里）。
 */
export const EVENT_FEELS = {
  chat:            { up: 'loved', about: 'parent', n: 10 },
  pat:             { up: 'loved', about: 'parent', n: 14 },
  feed:            { up: 'loved', about: 'parent', n: 16 },
  greet:           { up: 'loved', about: 'parent', n: 10 },
  news:            { up: 'loved', about: 'parent', n: 8 },   // 念新闻 / 讲给她听：陪着
  home:            { up: 'loved', about: 'parent', n: 8 },   // 爸妈在家的动静
  'home-liked':    { up: 'joy', about: 'world', n: 3 },      // 在家刷到喜欢的（边际递减管住：一轮 +1，一天刷十几轮也在 +4 上下的量级，不会涨过头）
  told:            { up: 'loved', about: 'parent', n: 12 },  // 让她记住一件事：被信任
  'dm-parent':     { up: 'loved', about: 'parent', n: 12 },
  'dm-sent-parent':{ up: 'loved', about: 'parent', n: 10 },
  'sig-affection': { up: 'loved', about: 'parent', sig: 12 },
  'sig-hurt':      { up: 'hurt',  about: 'parent', sig: 12 },
  'sig-apology':   { up: 'loved', about: 'parent', n: 6 },
  posted:          { up: 'proud', about: 'web', n: 12 },
  'inbox-reply':   { up: 'proud', about: 'web', n: 12 },
  'inbox-like':    { up: 'proud', about: 'web', n: 8 },
  'dm-sent':       { up: 'proud', about: 'web', n: 6 },      // 说得出口回网友，也是一点得意
  'dm-in':         { up: 'curious', about: 'web', n: 10 },
  'inbox-follow':  { up: 'proud', about: 'web', n: 8 },
  'act-follow':    { up: 'curious', about: 'web', n: 8 },
  'follow-official': { up: 'curious', about: 'web', n: 8 },
  back:            { up: 'joy', about: 'world', n: 12 },
  'back-failed':   { up: 'frustrated', about: 'self', n: 14 },
  'draft-no':      { up: 'frustrated', about: 'self', n: 12 },
  'late-work':     { up: 'cranky', about: 'self', n: 10 },
  'money-low':     { up: 'worried', about: 'self', n: 10 },
  nap:             null,
};

/** 老存档 / 别处来的 feel 补全并深拷贝：不改传入的对象。 */
const normalizeFeel = (feel) => ({
  v: 1,
  valence: clampN(Number(feel && feel.valence) || 0, -100, 100),
  emotions: (feel && Array.isArray(feel.emotions) ? feel.emotions : []).map((e) => ({
    kind: e && EMOTIONS[e.kind] ? e.kind : null,
    intensity: clampN(Number(e && e.intensity) || 0, 0, 100),
    about: e && ABOUT_TEXT[e.about] ? e.about : 'self',
    cause: clip(e && e.cause),
    at: e && e.at != null ? String(e.at) : '',
  })).filter((e) => e.kind && e.intensity > 0),
  seen: Object.fromEntries(Object.entries((feel && feel.seen) || {}).map(([k, s]) => [k, {
    day: String((s && s.day) || ''),
    n: Math.max(0, Math.round(Number(s && s.n) || 0)),
    lastAt: Number(s && s.lastAt) || 0,
  }])),
  lastAt: Number(feel && feel.lastAt) || 0,
});

/**
 * 事件 → 情绪：feelEvent(feel, event, ctx) → { feel, changes, reconciled, reunion }。
 *   event = { kind, cause, at, visit?（爸妈来了）, intensity?（sig-* 的档 1–3） }
 *   ctx = { temper, energy, call }
 *   changes = [{ kind, about, delta, cause }]，给宿主记进「今天」用。
 *   reunion = 这次把「想念」换成了重逢的格外开心（宿主据此另记一条 mood 事件）。
 * 不认识的 kind 原样返回（changes: []）。不改传入的 feel。
 */
export function feelEvent(inputFeel, event, ctx = {}) {
  const spec = event && event.kind != null ? EVENT_FEELS[event.kind] : undefined;
  const f = normalizeFeel(inputFeel);
  if (!spec) return { feel: f, changes: [], reconciled: false, reunion: false };

  const atMs = tsOf(event.at) || f.lastAt;
  const temper = ctx.temper && typeof ctx.temper === 'object' ? ctx.temper : {};
  const call = ctx.call || '妈妈';
  const re = Number.isFinite(Number(temper.reactivity)) ? Number(temper.reactivity) : 1;
  const energy = Number(ctx.energy);
  const tired = Number.isFinite(energy) && energy < 30;   // 累了更容易烦
  const changes = [];
  let reconciled = false;
  let reunion = false;

  /** 计一次事件的剂量：当日第 n 次 × 久别加成 ×（负面偏重 / 累了）× 性情反应幅度。 */
  const dose = (sign, kind, base) => {
    const day = atMs ? dayOfTs(atMs) : '';
    const slot = f.seen[kind] || (f.seen[kind] = { day, n: 0, lastAt: 0 });
    let factor = 1;
    if (slot.day && slot.day === day && slot.n > 0) slot.n += 1;  // 同一天再来：边际递减
    else { slot.n = 1; slot.day = day; }
    if (slot.n > 1) factor = DAY_FACTORS[Math.min(slot.n, 5) - 1];
    if (slot.lastAt && atMs - slot.lastAt >= 3 * DAY_MS) factor *= ABSENT_BONUS;  // 久别加成
    if (sign < 0) factor *= NEG_BIAS;
    if (tired) factor *= sign < 0 ? TIRED_NEG : TIRED_POS;
    slot.lastAt = atMs || slot.lastAt;
    return round2(base * factor * re);
  };

  /** 把一个情绪记进 feel（同类同对象合并：强度相加封顶 100、cause 换成新的），返回实际加进去的量。 */
  const add = (kind, about, amount, cause) => {
    if (!EMOTIONS[kind] || about == null || amount <= 0) return 0;
    let e = f.emotions.find((x) => x.kind === kind && x.about === about);
    if (!e) { e = { kind, about, intensity: 0, cause: '', at: '' }; f.emotions.push(e); }
    const got = round2(Math.min(100 - e.intensity, amount));
    if (got <= 0) return 0;
    e.intensity = round2(e.intensity + got);
    e.cause = clip(cause || e.cause);
    if (atMs) e.at = isoOf(atMs);
    changes.push({ kind, about, delta: got, cause: clip(cause || e.cause) });
    f.valence = clampN(round2(f.valence + EMOTIONS[kind].sign * got * VALENCE_K), -100, 100);
    return got;
  };

  /** 想念变重逢：爸妈来了、而且正想念着 → 想念清掉，换成格外开心（强度不低于想念的一半）。 */
  let missEntry = f.emotions.find((e) => e.kind === 'miss' && e.about === 'parent');
  if (event.visit && missEntry && missEntry.intensity >= 20) {
    const joyAmount = Math.max(Math.round(missEntry.intensity / 2), 1);
    f.emotions = f.emotions.filter((e) => e !== missEntry);
    add('joy', 'parent', joyAmount, clip(`${call}来了，一下子就不想念了`));
    missEntry = null;
    reunion = true;
  }

  if (event.kind === 'sig-apology') {
    const hurt = f.emotions.find((e) => e.kind === 'hurt' && e.about === 'parent');
    if (hurt && hurt.intensity > 0) {
      const used = round2(Math.min(hurt.intensity, APOLOGY_RELIEF));  // 削掉一大截
      hurt.intensity = round2(hurt.intensity - used);
      if (hurt.intensity <= 0) { f.emotions = f.emotions.filter((e) => e !== hurt); reconciled = true; }
      else hurt.cause = clip(`${call}道歉了，消了一点气`);
      changes.push({ kind: 'hurt', about: 'parent', delta: round2(-used), cause: clip(`${call}真心道歉了`) });
      f.valence = clampN(round2(f.valence + used * VALENCE_K), -100, 100);
      if (reconciled) add('joy', 'parent', Math.round(20 * re), clip(`${call}真心道歉，和好了`));
    } else {
      const amt = Math.round(6 * re);  // 没委屈的道歉：一点点被爱
      add('loved', 'parent', amt, clip(event.cause || `${call}说了一声对不起`));
    }
  } else {
    const base = spec.sig ? Math.round(clampN(Math.round(Number(event.intensity) || 1), 1, 3) * spec.sig) : spec.n;
    const amt = dose(EMOTIONS[spec.up].sign, event.kind, base);
    if (EMOTIONS[spec.up].sign > 0 && spec.about === 'parent') {
      const hurt = f.emotions.find((e) => e.kind === 'hurt' && e.about === 'parent');
      if (hurt && hurt.intensity > 0) {
        // 哄一个过程：来自爸妈的正面情绪先抵委屈，抵完的剩余才变成正面情绪
        const used = round2(Math.min(hurt.intensity, amt));
        hurt.intensity = round2(hurt.intensity - used);
        if (hurt.intensity <= 0) f.emotions = f.emotions.filter((e) => e !== hurt);
        changes.push({ kind: 'hurt', about: 'parent', delta: round2(-used), cause: clip(`${call}这次是在意她的`) });
        f.valence = clampN(round2(f.valence + used * VALENCE_K), -100, 100);
        add(spec.up, spec.about, round2(amt - used), clip(event.cause || ''));
      } else {
        add(spec.up, spec.about, amt, clip(event.cause || ''));
      }
    } else {
      add(spec.up, spec.about, amt, clip(event.cause || ''));
    }
  }

  // 最多 3 个：按强度从高到低，丢最弱的
  f.emotions.sort((a, b) => b.intensity - a.intensity || (a.kind < b.kind ? -1 : 1));
  f.emotions = f.emotions.slice(0, MAX_EMOTIONS);
  if (atMs) f.lastAt = atMs;
  return { feel: f, changes, reconciled, reunion };
}

/* ---------------- D. 时间流逝 ---------------- */

const HOUR_MS = 3600e3;
const SETTLE_MAX_MS = 72 * HOUR_MS; // 最多补 72 小时（life-engine.settle 同款）
const VALENCE_HALF_H = 36;          // 心境半衰期
const NEG_HALF_K = 0.7;             // 负面情绪淡得更快
const MISS_PER_HOUR = 3;
const MISS_MAX = 60;
const MISS_AFTER_MS = 6 * HOUR_MS;  // 醒着而且超过 6 小时没见到人才开始想

/**
 * 时间流逝：settleFeel(feel, { from, to, temper, asleep, lastVisitAt }) → 新 feel。
 *   asleep(Date) → 本小时是不是在睡觉；睡着情绪衰减加倍（睡一觉坏情绪淡很多）、想念不涨。
 *   按小时步进，最多补 72 小时：从 max(from, to − 72h) 开始算。只是没人来，永远不会产生 hurt。
 */
export function settleFeel(inputFeel, opts = {}) {
  const f = normalizeFeel(inputFeel);
  const temper = opts.temper && typeof opts.temper === 'object' ? opts.temper : {};
  const rec = Number.isFinite(Number(temper.recovery)) ? Number(temper.recovery) : 1;
  const baseline = Number.isFinite(Number(temper.baseline)) ? Number(temper.baseline) : 0;
  const to = tsOf(opts.to) || 0;
  // 没传 lastVisitAt 就不涨想念（接线漏传时不能凭空想念）
  const lv = opts.lastVisitAt != null ? (tsOf(opts.lastVisitAt) || 0) : null;
  /** 结算起点的强度：「强度 <10 删除」只对这一窗里真的掉下去的删（刚到手的小情绪不许被下一次小步结算吃掉）。 */
  const wasIntensity = new Map(f.emotions.map((e) => [e, e.intensity]));
  let t = Math.max(tsOf(opts.from) || 0, to - SETTLE_MAX_MS);
  while (t > 0 && t < to) {
    const step = Math.min(HOUR_MS, to - t);
    const hrs = step / HOUR_MS;
    const mid = t + step / 2;
    const sleeping = opts.asleep ? Boolean(opts.asleep(new Date(mid))) : false;
    for (const e of f.emotions) {
      let half = EMOTIONS[e.kind].half;
      if (e.kind === 'miss' || !half) continue;  // 想念不按时间衰减（重逢换掉它）
      if (EMOTIONS[e.kind].sign < 0) half = half * NEG_HALF_K * rec;
      if (sleeping) half = half / 2;             // 睡着的时候衰减加倍
      e.intensity = round2(e.intensity * Math.pow(2, -hrs / half));
    }
    // 「强度 <10 删除」在收尾做一次，且只删这一窗里衰减掉了的：按小时在 while 里做会把刚刚涨出来的想念（3 < 10）和小剂量情绪当场清掉，想念就永远涨不起来（一期-2 接线时修的 bug，详见实现记录）
    if (!sleeping && lv !== null && mid - lv >= MISS_AFTER_MS) {
      let miss = f.emotions.find((e) => e.kind === 'miss' && e.about === 'parent');
      if (!miss) { miss = { kind: 'miss', about: 'parent', intensity: 0, cause: '好一阵子没见到你了', at: '' }; f.emotions.push(miss); }
      miss.intensity = Math.min(MISS_MAX, round2(miss.intensity + MISS_PER_HOUR * hrs));
      if (!miss.at) miss.at = isoOf(mid);
    }
    f.valence = round2(baseline + (f.valence - baseline) * Math.pow(2, -hrs / VALENCE_HALF_H));
    t += step;
  }
  // 衰小了的（本窗内低于起点、又跌破 10）淡出；想念慢慢涨的除外；排序、只留 3 个
  f.emotions = f.emotions.filter((e) => e.intensity >= 10 || e.kind === 'miss' || !(e.intensity < (wasIntensity.get(e) ?? Infinity)));
  f.emotions.sort((a, b) => b.intensity - a.intensity || (a.kind < b.kind ? -1 : 1));
  f.emotions = f.emotions.slice(0, MAX_EMOTIONS);
  if (to > 0) f.lastAt = to;
  return f;
}

/* ---------------- E. 兼容的分数 ---------------- */

/**
 * 兼容的心情分 0–100（老代码的面板心情条、姿势、出门概率、写信阈值都继续用）：
 * 建议式：55 + valence × 0.4 + Σ sign × intensity × 0.25，再夹到 0–100。
 * 三天没人来（想念封顶 60）算下来不会掉进「闹别扭」那档。
 */
export function moodOf(feel) {
  const f = feel || {};
  let raw = 55 + (Number(f.valence) || 0) * 0.4;
  for (const e of Array.isArray(f.emotions) ? f.emotions : []) {
    const conf = EMOTIONS[e.kind] || { sign: 0 };
    raw += conf.sign * (Number(e.intensity) || 0) * 0.25;
  }
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/* ---------------- F. 一个词 ---------------- */

/** moodOf 的五档词 + 图标（assets/icons/mood1–5.webp；导出给 life-engine 的 moodWord 转调，全仓就这一份词表）。 */
export const MOOD_WORD = (mood) => {
  if (mood >= 80) return ['超开心', 'mood5'];
  if (mood >= 60) return ['开心', 'mood4'];
  if (mood >= 40) return ['还行', 'mood3'];
  if (mood >= 20) return ['有点闷', 'mood2'];
  return ['想你了', 'mood1'];
};

/** 一个情绪的说法（给页面的小标签）：≥ 50 用强的（「心里暖暖的」「好想念」），其他用轻的（「有点被暖到」）；不带数字。 */
export function emotionWord(e) {
  const w = FEEL_WORDS[e && e.kind];
  if (!w) return (EMOTIONS[e && e.kind] || {}).name || '有点情绪';
  return Number(e.intensity) >= 50 ? w.strong : w.mild;
}

/** 一个词：feelWord(feel) → [word, icon]。主导情绪够强就用情绪的说法；不然退回五档词（icon 照旧按档位）。 */
export function feelWord(feel) {
  const top = ((feel && Array.isArray(feel.emotions) ? feel.emotions : []) || [])
    .slice().sort((a, b) => (Number(b.intensity) || 0) - (Number(a.intensity) || 0))[0];
  const mood = moodOf(feel);
  if (top && Number(top.intensity) >= 20) {
    const w = FEEL_WORDS[top.kind];
    if (w) return [Number(top.intensity) >= 50 ? w.strong : w.mild, MOOD_WORD(mood)[1]];
  }
  return MOOD_WORD(mood);
}

/* ---------------- G. 给模型的一段 ---------------- */

/** cause 是事件侧的自由文本：给模型前去掉数字和机制词（G6 对任何 cause 都成立，不只对测试样本）。 */
const safeCause = (c) => clip(c).replace(/[0-9０-９]+(\.[0-9]+)?/g, '几').replace(/强度|规则|心情值|分数/g, '').trim();

const HOMELINE = (e) => {
  const w = FEEL_WORDS[e.kind] || { strong: '有些情绪', mild: '有点情绪' };
  const cause = safeCause(e.cause);
  return `你${Number(e.intensity) >= 50 ? w.strong : w.mild}${cause ? `——${cause}` : ''}（${ABOUT_TEXT[e.about] || ''}）。`;
};

/**
 * 给模型的一小段（可以为空）：
 *   home（鱼社聊天）：「此刻的你」；work（DSH 主会话）：≤ 80 字的一句；public（对外发声）：只带 B站 / 外面的情绪。
 * 所有场景不出现数字和机制词。没有强度 ≥ 15 的情绪就空串（按性格正常说话）。
 */
export function feelSection(feel, { call = '妈妈', temper = {}, scene = 'home' } = {}) {
  const strong = ((feel && Array.isArray(feel.emotions) ? feel.emotions : []) || [])
    .filter((e) => e && Number(e.intensity) >= 15)
    .slice().sort((a, b) => Number(b.intensity) - Number(a.intensity));
  if (!strong.length) return '';
  const display = DISPLAY_NOTE[temper.display] || DISPLAY_NOTE['含蓄'];

  if (scene === 'home') {
    const w1 = strong[0], w2 = strong[1];
    const main = HOMELINE(w1);
    const secondary = w2 ? HOMELINE(w2) : '';
    // 有对爸妈的情绪时加一句分界：对 B站上的人和外面的人不要带过去
    const webNote = strong.some((e) => e.about === 'parent') ? `对 B站上的人，别把这种情绪带过去。` : '';
    return fill(PROMPTS['feel-home'], { main, secondary, display, webNote });
  }

  if (scene === 'work') {
    const [word, mild] = (() => { const w = FEEL_WORDS[strong[0].kind] || { strong: '有情绪', mild: '有点情绪' }; return [w.strong, w.mild]; })();
    const conf = EMOTIONS[strong[0].kind] || { sign: 0 };
    if (conf.sign < 0 && Number(strong[0].intensity) >= 30) {
      return fill(PROMPTS['feel-work'], { feelWord: word, play: '' });
    }
    if (conf.sign > 0 && Number(strong[0].intensity) >= 50) {
      return fill(PROMPTS['feel-work'], { feelWord: word, play: '今天有值得高兴的事，' });
    }
    return '';
  }

  if (scene === 'public') {
    const visible = strong.filter((e) => (e.about === 'web' || e.about === 'world') && !safeCause(e.cause).includes(String(call)));
    if (!visible.length) return '';
    return fill(PROMPTS['feel-public'], { main: HOMELINE(visible[0]) });
  }
  return '';
}

/* ---------------- H. 迁移 ---------------- */

/**
 * 老存档只有 mood 数：折回 valence，让 moodOf(migrateFeel(m)) 尽量等于 m（情绪为空）。
 * oldMood 不是数 → 按 72。m 在 20–90 之间时折出来都在 valence ±100 之内。
 */
export function migrateFeel(oldMood) {
  const m = typeof oldMood === 'number' && Number.isFinite(oldMood) ? clampN(oldMood, 0, 100) : 72;
  return { v: 1, valence: round2((m - 55) / 0.4), emotions: [], seen: {}, lastAt: 0 };
}
