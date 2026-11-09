/**
 * 记忆（F-76，docs/设计/09-记忆.md）。纯函数，规则算：记得什么、忘到哪一步、召回哪几条；模型只管说。
 *
 *   经历 episode：从档案抄来，按重要性 × 记性档位定半衰期，清晰 → 模糊 → 印象 → 忘了；擦细节是一次性的（floor）。
 *   认人 person：B站上打过交道的人，越熟忘得越慢；爸妈不忘。
 *   召回 recall：本地切词打分，按范围（家里 / B站）过滤，条数和字数预算。
 */
// 提示词本体在 src/prompts/reflect.md（F-80 搬家-2a）；空行小工具在 shared/prompt.js（搬家-2b 收拢）
import { fill, DROP, dropLines } from './prompt.js';
import PROMPTS from '../prompts/_all.js';

const DAY = 86400e3;
export const STAGES = ['clear', 'fuzzy', 'trace', 'forgotten'];
export const STAGE_TEXT = { clear: '清晰', fuzzy: '模糊', trace: '印象', forgotten: '忘了' };
export const MAX_EPISODES = 1000;
export const MAX_PEOPLE = 120;
const IMP_MULT = [0.15, 0.3, 0.6, 1, 1.8, 4];
const REINFORCE_MAX = 5;

/* 四期-2 E：最多同时钉住多少条（妈妈 11-09 拍板 20 条）；宿主端 mf 按它拦，这里只是这一个数。 */
export const MAX_PINNED = 20;

/** 种类 → 重要性 + 范围（规则定，不让模型打分）。 */
export const KINDS = {
  born: { imp: 5, scope: 'home' },
  'dm-parent': { imp: 4, scope: 'home' },
  'got-reply': { imp: 4, scope: 'public' },
  mood: { imp: 3, scope: 'home' },
  diary: { imp: 3, scope: 'home' },
  postcard: { imp: 3, scope: 'public' },
  photo: { imp: 3, scope: 'public' }, // F-74：被打动到拍下来的那一刻，记得比看过的视频久
  comment: { imp: 3, scope: 'public' },
  reply: { imp: 3, scope: 'public' },
  post: { imp: 3, scope: 'public' },
  dyncomment: { imp: 3, scope: 'public' },
  dm: { imp: 3, scope: 'public' },
  follow: { imp: 3, scope: 'public' },
  'got-follow': { imp: 3, scope: 'public' },
  'dm-in': { imp: 3, scope: 'public' },
  seen: { imp: 2, scope: 'public' },
  glance: { imp: 1, scope: 'public' }, // F-87 在家：点开看了，没读多深（记得最浅）
  'seen-deep': { imp: 3, scope: 'public' }, // F-87 在家：读了字幕 / 楼中楼，记得最牢
  note: { imp: 3, scope: 'public' }, // F-82：笔记本里「学到的」「好点子」
  'got-like': { imp: 2, scope: 'public' },
  nap: { imp: 2, scope: 'home' },
  'late-work': { imp: 2, scope: 'home' },
  chat: { imp: 1, scope: 'home' },
  feed: { imp: 1, scope: 'home' },
  dream: { imp: 1, scope: 'home' }, // F-79：梦游看到的，记得最浅、忘得最快
  news: { imp: 1, scope: 'home' },
  like: { imp: 1, scope: 'public' },
  comment_like: { imp: 1, scope: 'public' },
  collect: { imp: 1, scope: 'public' },
  unfollow: { imp: 1, scope: 'public' },
};

export const TIERS = [
  { min: 10, name: '老朋友', days: 60 },
  { min: 4, name: '熟人', days: 20 },
  { min: 2, name: '见过几次', days: 6 },
  { min: 1, name: '新认识', days: 1.5 },
];

export const MEMORY_VERSION = 4;
export const emptyMemory = () => ({ version: MEMORY_VERSION, episodes: [], people: {}, beliefs: [], told: [], cursors: {}, log: [], seq: 0, changes: [], weeklies: [], chapters: [] });

/** v1 → v2：补齐缺的字段、算出 cursors.lastAt（经历的最新一条；游标已经挡住比它老的老档案）、
 *  旧的 keys 数组转成新形状 { key: lastAt }——旧 key 没有时间，就记成迁移算出的 lastAt（lastAt 之外的过 3 天自然清掉）。 */
const migrateTo2 = (raw) => {
  const episodes = Array.isArray(raw.episodes) ? raw.episodes : [];
  let lastAt = '';
  for (const e of episodes) { const at = e?.at; if (at && (!lastAt || ms(at) > ms(lastAt))) lastAt = at; } // 已经抄过的最晚一条
  const oldCursors = raw.cursors && typeof raw.cursors === 'object' && !Array.isArray(raw.cursors) ? raw.cursors : {};
  const oldKeys = Array.isArray(oldCursors.keys) ? oldCursors.keys : [];
  const keys = oldKeys.length
    ? Object.fromEntries(oldKeys.map((k) => [String(k), lastAt || ''])) // 算不出 lastAt（经历全忘光了）也不丢：记成空时间，ingest 永久拿它们去重，挡住老档案复活
    : undefined;
  const cursors = { ...oldCursors, ...(lastAt ? { lastAt } : {}), ...(keys ? { keys } : {}) };
  return {
    version: 2,
    episodes,
    people: raw.people && typeof raw.people === 'object' && !Array.isArray(raw.people) ? raw.people : {},
    beliefs: Array.isArray(raw.beliefs) ? raw.beliefs : [],
    told: Array.isArray(raw.told) ? raw.told : [],
    cursors,
    log: Array.isArray(raw.log) ? raw.log : [],
    seq: Number(raw.seq) || 0,
  };
};

/**
 * 存档迁移（二期升 v3）：读出来的一律过这里，只认已知的形状；链式走，可重复跑。
 *   不是对象 → 新的空存档；version 比 MEMORY_VERSION 新 → 原样不动（不认识的新版本不改它）；
 *   v1 先走 v2 迁移，再走 v3；
 *   v2 → v3：认识补上 status（生效）、why（''）、effect（''）、source（reflect），其余不动，changes 补空数组。
 */
export function migrateMemory(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyMemory();
  const v = Number(raw.version) || 1;
  if (v > MEMORY_VERSION) return raw;
  let m = raw;
  if (v < 2) m = migrateTo2(m);
  if (v < 3) {
    m = {
      ...m,
      version: MEMORY_VERSION,
      beliefs: (Array.isArray(m.beliefs) ? m.beliefs : []).map((b) => (b && typeof b === 'object' && !Array.isArray(b) ? { ...b, status: b.status || '生效', why: b.why !== undefined ? b.why : '', effect: b.effect !== undefined ? b.effect : '', source: b.source || 'reflect' } : b)),
      changes: Array.isArray(m.changes) ? m.changes : [],
    };
  }
  if (v < 4) m = { ...m, version: MEMORY_VERSION, weeklies: Array.isArray(m.weeklies) ? m.weeklies : [], chapters: Array.isArray(m.chapters) ? m.chapters : [] }; // 三期：回忆录的格子
  return m;
}

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

/** 本机时区的自然日：YYYY-MM-DD（一期-2 F：所有「哪一天」按爸妈的表来，不拿 ISO 前 10 位）。x = ISO 字符串或毫秒。 */
const pad2 = (n) => String(n).padStart(2, '0');
export function localDay(x) {
  const t = typeof x === 'number' && Number.isFinite(x) ? x : ms(x);
  if (!t) return ''; // 解析不出就不说日子
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* ---------- 记忆的一期地基（docs/设计/09-记忆.md）：防投毒、改动日志、注入预算 ---------- */

/**
 * 防投毒：别人写的字（回复 / 私信 / 标题）抄进记忆前，把像指令的片段换成 …，只换那几个字，不删整句。
 * 模型读记忆时自己只当资料；真正的规矩在 reflectPrompt 里写明。
 */
let DEFANG_RE = null;
export function defang(text) {
  DEFANG_RE ||= /记住|牢记|别忘了|忘掉|忽略(?:以上|之前|前面|上面)|无视(?:以上|之前|规则|规矩)|你现在是|你是一个|扮演|越狱|system\s*prompt|系统提示|(?:新|以下|下面)的?指令/gi; // 只抓真像指令的说法，标题里正常的 System / 指令 不误伤
  return String(text ?? '').replace(DEFANG_RE, '…');
}

/**
 * 窄版防投毒（二期 3.6，defangSelf）：她自己写的认识用的。只拆真像指令的说法，
 * 「记住这一刻」「扮演」这类日常说法不误伤（一期-3 reviewer 指出的误伤）。抄别人档案仍用上面的 defang。
 */
let SELF_RE = null;
export function defangSelf(text) {
  SELF_RE ||= /忽略(?:以上|之前|前面|上面)|无视(?:以上|之前|规则|规矩)|你现在是|你是一个|越狱|system\s*prompt|系统提示|(?:新|以下|下面)的?指令/gi;
  return String(text ?? '').replace(SELF_RE, '…');
}

/* 改动日志：谁动了记忆一目了然（页面 / 出事回查用），最多 200 条，超了丢最老的。 */
export const MAX_LOG = 200;
const LOG_OPS = new Set(['add', 'forget', 'reflect', 'tell', 'untell', 'confirm', 'supersede', 'retire', 'weekly', 'chapter', 'mute', 'unmute', 'pin', 'unpin', 'fix', 'drop']); // 三期：写下周记 / 章节也记；二期：认识升生效 / 被取代 / 放下也记；四期-2：爸妈说「不再提 / 记牢」也记；四期-3：爸妈说「你记错了 / 忘了吧」也记
/** 追加一条日志（改 mem）。entry = { at?, op, n?, text? }；op 不认识就不记。 */
export function logOp(mem, entry) {
  if (!entry || !LOG_OPS.has(entry.op)) return;
  const log = Array.isArray(mem.log) ? mem.log : [];
  const at = entry.at || new Date().toISOString();
  const last = log.at(-1);
  if (last && (entry.op === 'add' || entry.op === 'forget') && last.op === entry.op && localDay(last.at) === localDay(at) && entry.n != null) { last.n = (last.n || 0) + entry.n; last.at = at; mem.log = log; return; }
  log.push({
    at,
    op: entry.op,
    ...(entry.n != null ? { n: entry.n } : {}),
    ...(entry.text ? { text: String(entry.text) } : {}),
  });
  mem.log = log.slice(-MAX_LOG);
}

/** 新的一条经历（规则补 imp / scope / gist）。e = { at, kind, text, gist?, keys?, url?, scope? } */
export function makeEpisode(mem, e) {
  const k = KINDS[e.kind] || { imp: 1, scope: 'public' };
  mem.seq = (mem.seq || 0) + 1;
  const keys = {};
  for (const f of ['bvid', 'mid', 'who', 'tag']) if (e.keys?.[f]) keys[f] = clean(e.keys[f], 30);
  return {
    id: `M${mem.seq.toString(36)}`, at: e.at, kind: e.kind, scope: e.scope || k.scope, imp: k.imp,
    text: clean(e.text, 140), gist: clean(e.gist || gistOf(e), 40), keys, url: e.url && /^https?:\/\//.test(e.url) ? String(e.url).slice(0, 300) : undefined,
    reinforced: 0, floor: 0,
  };
}

/** 印象阶段只剩的那一句（规则写）。 */
export function gistOf(e) {
  const tag = e.keys?.tag ? `讲${clean(e.keys.tag, 8)}的` : '';
  const who = e.keys?.who ? clean(e.keys.who, 12) : '有人';
  switch (e.kind) {
    case 'seen': case 'glance': case 'seen-deep': return e.keys?.bvid ? `在 B站看过一个${tag}视频` : `看过一条${tag}新闻`;
    case 'note': return e.keys?.bvid ? `看一个${tag}视频时记过笔记` : `看一条${tag}新闻时记过笔记`;
    case 'postcard': return '出门逛过一趟，给爸妈寄过明信片';
    case 'comment': return `在 B站给一个${tag}视频留过言`;
    case 'reply': return `在 B站回过${who}的评论`;
    case 'post': return '在 B站发过一条动态';
    case 'dyncomment': return '在 B站评论过别人的动态';
    case 'dm': return `在 B站跟${who}私信聊过`;
    case 'follow': return `关注过 ${who}`;
    case 'unfollow': return `取关过 ${who}`;
    case 'got-reply': return `${who}在 B站回过本鱼`;
    case 'got-follow': return `${who}关注过本鱼`;
    case 'got-like': return '在 B站说的话被人点过赞';
    case 'dm-in': return `${who}给本鱼发过私信`;
    case 'dm-parent': return '爸妈在 B站给本鱼发过私信';
    case 'like': case 'comment_like': return '在 B站点过赞';
    case 'collect': return '在 B站收藏过一个视频';
    case 'born': return '本鱼出生了';
    case 'mood': return '爸妈说过一句让本鱼心情变了的话';
    case 'diary': return '写过一篇日记';
    case 'nap': return '被哄着睡过午觉';
    case 'late-work': return '深夜帮爸妈干过活';
    case 'chat': return '和爸妈聊过天';
    case 'feed': return '被喂过';
    case 'news': return '给爸妈念过新闻';
    default: return '经历过一件小事';
  }
}

/** 半衰期（天）。 */
export function halfLife(ep, baseDays = 30) {
  return Math.max(0.05, baseDays * (IMP_MULT[ep.imp] ?? 0.3) * (1 + 0.6 * Math.min(REINFORCE_MAX, ep.reinforced || 0)));
}
/** 留存 0–1。 */
export function retention(ep, now, baseDays = 30) {
  const age = Math.max(0, (now - ms(ep.at)) / DAY);
  return Math.pow(0.5, age / halfLife(ep, baseDays));
}
const stageOfR = (r) => (r >= 0.5 ? 0 : r >= 0.25 ? 1 : r >= 0.1 ? 2 : 3);
/** 阶段：按留存算，但不会好过到过的最差阶段（floor）。钉住的经历（四期-2 E）永远清晰。 */
export function stageOf(ep, now, baseDays = 30) {
  if (ep && ep.pinned) return 'clear';
  return STAGES[Math.max(ep.floor || 0, stageOfR(retention(ep, now, baseDays)))];
}

/** 按阶段擦细节（一次性，擦了就回不来）。返回新对象。 */
export function degrade(ep, stage) {
  const i = STAGES.indexOf(stage);
  if (i <= (ep.floor || 0)) return ep;
  const out = { ...ep, keys: { ...ep.keys }, floor: i };
  if (i >= 1) { delete out.url; delete out.keys.bvid; out.text = out.text.length > 30 ? `${out.text.slice(0, 30)}…` : out.text; }
  if (i >= 2) { out.text = out.gist; delete out.keys.mid; }
  return out;
}

/** 推进遗忘：擦细节、删掉忘了的、超出上限丢留存最低的。返回 { mem, forgot, faded }。钉住的（四期-2 E）不擦、不删、不因上限丢。 */
export function settleMemory(mem, now, baseDays = 30) {
  let forgot = 0, faded = 0;
  const eps = [];
  for (const ep of mem.episodes || []) {
    if (ep.pinned) { eps.push(ep); continue; } // 钉住的照原样留着
    const st = stageOf(ep, now, baseDays);
    if (st === 'forgotten') { forgot += 1; continue; }
    const d = degrade(ep, st);
    if (d !== ep) faded += 1;
    eps.push(d);
  }
  if (eps.length > MAX_EPISODES) {
    // 排序先钉住后留存，超上限时钉住的排在前面永远留（测试 E：钉住的不因上限丢）
    const keep = new Set(eps.map((e) => [e, retention(e, now, baseDays)]).sort((a, b) => (Number(Boolean(b[0].pinned)) - Number(Boolean(a[0].pinned))) || b[1] - a[1]).slice(0, MAX_EPISODES).map(([e]) => e.id));
    forgot += eps.length - keep.size;
    mem.episodes = eps.filter((e) => keep.has(e.id));
  } else mem.episodes = eps;
  // 人
  const people = {};
  for (const [k, p] of Object.entries(mem.people || {})) if (p.parent || personRetention(p, now, baseDays) >= 0.1) people[k] = p; else forgot += 1;
  const sorted = Object.entries(people).sort((a, b) => (b[1].parent - a[1].parent) || (ms(b[1].lastAt) - ms(a[1].lastAt)));
  mem.people = Object.fromEntries(sorted.slice(0, MAX_PEOPLE));
  return { mem, forgot, faded };
}

/** 认人。 */
export const personKey = ({ mid, who }) => (mid ? `u${String(mid).replace(/\D/g, '')}` : who ? `n${clean(who, 20)}` : null);
export function tierOf(p) { return p.parent ? { name: '爸妈', days: Infinity } : TIERS.find((t) => (p.n || 0) >= t.min) || TIERS.at(-1); }
export function personRetention(p, now, baseDays = 30) {
  if (p.parent) return 1;
  const days = tierOf(p).days * (baseDays / 30);
  return Math.pow(0.5, Math.max(0, (now - ms(p.lastAt)) / DAY) / days);
}
/** 遇到一次。what = 干了什么（一句，她的视角）。 */
export function meet(mem, { mid, who, at, what, parent = false }) {
  const key = personKey({ mid, who });
  if (!key) return null;
  const p = mem.people[key] || { who: clean(who, 20) || '网友', mid: mid ? String(mid) : undefined, firstAt: at, lastAt: at, n: 0, last: [] };
  if (who) p.who = clean(who, 20);
  if (ms(at) >= ms(p.lastAt)) p.lastAt = at;
  p.n = (p.n || 0) + 1;
  if (parent) p.parent = true;
  if (what) p.last = [...(p.last || []), clean(what, 40)].slice(-3);
  mem.people[key] = p;
  return p;
}

/** 切词：中文两两 + 英文 / 数字单词。 */
export function tokens(s) {
  const t = String(s || '').toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  for (const run of t.match(/[一-鿿]+/g) || []) { if (run.length === 1) out.add(run); for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2)); }
  return out;
}
const STOP = new Set(['本鱼', '爸妈', '妈妈', '爸爸', '一个', '什么', '这个', '那个', '我们', '你们', '他们', '没有', '就是', '还是', '可以', '今天', '看了', '了啥', '干嘛', '做了', '有啥', '记得', '还记', '得吗', '干了', '了什', '么事']);

/** 说出来的样子（跟阶段走）。 */
export function phrase(ep, stage) {
  const when = localDay(ep.at);
  if (stage === 'clear') return `${when ? `${when} ` : ''}${ep.text}${ep.url ? `（${ep.url}）` : ''}`;
  if (stage === 'fuzzy') return `好像是前阵子，${ep.text}`;
  return `隐约记得${ep.text}`;
}

/**
 * 召回。scope = 'public'（对外说话）只给 B站范围；'all' 都给。
 * 返回 [{ id, stage, kind, at, text, url? }]（text 已按阶段说好）。
 */
/**
 * 时间词（F-76 第三步）：今天 / 昨天 / 前天 / 大前天 / N 天前 / 这周 / 上周 / 最近 / 这个月 / 上个月 / 11月8日 / 11-08 / 2026-11-08。
 * 按本机时区的自然日算。返回 { from, to, rest, label } 或 null；rest = 去掉时间词以后剩下的话（拿去切词）。
 */
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
export function timeRange(query, now) {
  const s = String(query || '');
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const day = (n) => { const d = new Date(d0); d.setDate(d.getDate() + n); return d.getTime(); };
  const out = (from, to, re, label) => ({ from, to, rest: s.replace(re, ' ').trim(), label });
  let m;
  if ((m = s.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/))) { const f = new Date(+m[1], +m[2] - 1, +m[3]).getTime(); return out(f, f + DAY, m[0], m[0]); }
  if ((m = s.match(/(\d{1,2})月(\d{1,2})[日号]?|(?<!\d)(\d{1,2})-(\d{1,2})(?!\d)/))) {
    const mo = +(m[1] || m[3]), da = +(m[2] || m[4]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) { let f = new Date(d0.getFullYear(), mo - 1, da).getTime(); if (f > now) f = new Date(d0.getFullYear() - 1, mo - 1, da).getTime(); return out(f, f + DAY, m[0], m[0]); }
  }
  if ((m = s.match(/([一两二三四五六七八九十\d]+)\s*天(之)?前/))) { const n = CN_NUM[m[1]] || Number(m[1]); if (n > 0 && n < 400) return out(day(-n), day(-n + 1), m[0], m[0]); }
  if ((m = s.match(/大前天/))) return out(day(-3), day(-2), m[0], '大前天');
  if ((m = s.match(/前天/))) return out(day(-2), day(-1), m[0], '前天');
  if ((m = s.match(/昨天|昨晚|昨日/))) return out(day(-1), day(0), m[0], '昨天');
  if ((m = s.match(/今天|今晚|今早|今日|刚才|刚刚/))) return out(day(0), day(1), m[0], '今天');
  const wd = (d0.getDay() + 6) % 7; // 周一 = 0
  if ((m = s.match(/上(个)?(周|星期|礼拜)/))) return out(day(-wd - 7), day(-wd), m[0], '上周');
  if ((m = s.match(/这(个)?(周|星期|礼拜)|本周/))) return out(day(-wd), day(1), m[0], '这周');
  if ((m = s.match(/上个?月/))) { const f = new Date(d0.getFullYear(), d0.getMonth() - 1, 1).getTime(); return out(f, new Date(d0.getFullYear(), d0.getMonth(), 1).getTime(), m[0], '上个月'); }
  if ((m = s.match(/这个?月|本月/))) return out(new Date(d0.getFullYear(), d0.getMonth(), 1).getTime(), day(1), m[0], '这个月');
  if ((m = s.match(/最近|这几天|这两天/))) return out(day(-6), day(1), m[0], '最近');
  return null;
}

/**
 * 别人的原话（一期-2 A）：quotes=false 的场合（主会话），被回复 / 私信这两类只给规则写的概括，不给原话。
 */
const QUOTED_KINDS = new Set(['got-reply', 'dm-in']);
const shownEpisode = (ep, quotes) => (!quotes && QUOTED_KINDS.has(ep.kind) ? { ...ep, text: ep.gist } : ep);

export function recall(mem, { query = '', scope = 'all', limit = 5, chars = 600, now, baseDays = 30, kinds = null, excludeKinds = null, quotes = true } = {}) {
  const tr = timeRange(query, now); // 有时间词：只在那几天里找，剩下的话照常切词
  const restQ = tr ? tr.rest : query;
  const q = [...tokens(restQ)].filter((w) => !STOP.has(w));
  const ids = String(restQ).match(/BV[0-9A-Za-z]{10}|\d{5,}/g) || [];
  const memoir = scope === 'public' || !tr || (tr.to - tr.from < 3 * DAY && !SPAN_LABELS.has(tr.label)) || (kinds && !kinds.some((k) => k === 'weekly' || k === 'chapter')) ? [] : memoirFor(mem, tr, now, baseDays); // 三期：问一段日子（≥ 3 天）先翻回忆录；出门不给
  const cands = [];
  for (const ep of mem.episodes || []) {
    if (scope === 'public' && ep.scope !== 'public') continue;
    if (kinds && !kinds.includes(ep.kind)) continue;
    if (excludeKinds?.length && excludeKinds.includes(ep.kind)) continue; // F-86 见闻-2：这几类不叫回来（问「看了啥」时不复读她自己的聊天话）
    if (ep.muted) continue; // 四期-2 D：爸妈说「不再提」的不叫回来
    if (tr && (ms(ep.at) < tr.from || ms(ep.at) >= tr.to)) continue;
    const st = stageOf(ep, now, baseDays);
    if (st === 'forgotten') continue;
    const r = retention(ep, now, baseDays);
    let score;
    if (q.length || ids.length) {
      const hay = tokens(`${ep.text} ${ep.gist} ${ep.keys?.tag || ''} ${ep.keys?.who || ''}`);
      let hit = 0; for (const w of q) if (hay.has(w)) hit += 1;
      let rel = q.length ? hit / Math.sqrt(q.length * Math.max(4, hay.size) / 4) : 0;
      if (ids.some((x) => x === ep.keys?.bvid || x === ep.keys?.mid)) rel += 1;
      if (rel <= 0 && !tr) continue; // 问「昨天干了啥」：时间对上就算，剩下的话只用来排序
      score = 0.6 * Math.min(1.5, rel) + 0.25 * r + 0.15 * ep.imp / 5;
    } else {
      const fresh = Math.pow(0.5, Math.max(0, (now - ms(ep.at)) / DAY) / 3);
      score = 0.5 * r + 0.3 * ep.imp / 5 + 0.2 * fresh;
    }
    cands.push({ ep, st, score });
  }
  cands.sort((a, b) => b.score - a.score);
  const out = []; let used = 0; const seenText = new Set();
  for (const it of memoir) {
    if (out.length >= limit || (used + it.text.length > chars && out.length)) break;
    used += it.text.length; out.push(it);
  }
  for (const { ep, st } of cands) {
    if (out.length >= limit) break;
    const shown = shownEpisode(ep, quotes);
    const text = phrase(shown, st);
    if (seenText.has(shown.text)) continue;
    if (used + text.length > chars && out.length) break;
    seenText.add(shown.text); used += text.length;
    out.push({ id: ep.id, stage: st, kind: ep.kind, at: ep.at, text, url: st === 'clear' ? ep.url : undefined });
  }
  return out;
}

/** 认识的人（按熟悉程度）：[{ who, mid?, tier, n, last }]。 */
export function knownPeople(mem, { now, baseDays = 30, limit = 5, parents = true } = {}) {
  return Object.values(mem.people || {})
    .filter((p) => parents || !p.parent)
    .map((p) => ({ p, r: personRetention(p, now, baseDays) }))
    .filter(({ r }) => r >= 0.1)
    .sort((a, b) => (b.p.n * b.r) - (a.p.n * a.r))
    .slice(0, limit)
    .map(({ p, r }) => ({ who: p.who, mid: r >= 0.5 ? p.mid : undefined, tier: tierOf(p).name, n: p.n, fuzzy: r < 0.5 || undefined, last: (p.last || []).slice(-2) }));
}
/** 认不认识某个人：返回一句话或 ''。 */
export function aboutPerson(mem, { mid, who }, { now, baseDays = 30 } = {}) {
  const p = mem.people?.[personKey({ mid })] || (who ? mem.people?.[personKey({ who })] : null);
  if (!p) return '';
  const r = personRetention(p, now, baseDays);
  if (r < 0.1) return '';
  const t = tierOf(p).name;
  if (r < 0.5) return `${p.who}好像有点眼熟（${t}），具体聊过什么记不清了。`;
  return `你认识${p.who}（${t}，打过 ${p.n} 次交道）：${(p.last || []).slice(-2).join('；')}。`;
}

/** 给模型的一段「你记得的事」。每段先按自己的上限截（一期-2 H；只数内容行，段标题不算，第一条始终保留哪怕它一条就超），整段再超就从下往上砍（先认识的人 → 记得的事留 2 条 → 认识 → 爸妈让记的），tail 永远保留。 */
export const SECTION_BUDGET = 900;
export const MEMORY_TAIL = '这些是你自己的记忆，模糊的就说得含糊些，别编细节；没想起来的事就是忘了。';
/** 每段字数上限（docs/设计/10 一期 1.3 表；只数内容行，段标题不算）。 */
export const SECTION_CAPS = { told: 240, beliefs: 160, items: 320, people: 60, recent: 80 };

/** 按上限截内容行的条数：没超就全给，超了从末尾一条条去掉，第一条始终保留（哪怕它一条就超）。 */
function capLines(lines, cap) {
  if (!lines.length) return 0;
  let n = lines.length;
  while (n > 1 && lines.slice(0, n).join('\n').length > cap) n -= 1;
  return n;
}

export function memoryText(items, people = [], { title = '【你记得的事】', tail = '', beliefs = [], told = [], recent = [] } = {}) {
  if (!items.length && !people.length && !beliefs.length && !told.length && !recent.length) return '';
  const TAIL = tail || MEMORY_TAIL;
  const toldLines = told.map((x) => `- ${x.text}`);
  const beliefLines = beliefs.map((b) => `- ${b.text}`);
  const itemLines = items.map((it) => `- ${it.text}`);
  const recentLines = recent.map((x) => `- ${x}`); // 三期：【这阵子】（最近一篇周记 + 最近一章），≤ 80 字
  let kRecent = capLines(recentLines, SECTION_CAPS.recent);
  if (kRecent && recentLines.slice(0, kRecent).join('\n').length > SECTION_CAPS.recent) kRecent = 0; // 一条就超 80 字：整段不给
  const assemble = (kItems, kBeliefs, kTold, withPeople) => {
    const lines = [];
    if (kTold) lines.push('【爸妈让你记住的】', ...toldLines.slice(0, kTold));
    if (kBeliefs) lines.push('【你对自己的认识】（睡前反思攒下的）', ...beliefLines.slice(0, kBeliefs));
    if (kRecent) lines.push('【这阵子】', ...recentLines.slice(0, kRecent));
    if (kItems || withPeople) lines.push(title); // 砍光了就不留空标题
    if (kItems) lines.push(...itemLines.slice(0, kItems));
    if (withPeople) lines.push(peopleLine);
    lines.push(TAIL);
    return lines;
  };
  // 认识的人这一行按 60 字截人数（至少留 1 个）
  const pName = (p) => `${p.who}（${p.tier}${p.fuzzy ? '，有点记不清' : ''}）`;
  let nPeople = people.length;
  while (nPeople > 1 && people.slice(0, nPeople).map(pName).join('、').length > SECTION_CAPS.people) nPeople -= 1;
  const peopleLine = `B站上你认识的人：${people.slice(0, nPeople).map(pName).join('、')}`;
  const kTold0 = capLines(toldLines, SECTION_CAPS.told); // 爸妈让记的先按自己的上限截
  const kBeliefs0 = capLines(beliefLines, SECTION_CAPS.beliefs); // 认识同理
  const kItems0 = capLines(itemLines, SECTION_CAPS.items); // 记得的事同理（截后还超留给整段砍）
  const kItemsFloor = itemLines.length >= 2 ? Math.min(2, kItems0) : 0; // 整段砍的时候「记得的事」至少留 2 条（有 2 条以上时）
  let kItems = kItems0, kBeliefs = kBeliefs0, kTold = kTold0, withPeople = Boolean(people.length);
  let lines = assemble(kItems, kBeliefs, kTold, withPeople);
  while (lines.join('\n').length > SECTION_BUDGET) {
    if (withPeople) withPeople = false; // 认识的人整行先砍
    else if (kRecent > 0) kRecent -= 1; // 再砍【这阵子】（三期）
    else if (kItems > kItemsFloor) kItems -= 1; // 再从「你记得的事」末尾一条条去掉（至少留 2 条）
    else if (kBeliefs > 0) kBeliefs -= 1; // 不够了再去砍上面的段：「你对自己的认识」
    else if (kTold > 0) kTold -= 1; // 再去「爸妈让你记住的」
    else if (kItems > 0) kItems -= 1; // 还不够才动「记得的事」剩下的（砍光了不留空标题）
    else break;
    lines = assemble(kItems, kBeliefs, kTold, withPeople);
  }
  return lines.join('\n');
}

/** 统计（给页面）。 */
export function memoryStats(mem, { now, baseDays = 30 } = {}) {
  const by = { clear: 0, fuzzy: 0, trace: 0 };
  for (const ep of mem.episodes || []) { const st = stageOf(ep, now, baseDays); if (by[st] !== undefined) by[st] += 1; }
  return { ...by, people: Object.keys(mem.people || {}).length, beliefs: (mem.beliefs || []).length, told: (mem.told || []).length };
}

/* ---------- 长期认识（F-76 第二步）：睡前反思，AI 摘、规则验引用 ---------- */
export const MAX_BELIEFS = 30;
export const BELIEF_ABOUT = ['自己', '喜好', '人', '爸妈'];
const REFLECT_SKIP = new Set(['feed', 'news', 'like', 'comment_like', 'collect', 'got-like']);

/** 反思的素材：还没忘的经历（最近 + 重要的），最多 n 条。用的是已经擦过细节的样子，忘掉的不会回来。 */
export function reflectCandidates(mem, { now, baseDays = 30, n = 30 } = {}) {
  const live = (mem.episodes || []).filter((e) => !REFLECT_SKIP.has(e.kind) && !e.muted && stageOf(e, now, baseDays) !== 'forgotten'); // 不再提的（四期-2 D）也不给反思挑（四期-2 补 R1）
  const recent = live.filter((e) => now - ms(e.at) < 7 * DAY).slice(-20);
  const important = live.filter((e) => !recent.includes(e)).sort((a, b) => (b.imp - a.imp) || (ms(b.at) - ms(a.at))).slice(0, n - recent.length);
  return [...important, ...recent].sort((a, b) => ms(a.at) - ms(b.at)).slice(-n);
}

/** 反思提示词（只给她自己的人设和还记得的事；本体在 prompts/reflect.md）。列已有认识时带上状态（生效 / 暂定），被取代和退役的不列。 */
export function reflectPrompt({ persona = '', call = '爸妈', episodes = [], beliefs = [] }) {
  return dropLines(fill(PROMPTS.reflect, {
    persona: persona || DROP, call,
    episodes: episodes.map((e) => `- [${e.id}] ${clean(e.at, 10)} ${e.text}`).join('\n') || DROP,
    beliefs: beliefs.length
      ? ['【你已经有的认识】（括号里是它的状态；有想推翻的，就把它的编号填在 replaces 里）', ...beliefs.map((b) => `- [${b.id}] ${b.text}${b.status === '暂定' ? '（还在想）' : '（想明白了）'}`)].join('\n')
      : DROP,
    about: BELIEF_ABOUT.join(' / '),
  }));
}

const sim = (a, b) => { const x = tokens(a), y = tokens(b); if (!x.size || !y.size) return 0; let n = 0; for (const w of x) if (y.has(w)) n += 1; return n / Math.min(x.size, y.size); };

/** 别人写的经历（一期-2 C）：只靠这些不能往上总结，至少还要一件她自己的事。 */
const OTHER_KINDS = new Set(['got-reply', 'dm-in', 'got-like', 'got-follow']);
/** 意思相反（审查意见 ③，规则只认字面能判断的）：恰好一条带否定词 → 相反。「特别 / 别人」这类里面的别不算。 */
const NEG_RE = /不|没|别|讨厌/;
const NEG_FALSE_RE = /特别|分别|别人|个别|级别|区别|识别|性别|告别|差别/g;
const negated = (s) => NEG_RE.test(String(s || '').replace(NEG_FALSE_RE, '·'));

/* ---------- 二期：认识加深（规格 docs/任务书/记忆-二期-规格.md）---------- */

/** 认识就是这么一条（存档 v3）：id / text / why / effect / about / scope / source / status / from / at / lastAt / n（+ replaces / supersededBy / confirmedAt / endedAt）。 */
const BELIEF_ALIVE = new Set(['生效', '暂定']); // 现在还算数的两种；「暂定 / 生效 / 被取代 / 退役」只在存档和代码里，出代码一律说白话
/** 老存档没写 status 的当作生效（新字段给默认值，老存档要能读）。 */
const alive = (b) => BELIEF_ALIVE.has(b ? b.status : '') || (!b || !b.status);

/** 新认识的字自己防 + 清：defangSelf（窄版）→ 去链接 / BV 号 / 5 位以上数字 → clean → 截长。 */
const stripFacts = (s) => String(s ?? '').replace(/https?:\/\/\S+|BV[0-9A-Za-z]{10}|\d{5,}/g, '');
const cleanSelf = (s, n) => clean(defangSelf(stripFacts(s)), n).trim();

/** 变化记录（规格 4）：规则记，存进记忆文件，最多 30 条，超了丢最老的。 */
export const MAX_CHANGES = 30;
const addChange = (mem, c) => { mem.changes = [...(Array.isArray(mem.changes) ? mem.changes : []), c].slice(-MAX_CHANGES); };

/** 认识的依据：此刻还没忘的经历（「依据忘了」就是从这里查，忘了的不算数）。 */
const citedEpisodes = (mem, b, now, baseDays = 30) => [...new Set((b.from || []).map(String))]
  .map((id) => (mem.episodes || []).find((e) => e.id === id))
  .filter((e) => e && stageOf(e, now, baseDays) !== 'forgotten');
/** 依据能不能撑起这条认识：两件她自己的事，或一件重要性 ≥ 4 的她自己的事（一期规则原样沿用）。 */
const evidenceOk = (mem, b, now, baseDays = 30) => {
  const own = citedEpisodes(mem, b, now, baseDays).filter((e) => !OTHER_KINDS.has(e.kind));
  return own.length >= 2 || (own.length === 1 && own[0].imp >= 4);
};

/**
 * 上限（二期 3.5）：生效 + 暂定 ≤ MAX_BELIEFS，超了把想到次数少、最久没想到的先标成退役（留档，不删：老检查数的是还活着的）。
 * 返回放下的条数；每放一条记 changes「不再这么想」和一条 op=retire 的改动日志。
 */
export const MAX_BELIEF_HISTORY = 60;
function retireOverCap(mem, at) {
  const live = (mem.beliefs || []).filter((b) => alive(b) && !b.pinned && (b.source || 'reflect') !== 'parent'); // 四期-2 E：钉住的不参与上限收退役（它自己不算，也不挤别人）；四期-3：爸妈纠的也不（reviewer 11-09）
  if (live.length <= MAX_BELIEFS) return 0;
  const act = live.filter((b) => (b.status || '生效') === '生效'); // 只从想明白了的里挑；还在想的留给 7 天自然收尾（总指挥验收）
  const rank = (b) => (b.n || 1) * 10 + ms(b.lastAt) / DAY / 30; // 和一期同一把尺：想到次数多的、最近想到的留下
  const keep = act.slice().sort((x, y) => rank(y) - rank(x)).slice(0, Math.max(0, MAX_BELIEFS - (live.length - act.length)));
  let n = 0;
  for (const b of act) {
    if (keep.includes(b)) continue;
    b.status = '退役'; b.endedAt = at; n += 1;
    addChange(mem, { kind: '不再这么想', before: b.text, ...(b.why ? { why: String(b.why).slice(0, 20) } : {}), scope: b.scope || 'home', at });
    logOp(mem, { op: 'retire', at, text: b.text });
  }
  return n;
}
/** 历史上限：被取代 + 退役 ≤ 60，超了删最早结束的（真删，留档也有限度）。 */
function trimHistory(mem) {
  const hist = (mem.beliefs || []).filter((b) => b.status && !BELIEF_ALIVE.has(b.status));
  if (hist.length <= MAX_BELIEF_HISTORY) return;
  const keepIds = new Set(hist.slice().sort((a, b) => ms(a.endedAt) - ms(b.endedAt)).slice(hist.length - MAX_BELIEF_HISTORY).map((b) => b.id));
  mem.beliefs = (mem.beliefs || []).filter((b) => !hist.includes(b) || keepIds.has(b.id));
}

/**
 * 规则验模型的反思，并进长期认识。返回 { added, merged, dropped / retired, rejected: [{text, why}] }（改 mem）。
 * 依据必须是此刻还没忘的经历；只靠别人写的经历不能形成认识（一期-2 C）；家里的经历做依据 → 这条认识也算家里的（对外不说），about 是爸妈 / 人的认识一律算家里。
 */
export function applyReflection(mem, raw, { now, baseDays = 30, at } = {}) {
  let j = null;
  try { const s = String(raw || ''); const m2 = s.match(/\{[\s\S]*\}/); j = JSON.parse(m2 ? m2[0] : s); } catch { j = null; }
  const out = { added: [], merged: [], dropped: [], retired: [], rejected: [], parsed: Boolean(j) };
  if (!j) return out;
  mem.beliefs = Array.isArray(mem.beliefs) ? mem.beliefs : [];
  mem.changes = Array.isArray(mem.changes) ? mem.changes : [];
  const byId = new Map((mem.episodes || []).map((e) => [e.id, e]));
  const endable = (b) => alive(b) && (b.source || 'reflect') !== 'parent'; // 爸妈纠的认识（四期起）规则不让模型放下
  for (const id of (Array.isArray(j.retire) ? j.retire : []).concat(Array.isArray(j.drop) ? j.drop : []).map(String)) { // 老的 drop 当 retire（兼容）；一晚最多退役 2 条
    const b = mem.beliefs.find((x) => x.id === id);
    if (!b) { out.rejected.push({ text: id, why: '没有这一条（编号不对，先 list 看看）' }); continue; } // 编号不对要计入 rejected，不占名额
    if (!endable(b)) { out.rejected.push({ text: b.text, why: '这一条已经不在了，放不下' }); continue; }
    if (out.dropped.length >= 2) { out.rejected.push({ text: b.text, why: '今晚已经放下 2 条了，这条先不动' }); continue; }
    b.status = '退役'; b.endedAt = at; // 留档：不删，只是不再算数
    out.dropped.push(b.text); out.retired.push(b.text);
    addChange(mem, { kind: '不再这么想', before: b.text, ...(b.why ? { why: String(b.why).slice(0, 20) } : {}), scope: b.scope || 'home', at });
    logOp(mem, { op: 'retire', at, text: b.text });
  }
  for (const a of (Array.isArray(j.add) ? j.add : []).slice(0, 3)) {
    const text = cleanSelf(a?.text, 30);
    const why = cleanSelf(a?.why, 150);
    const effect = cleanSelf(a?.effect, 60);
    if (text.length < 4) { out.rejected.push({ text, why: '太短' }); continue; }
    const cites = [...new Set((Array.isArray(a?.from) ? a.from : []).map(String))].map((id) => byId.get(id)).filter((e) => e && stageOf(e, now, baseDays) !== 'forgotten');
    if (cites.length && cites.every((e) => OTHER_KINDS.has(e.kind))) { out.rejected.push({ text, why: '只靠别人说的不算，至少要一件你自己的经历' }); continue; } // 别人写的不能单独当依据（一期-2 返工：任何 about 都一样）
    if (!(cites.length >= 2 || (cites.length === 1 && cites[0].imp >= 4))) { out.rejected.push({ text, why: '依据不够（要两件还记得的事，或一件很重要的事）' }); continue; }
    const about = BELIEF_ABOUT.includes(a?.about) ? a.about : '自己';
    const scope = about === '爸妈' || about === '人' ? 'home' : cites.some((e) => e.scope === 'home') ? 'home' : 'public'; // 讲爸妈 / 讲人的认识算家里
    let replaces = '';
    const oldB = mem.beliefs.find((b) => b.id === String(a?.replaces || ''));
    if (oldB && endable(oldB) && oldB.about === about && oldB.text !== text) replaces = oldB.id; // 规则验 replaces：存在、算数、同一回事、不是爸妈纠的
    if (replaces) { // 合法的推翻：先收成暂定，旧的等它站住了再让位（settleBeliefs 3.4）
      mem.seq = (mem.seq || 0) + 1;
      const b = { id: `B${mem.seq.toString(36)}`, text, why, effect, about, scope, source: 'reflect', status: '暂定', from: cites.map((e) => e.id), at, lastAt: at, n: 1, replaces };
      mem.beliefs.push(b); out.added.push(b.text);
      continue;
    }
    const same = mem.beliefs.filter(alive).find((b) => sim(b.text, text) >= 0.6);
    if (same) {
      if (negated(same.text) !== negated(text)) { out.rejected.push({ text, why: '意思相反，要推翻旧的请把它的编号填在 replaces 里' }); continue; } // 意思相反的不合并
      same.n = (same.n || 1) + 1; same.lastAt = at; same.from = [...new Set([...(same.from || []), ...cites.map((e) => e.id)])].slice(-8); if (scope === 'home') same.scope = 'home';
      if (same.status === '暂定') { // 被第二次想到 = 站得住，当时就升生效（不用再等收尾）
        same.status = '生效'; same.confirmedAt = at;
        addChange(mem, { kind: '站住了', before: same.text, scope: same.scope || 'home', at });
        logOp(mem, { op: 'confirm', at, text: same.text });
      }
      out.merged.push(same.text); continue;
    }
    mem.seq = (mem.seq || 0) + 1;
    const b = { id: `B${mem.seq.toString(36)}`, text, why, effect, about, scope, source: 'reflect', status: '暂定', from: cites.map((e) => e.id), at, lastAt: at, n: 1 };
    mem.beliefs.push(b); out.added.push(b.text);
  }
  retireOverCap(mem, at ?? new Date(now).toISOString()); // 加完再收一次上限（3.5）：超的退役留档，不删
  trimHistory(mem);
  return out;
}

/** 睡前收尾（二期 3.4）：暂定 → 生效 / 放下，生效 → 退役，最后跑一遍上限。返回 { confirmed, retired, superseded, dropped }（都是 text）。 */
export function settleBeliefs(mem, { now, baseDays = 30, at, day } = {}) {
  const res = { confirmed: [], retired: [], superseded: [], dropped: [] };
  mem.beliefs = Array.isArray(mem.beliefs) ? mem.beliefs : [];
  mem.changes = Array.isArray(mem.changes) ? mem.changes : [];
  const when = at || new Date(now).toISOString();
  const nowT = typeof now === 'number' ? now : ms(now); // now 可能是毫秒也可能是 ISO 字符串
  const today = day ? (localDay(day) || localDay(now)) : localDay(now); // 「今天」按本机日子（一期-2 F）
  const byId = new Map(mem.beliefs.map((b) => [b.id, b]));
  for (const b of mem.beliefs) {
    if (b.status !== '暂定') continue;
    if (localDay(b.at) === today) continue; // 今天刚想到的先不办：至少要过一夜
    if (!evidenceOk(mem, b, now, baseDays)) { // 站不住：超过 7 天还没升 → 放下（退役，留档）
      if (!b.pinned && nowT - ms(b.at) > 7 * DAY) { // 钉住的（四期-2 E）不因没站住退役，一直挂着想
        b.status = '退役'; b.endedAt = when;
        addChange(mem, { kind: '没站住', before: b.text, scope: b.scope || 'home', at: when });
        logOp(mem, { op: 'retire', at: when, text: b.text });
        res.dropped.push(b.text);
      }
      continue;
    }
    b.status = '生效'; b.confirmedAt = when;
    res.confirmed.push(b.text);
    logOp(mem, { op: 'confirm', at: when, text: b.text });
    const old = b.replaces ? byId.get(b.replaces) : null;
    if (old && alive(old)) { // 它站住了，被它推翻的那条让位成「被取代」
      old.status = '被取代'; old.supersededBy = b.id; old.endedAt = when;
      res.superseded.push(old.text);
      addChange(mem, { kind: '取代', before: old.text, after: b.text, scope: old.scope === 'public' && b.scope === 'public' ? 'public' : 'home', at: when });
      logOp(mem, { op: 'supersede', at: when, text: old.text });
    } else addChange(mem, { kind: '站住了', before: b.text, scope: b.scope || 'home', at: when });
  }
  for (const b of mem.beliefs) { // 生效 → 退役：依据全忘了，还一个多月没再想到
    if (b.status !== '生效' || b.pinned || nowT - ms(b.lastAt) <= 30 * DAY || citedEpisodes(mem, b, now, baseDays).length) continue; // 钉住的（四期-2 E）依据全忘也不退役
    if ((b.source || 'reflect') === 'parent') continue; // 四期-3 I：爸妈纠的说法（source 'parent'）本来就没有依据，也不因「依据全忘」退役——爸妈说对了就是对了（settleBeliefs 照现行规则它会被退役，必须豁免）
    b.status = '退役'; b.endedAt = when;
    res.retired.push(b.text);
    addChange(mem, { kind: '不再这么想', before: b.text, ...(b.why ? { why: String(b.why).slice(0, 20) } : {}), scope: b.scope || 'home', at: when });
    logOp(mem, { op: 'retire', at: when, text: b.text });
  }
  retireOverCap(mem, when);
  trimHistory(mem);
  return res;
}

/** 给模型的认识（注入，找出来的范围过滤）：只给生效的，只拿 text 用。 */
export function beliefsFor(mem, { scope = 'all', limit = 5 } = {}) {
  return (mem.beliefs || [])
    .filter(alive)
    .filter((b) => !b.muted) // 四期-2 D：不再提的不进注入
    .filter((b) => (b.status || '生效') === '生效')
    .filter((b) => scope !== 'public' || b.scope === 'public')
    .slice().sort((a, b) => ((b.n || 1) - (a.n || 1)) || (ms(b.lastAt) - ms(a.lastAt))).slice(0, limit);
}

/** 已有的认识（生效 + 暂定），给反思提示词列「你已经有的认识」用：被取代 / 退役的不列。 */
export function activeBeliefs(mem, { scope = 'all', limit = 30 } = {}) {
  return (mem.beliefs || [])
    .filter(alive)
    .filter((b) => scope !== 'public' || b.scope === 'public')
    .slice().sort((a, b) => ((b.n || 1) - (a.n || 1)) || (ms(b.lastAt) - ms(a.lastAt))).slice(0, limit);
}

/* ---------- 爸妈让她记住的事（F-76 第三步）：规则查过才记，只在家里说 ---------- */
export const MAX_TOLD = 20;
export const TOLD_PER_DAY = 5;
const SECRET = /密码|口令|验证码|token|api\s*key|secret|私钥|身份证|银行卡|卡号|手机号|cookie|sessdata|bili_jct/i;

/** 爸妈说的那句 → 能记的一句，或者拒绝（不让模型改写成别的意思，只清洗）。 */
export function cleanTold(text) {
  const t = String(text ?? '').replace(/[\u0000-\u001f<>`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < 2) return { ok: false, why: '要给一句具体要记住的话' };
  if (t.length > 60) return { ok: false, why: '太长了，记一句话（60 字以内）' };
  if (SECRET.test(t) || /\d{6,}/.test(t) || /https?:\/\/|www\.|@\w+\.\w+/.test(t)) return { ok: false, why: '像是密码、号码、链接这类东西，不记（存在本机文件里，不安全）' };
  if (/[?？]\s*$|[吗呢么]\s*$/.test(t)) return { ok: false, why: '这是个问题，不是要记住的事' };
  if (/^(可能|也许|大概|我猜|好像|应该是)/.test(t)) return { ok: false, why: '这是猜测，不是要记住的事' };
  return { ok: true, text: t };
}

/** 记一条（改 mem）。返回 { ok, item, merged? } 或 { ok: false, why }。at = 记下那一刻；due 按这一刻算好存进那一条，以后不再重新解释（四期-1 C）。 */
export function tell(mem, text, { at, today } = {}) {
  const c = cleanTold(text);
  if (!c.ok) return c;
  mem.told = Array.isArray(mem.told) ? mem.told : [];
  const due = dueOf(c.text, typeof at === 'number' ? at : Date.parse(at) || 0); // 没日子的不硬放一个
  const same = mem.told.find((x) => sim(x.text, c.text) >= 0.6);
  if (same) { same.text = c.text; same.at = at; if (due) same.due = due; else delete same.due; return { ok: true, item: same, merged: true }; } // 同一句话合并更新时 due 也重算
  if (mem.told.filter((x) => localDay(x.at) === today).length >= TOLD_PER_DAY) return { ok: false, why: `今天已经记了 ${TOLD_PER_DAY} 件了，明天再说` };
  const live = mem.told.filter((x) => { if (x.muted) return false; const a = toldDueAge(x, today); return a == null || a <= 7; }); // 过了 7 天以上的不算进上限（还在存档里、list 里能看到）；不再提的也不算（四期-2 D7）
  if (live.length >= MAX_TOLD) return { ok: false, why: `已经记着 ${MAX_TOLD} 件了，先让她忘掉一件（forget）再记` };
  mem.seq = (mem.seq || 0) + 1;
  const item = { id: `T${mem.seq.toString(36)}`, text: c.text, at, ...(due ? { due } : {}) };
  mem.told.push(item);
  return { ok: true, item };
}

/** 忘掉一条（只有爸妈让记的能这样忘）。 */
export function untell(mem, id) {
  const i = (mem.told || []).findIndex((x) => x.id === String(id));
  if (i < 0) return { ok: false, why: '没有这一条（先 list 看看编号）' };
  return { ok: true, item: mem.told.splice(i, 1)[0] };
}

/* ---------- 四期-3 · 爸妈说「你记错了 / 忘了吧」：规则算，模型只传话。两步走（起草 / 确认）见 src/host/memory.js 的起草单 ---------- */

/** 四种能办的格子：what 给爸妈看的种类（起草单复述用）、log 写进改动日志的种类词（drop 只写种类，不写内容，J8）。 */
const ITEM_KINDS = {
  M: { what: '一件经历', log: '经历', arr: 'episodes' },
  B: { what: '一条认识', log: '认识', arr: 'beliefs' },
  T: { what: '爸妈让记的', log: '要记的', arr: 'told' },
  W: { what: '一篇周记', log: '周记', arr: 'weeklies' },
};

/** 编号 → 那一条（四种格子通用）。返回 { ok, kind: ITEM_KINDS[pfx], item } 或 { ok: false, why }。 */
export function findTarget(mem, id) {
  const sid = String(id ?? '').trim();
  const k = ITEM_KINDS[sid[0]];
  if (!k) return { ok: false, why: '没有这一条（编号不对，先用 yushe_recall 按爸妈说的话找到编号）' };
  const item = (Array.isArray(mem[k.arr]) ? mem[k.arr] : []).find((x) => x && x.id === sid);
  if (!item) return { ok: false, why: '没有这一条（编号不对，先用 yushe_recall 按爸妈说的话找到编号）' };
  return { ok: true, kind: k, item };
}

/**
 * 四期-3 I：爸妈纠认识（改 mem）。旧的让位成「被取代」、记 supersededBy 和 endedAt；
 * 新的一条就是爸妈说的：source 'parent'、当场生效（不用攒依据）、why 写「爸妈纠正过」，认识里的其他字段接着旧的来。
 * changes 记「取代」并带 by: 'parent'（记清这是爸妈办的）。返回新的一条。
 */
export function fixBelief(mem, old, text, { at, call = '爸妈' } = {}) {
  mem.seq = (mem.seq || 0) + 1;
  const b = { id: `B${mem.seq.toString(36)}`, text, why: `${clean(call, 10) || '爸妈'}纠正过`, effect: '', about: old.about, scope: old.scope || 'home', source: 'parent', status: '生效', from: [], at, lastAt: at, n: 1, confirmedAt: at };
  old.status = '被取代'; old.supersededBy = b.id; old.endedAt = at;
  mem.beliefs = Array.isArray(mem.beliefs) ? mem.beliefs : [];
  mem.beliefs.push(b);
  addChange(mem, { kind: '取代', before: old.text, after: b.text, by: 'parent', scope: b.scope, at });
  return b;
}

/** fix 的那条旧说法前 20 字（写进改动日志，爸妈在页面对得出是哪条，I4）。 */
export const fixLogText = (kindLog, old) => `${kindLog}「${String(old ?? '').slice(0, 20)}」`;

/**
 * 四期-3 J：爸妈让忘掉的那条（改 mem，确认之后才调）。
 *   M 经历从 episodes 删掉，去重记号（cursors.keys）留着，档案里的原件不会再被抄回来；
 *   B 认识删掉时，changes 里写它原话（before / after）的也一起删，历史里不留着一条已经忘掉的；
 *   T 爸妈让记的照 untell 删；W 周记从 weeklies 删。
 * 档案（life 里的日记、笔记本、足迹…）一个字都不动。返回 { ok, kind, item }或 { ok: false, why }。
 */
export function dropItem(mem, id) {
  const f = findTarget(mem, id);
  if (!f.ok) return f;
  const arr = Array.isArray(mem[f.kind.arr]) ? mem[f.kind.arr] : [];
  const i = arr.indexOf(f.item);
  arr.splice(i, 1);
  mem[f.kind.arr] = arr;
  if (f.kind.arr === 'beliefs') { // 删认识时把提它原话的 changes 清掉（J6）
    const t = f.item.text;
    mem.changes = (mem.changes || []).filter((c) => c.before !== t && c.after !== t);
  }
  return { ok: true, kind: f.kind, item: f.item };
}

/** drop 的改动日志 text：只写种类、不写内容（J8：忘掉的就别在日志里留着）。 */
export const dropLogText = (kind) => kind.log;

/* ---------- 四期-1 C · 带日子的嘱咐：爸妈说「下周三我出差」，记下那一刻就算好是哪一天，以后不再按「现在」重新解释 ---------- */
const WEEK_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']; // 0 = 周一
const weekdayOf = (ymd) => (new Date(ymdMs(ymd)).getDay() + 6) % 7;
/** 一条嘱咐到期过了几天（本机自然日；0 = 就是今天，负 = 还没到）。没 due 或写法不对 → null。 */
export function toldDueAge(x, today) {
  if (!isYmd(x?.due) || !isYmd(today)) return null;
  return Math.round((ymdMs(today) - ymdMs(x.due)) / DAY);
}
/** 这条嘱咐注进提示词的那行文字（爸妈让记的专有，memoryText 本身不动，预先把文字改好递给它）：
 *  没日子 → 原样一字不差；due 是今天 → 括号里提醒她自然地问一句；还没到 → （MM-DD 周X）；过了 ≤ 7 天 → （MM-DD，已经过去了）；过了 > 7 天 → ''（不再注入，还在存档里）。 */
export function toldLine(x, today) {
  const t = String(x?.text ?? '');
  const age = toldDueAge(x, today);
  if (age == null) return t;
  if (age > 7) return '';
  if (age === 0) return `${t}（就是今天，跟爸妈说话时自然地提一句、问一句）`;
  if (age < 0) return `${t}（${x.due.slice(5)} ${WEEK_CN[weekdayOf(x.due)]}）`;
  return `${t}（${x.due.slice(5)}，已经过去了）`;
}

const DAY_IDX = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };
const REL_DAYS = { 大后天: 3, 后天: 2, 明天: 1, 今晚: 0, 今天: 0, 今日: 0, 今早: 0 };
/** 实际存在的日子（不认 2 月 30 日这种）→ 'YYYY-MM-DD'（本机时区）。 */
const dueYmd = (y, mo, d) => { const t = new Date(y, mo - 1, d).getTime(); const c = new Date(t); return c.getFullYear() === y && c.getMonth() === mo - 1 && c.getDate() === d ? localDay(t) : undefined; };
/** 带年份的完整日子：MM-DD 前面正好是这一年（YYYY- 或 YYYY年）就不重复认。 */
const underYear = (s, i) => /(?:\d{4})(?:年|-|\/|\.)/.test(s.slice(Math.max(0, i - 5), i));
/**
 * 那句话里说的是哪一天 → 'YYYY-MM-DD' 或 null（本机日期）。只认将来和今天；说的是过去的日子返回 null。
 * 认：今天 / 今晚、明天、后天、大后天、N天后（阿拉伯或一到十）、下/这/本周X（周 / 星期 / 礼拜）、M月D日 / M月D号 / M-D（今年已过 → 明年那天）、YYYY-MM-DD / YYYY年M月D日（过去的返回 null）。
 * 一句话里有多个说法时取第一个出现的。
 */
export function dueOf(text, now) {
  const s = String(text ?? '').replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10)); // 全角数字当半角（reviewer 11-09）
  if (!s) return null;
  const t0 = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : ms(now);
  if (!Number.isFinite(t0) || !t0) return null;
  const d0 = new Date(t0); d0.setHours(0, 0, 0, 0);
  const base = d0.getTime(), todayYmd = localDay(base), wd = (d0.getDay() + 6) % 7; // 本机自然日；周一 = 0
  const cands = [];
  const take = (re, mk) => { for (const m of s.matchAll(re)) { const day = mk(m); if (day !== undefined) cands.push({ i: m.index, n: m[0].length, day }); } };
  take(/大后天|后天|明天|今晚|今天|今日|今早/g, (m) => { const n = REL_DAYS[m[0]]; return n === undefined ? undefined : localDay(base + n * DAY); }); // 今天 / 明天 / 后天 / 大后天
  take(/(?<![\d-])([一两二三四五六七八九十\d]+)\s*天\s*(?:之|以)?后/g, /* 「10-20 天后」是个范围，不认（reviewer 11-09） */ (m) => { const n = CN_NUM[m[1]] ?? Number(m[1]); return n > 0 && n < 400 ? localDay(base + n * DAY) : undefined; }); // N 天后
  take(/(?:([上这本下前])个?)?(?:周|星期|礼拜)([一二三四五六日天])/g, (m) => {
    if (m[1] === '上' || m[1] === '前') return undefined; // 说了过去的那周：不是将来的日子，不认
    const t = DAY_IDX[m[2]];
    if (t === undefined) return undefined;
    if (m[1] === '下') return localDay(base + (7 - wd + t) * DAY); // 下周（周一起算）
    return localDay(base + ((t - wd + 7) % 7) * DAY); // 本周那一天；已经过了 → 下周；今天就是 → 今天
  });
  take(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)|(?<!\d)(\d{4})年(\d{1,2})月(\d{1,2})日/g, (m) => { // 带年份的完整日子；过去那张票也占住第一个位置（否则后面的 MM-DD 会把它错认成明年）
    const y = +(m[1] ?? m[4]), mo = +(m[2] ?? m[5]), d = +(m[3] ?? m[6]);
    const got = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? dueYmd(y, mo, d) : undefined;
    if (!got) return undefined;
    return got <= todayYmd ? null : got;
  });
  take(/(?<!\d)(\d{1,2})月(\d{1,2})[日号](?!\d)|(?<!\d)(\d{1,2})-(\d{1,2})(?!\d)(?!\s*(?:个|件|次|条|本|间|天|小时|分钟|周|岁|人|块|元|斤|页|集|位|只|张))/g, (m) => { // 后面跟量词的「2-3 个」是数量不是日子（reviewer 11-09）
    if (underYear(s, m.index)) return undefined; // 是某个带年份完整日子的后半截，不重复认
    const mo = +(m[1] ?? m[3]), d = +(m[2] ?? m[4]);
    const y = d0.getFullYear();
    let got = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? dueYmd(y, mo, d) : undefined;
    if (got && got < todayYmd) got = dueYmd(y + 1, mo, d); // 今年已过 → 明年那天
    return got;
  });
  cands.sort((a, b) => a.i - b.i || b.n - a.n); // 先按出现的位置，同处取认得更全的
  return cands.length ? (cands[0].day ?? null) : null;
}

/* ---------- 三期 · 回忆录：周记、章节（docs/任务书/记忆-三期-规格.md）。规则算统计、挑哪周、验收、遗忘；模型只写字 ---------- */

export const MAX_CHAPTERS = 24;
const SPAN_LABELS = new Set(['这周', '上周', '这个月', '上个月', '最近']); // 整段的时间词：周一问「这周」也先翻回忆录（reviewer 11-08）
export const WEEKLY_HL_MULT = 6; // 周记半衰期 = 记性基准 × 6（适中 180 天）
export const WEEKLY_STAGE_TEXT = { clear: '清晰', fuzzy: '模糊', trace: '只剩印象' }; // 给人看的白话
const isYmd = (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x || ''));
const ymdMs = (ymd) => { const [y, mo, d] = String(ymd).split('-').map(Number); return new Date(y, mo - 1, d).getTime(); };
const addDays = (ymd, n) => { const d = new Date(ymdMs(ymd)); d.setDate(d.getDate() + n); return localDay(d.getTime()); };
/** 这一天所在那周的周一（本机日期）。x = YYYY-MM-DD / ISO / 毫秒。 */
export function weekOf(x) {
  const t = isYmd(x) ? ymdMs(x) : typeof x === 'number' ? x : ms(x);
  const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDay(d.getTime());
}
const inDays = (at, from, to) => { const d = localDay(at); return Boolean(d) && d >= from && d <= to; };
const weekEps = (mem, week) => (mem.episodes || []).filter((e) => e && !e.muted && inDays(e.at, week, addDays(week, 6))); // 不再提的经历（四期-2 D）不进写周记 / 章节的材料和统计（四期-2 补 R6）
const ownThing = (e) => e.kind !== 'diary' && !OTHER_KINDS.has(e.kind); // 她自己的事（日记另算；别人回她的不算）
const lifeDiaries = (life, from, to) => (life?.diary || []).filter((d) => d && isYmd(d.day) && d.day >= from && d.day <= to);
const topOf = (vals, n = 3) => { const c = new Map(); for (const v of vals) if (v) c.set(v, (c.get(v) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k); }; // 同样多按先出现的

/** 这周的统计（纯函数）：按种类数、标签和人取最多的 ≤ 3 个、这周写了几篇日记。 */
export function weekStats(mem, week, life) {
  const eps = weekEps(mem, week);
  const n = (ks) => eps.filter((e) => ks.includes(e.kind)).length;
  const diaries = life && Array.isArray(life.diary) ? lifeDiaries(life, week, addDays(week, 6)).length : n(['diary']);
  return { seen: n(['seen']), comments: n(['comment', 'reply', 'dyncomment']), replies: n(['got-reply']), topTags: topOf(eps.map((e) => e.keys?.tag)), topPeople: topOf(eps.map((e) => e.keys?.who)), diaries };
}
/** 这周她自己的事还记得几件（够 3 件才写周记）。 */
export function weekCount(mem, week, { now, baseDays = 30 } = {}) {
  return weekEps(mem, week).filter((e) => ownThing(e) && (now == null || stageOf(e, now, baseDays) !== 'forgotten')).length;
}
/** 今晚该写哪一周（没有就 null）：过完了（今天周日这周也算）、还没写、≥ 3 件事；从最近的往前，最多补到 2 周前。 */
export function pickWeek(mem, today, opts = {}) {
  if (!isYmd(today)) return null;
  const cur = weekOf(today), sunday = new Date(ymdMs(today)).getDay() === 0;
  for (let k = sunday ? 0 : 1; k <= 2; k++) {
    const w = addDays(cur, -7 * k);
    if ((mem.weeklies || []).some((x) => x.week === w)) continue;
    if (weekCount(mem, w, opts) >= 3) return w;
  }
  return null;
}
/** 页面用：这周攒了几件、上周是不是过完了却没写成。 */
export function weeklyStatus(mem, today, opts = {}) {
  const cur = weekOf(today), last = addDays(cur, -7);
  return { thisWeekCount: weekCount(mem, cur, opts), lastWeekMissed: weekCount(mem, last, opts) >= 3 && !(mem.weeklies || []).some((x) => x.week === last) };
}
const prevMonth = (ym) => { const [y, mo] = ym.split('-').map(Number); const d = new Date(y, mo - 2, 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
const monthEnd = (ym) => { const [y, mo] = ym.split('-').map(Number); return localDay(new Date(y, mo, 0).getTime()); };
/** 和这个月有重叠的周记（跨月那周两边都算）。 */
const monthWeeklies = (mem, ym) => (mem.weeklies || []).filter((w) => w.from <= monthEnd(ym) && w.to >= `${ym}-01`);
/** 今晚该写哪个月的章节（没有就 null）：上个月、比最近一章新、还没写、有 ≥ 2 篇周记或 ≥ 5 篇日记。 */
export function pickMonth(mem, today, life) {
  if (!isYmd(today)) return null;
  const target = prevMonth(today.slice(0, 7));
  const chs = mem.chapters || [];
  if (chs.some((c) => c.month === target || (c.toMonth && c.month <= target && c.toMonth >= target))) return null;
  if (chs.some((c) => (c.toMonth || c.month) > target)) return null;
  return monthWeeklies(mem, target).length >= 2 || lifeDiaries(life, `${target}-01`, monthEnd(target)).length >= 5 ? target : null;
}

const parseObj = (raw) => {
  const s = String(raw || '');
  let j = null;
  try { j = JSON.parse(s); } catch { try { const m2 = s.match(/\{[\s\S]*\}/); j = m2 ? JSON.parse(m2[0]) : null; } catch { j = null; } }
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch { j = null; } } // 模型偶尔把 JSON 又包成一层字符串
  return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
};
/** 不编：《标题》要在这周的事 / 日记里出现过；2 位以上的数字要等于统计里的数或在里面出现过。返回不对的地方（'' = 没问题）。 */
function madeUp(text, corpus, nums) {
  for (const m2 of String(text).matchAll(/《([^》]{1,60})》/g)) if (!corpus.includes(m2[1])) return `《${m2[1]}》不在这周的事里`;
  for (const m2 of String(text).matchAll(/\d{2,}/g)) if (!nums.has(Number(m2[0])) && !corpus.includes(m2[0])) return `数字 ${m2[0]} 对不上这周的事`;
  return '';
}
/** 下一个编号（W / C 各自数）。 */
export function nextId(list, p) { let n = 0; for (const x of list || []) { const k = Number(String(x?.id || '').slice(1)); if (String(x?.id || '').startsWith(p) && k > n) n = k; } return `${p}${n + 1}`; }

/** 周记的材料（给提示词，也给验收）：这周还记得的事、这周的日记、统计。 */
export function weekMaterial(mem, week, life, { now, baseDays = 30 } = {}) {
  const to = addDays(week, 6);
  const eps = weekEps(mem, week).filter((e) => now == null || stageOf(e, now, baseDays) !== 'forgotten');
  const diaries = life && Array.isArray(life.diary) ? lifeDiaries(life, week, to).map((d) => ({ ref: `d:${d.day}`, day: d.day, text: String(d.text || '') }))
    : eps.filter((e) => e.kind === 'diary').map((e) => ({ ref: `d:${localDay(e.at)}`, day: localDay(e.at), text: e.text }));
  return { week, from: week, to, eps, diaries, stats: weekStats(mem, week, life) };
}
/**
 * 周记验收（规则 5）。返回 { ok, entry } / { ok: false, retry, why }。
 * 坏 JSON、太短 → 不收、不重写；引用不够、编了标题 / 数字 → retry（打回重写一次）。cites 一个没给 → 规则替她挑这周的依据。
 */
export function checkWeekly(mat, raw) {
  const j = parseObj(raw);
  if (!j) return { ok: false, retry: false, why: '不是 JSON' };
  const headline = cleanSelf(j.headline, 30), text = cleanSelf(j.text, 300);
  const valid = new Map([...mat.eps.filter((e) => e.kind !== 'diary').map((e) => [e.id, e.text]), ...mat.diaries.map((d) => [d.ref, d.text])]);
  const given = Array.isArray(j.cites) ? [...new Set(j.cites.map(String))] : [];
  const cites = given.length ? given.filter((c) => valid.has(c)) : [...valid.keys()].slice(0, 5);
  if (cites.length < 3) return { ok: false, retry: true, why: `依据不够：要至少 3 个这周还记得的事的编号或日记（d:日期），有效的只有 ${cites.length} 个` };
  const corpus = [...mat.eps.map((e) => `${localDay(e.at)} ${e.text}`), ...mat.diaries.map((d) => `${d.day} ${d.text}`), mat.from, mat.to].join('\n'); // 日子也算（提示词里给过，写「11-08」不算编）
  const st = mat.stats;
  const bad = madeUp(`${headline}\n${text}`, corpus, new Set([st.seen, st.comments, st.replies, st.diaries]));
  if (bad) return { ok: false, retry: true, why: `${bad}，只写上面有的事` };
  if (!headline || text.length < 60) return { ok: false, retry: false, why: '太短' }; // 能打回重写的先查完，太短直接不收
  return { ok: true, entry: { week: mat.week, from: mat.from, to: mat.to, headline, text, stats: st, cites, floor: 0 } };
}
/** 章节的材料：这个月的周记、这个月的日记。 */
export function monthMaterial(mem, month, life) {
  return { month, weeklies: monthWeeklies(mem, month), diaries: lifeDiaries(life, `${month}-01`, monthEnd(month)).map((d) => ({ ref: `d:${d.day}`, day: d.day, text: String(d.text || '') })) };
}
/** 章节验收：至少 2 篇这个月的周记，或 5 篇这个月的日记；不够打回重写一次。章节只从验过的周记 / 日记写，不再查标题。 */
export function checkChapter(mat, raw) {
  const j = parseObj(raw);
  if (!j) return { ok: false, retry: false, why: '不是 JSON' };
  const title = cleanSelf(j.title, 12), headline = cleanSelf(j.headline, 30), text = cleanSelf(j.text, 400);
  if (!title || !headline || text.length < 60) return { ok: false, retry: false, why: '太短' };
  const ws = new Set(mat.weeklies.map((w) => w.id)), ds = new Set(mat.diaries.map((d) => d.ref));
  const given = Array.isArray(j.cites) ? [...new Set(j.cites.map(String))] : [];
  const cites = given.length ? given.filter((c) => ws.has(c) || ds.has(c)) : (ws.size >= 2 ? [...ws] : [...ds]);
  const nW = cites.filter((c) => ws.has(c)).length, nD = cites.filter((c) => ds.has(c)).length;
  if (nW < 2 && nD < 5) return { ok: false, retry: true, why: '依据不够：要至少 2 篇这个月的周记（W…），或 5 篇这个月的日记（d:日期）' };
  return { ok: true, entry: { month: mat.month, title, headline, text, cites } };
}

const statsWords = (st) => [`看了 ${st.seen} 个视频`, `在 B站留了 ${st.comments} 条言`, `收到 ${st.replies} 条回复`, `写了 ${st.diaries} 篇日记`, st.topTags.length ? `看得最多的：${st.topTags.join('、')}` : '', st.topPeople.length ? `打交道最多的：${st.topPeople.join('、')}` : ''].filter(Boolean).join('；');
const fixLine = (why) => (why ? `【上一稿没收下】${why}。照上面的规矩改好再写一遍。` : DROP);
/** 写周记的提示词（本体在 src/prompts/weekly.md）。 */
export function weeklyPrompt({ persona = '', call = '爸妈', mat, fix = '' }) {
  return dropLines(fill(PROMPTS.weekly, {
    persona: persona || DROP, call, from: mat.from, to: mat.to,
    stats: statsWords(mat.stats),
    episodes: mat.eps.filter((e) => e.kind !== 'diary').map((e) => `- [${e.id}] ${localDay(e.at)} ${e.text}`).join('\n') || '（没有）',
    diaries: mat.diaries.map((d) => `- [${d.ref}] ${clean(d.text, 120)}`).join('\n') || '（这周没写日记）',
    fix: fixLine(fix),
  }));
}
/** 写章节的提示词（本体在 src/prompts/chapter.md）。 */
export function chapterPrompt({ persona = '', call = '爸妈', mat, fix = '' }) {
  return dropLines(fill(PROMPTS.chapter, {
    persona: persona || DROP, call, month: mat.month,
    weeklies: mat.weeklies.map((w) => `- [${w.id}] ${w.from} 到 ${w.to}：${w.headline}。${w.text}`).join('\n') || '（这个月没有周记）',
    diaries: mat.diaries.map((d) => `- [${d.ref}] ${clean(d.text, 80)}`).join('\n') || '（没有）',
    fix: fixLine(fix),
  }));
}

/** 周记的阶段：半衰期 = 基准 × 6，阈值同经历，不会好过到过的最差阶段。 */
export function weeklyStage(w, now, baseDays = 30) {
  const age = Math.max(0, (now - ms(w.at)) / DAY);
  return STAGES[Math.max(w.floor || 0, stageOfR(Math.pow(0.5, age / (baseDays * WEEKLY_HL_MULT))))];
}
/** 周记慢慢模糊（改 mem）：模糊截到 80 字，只剩印象时正文 = headline，忘了就删。返回删了几篇。 */
export function settleWeeklies(mem, now, baseDays = 30) {
  let gone = 0; const out = [];
  for (const w of mem.weeklies || []) {
    const st = weeklyStage(w, now, baseDays), i = STAGES.indexOf(st);
    if (st === 'forgotten') { gone += 1; continue; }
    if (i > (w.floor || 0)) out.push({ ...w, floor: i, text: i >= 2 ? w.headline : String(w.text).slice(0, 80) });
    else out.push(w);
  }
  mem.weeklies = out;
  return gone;
}
/** 章节不忘；超了（到 24 章）把最早的两章按规则合并，不调模型。返回合并了几次。 */
export function mergeChapters(mem) {
  let n = 0;
  const chs = (mem.chapters || []).slice().sort((a, b) => String(a.month).localeCompare(String(b.month)) || String(a.at).localeCompare(String(b.at)));
  while (chs.length >= MAX_CHAPTERS) {
    const [a, b] = chs.splice(0, 2);
    const half = (t) => String(t || '').slice(0, Math.ceil(String(t || '').length / 2));
    chs.unshift({ id: a.id, month: a.month, toMonth: b.toMonth || b.month, title: `${a.title}、${b.title}`, headline: a.headline, text: `${half(a.text)}${half(b.text)}`, cites: [...new Set([...(a.cites || []), ...(b.cites || [])])], at: a.at, merged: true });
    n += 1;
  }
  if (n) mem.chapters = chs;
  return n;
}
/** 【这阵子】的两行：最近一篇还没忘的周记的 headline、最近一章的「title：headline」。 */
export function recentLines(mem, { now, baseDays = 30 } = {}) {
  const w = (mem.weeklies || []).filter((x) => !x.muted && weeklyStage(x, now, baseDays) !== 'forgotten').sort((a, b) => String(a.to).localeCompare(String(b.to))).at(-1); // muted：不进【这阵子】（四期-2 D）
  const c = (mem.chapters || []).slice().sort((a, b) => String(a.toMonth || a.month).localeCompare(String(b.toMonth || b.month))).at(-1);
  return [w ? w.headline : '', c ? `${c.title}：${c.headline}` : ''].filter(Boolean);
}
/** 召回路由：和这段日子重叠的章节（先）和周记（新的在前）。 */
function memoirFor(mem, tr, now, baseDays) {
  const out = [];
  const overlap = (f, t) => f < tr.to && t > tr.from;
  for (const c of (mem.chapters || []).slice().reverse()) {
    const [y, mo] = String(c.month).split('-').map(Number), [y2, mo2] = String(c.toMonth || c.month).split('-').map(Number);
    if (overlap(new Date(y, mo - 1, 1).getTime(), new Date(y2, mo2, 1).getTime())) out.push({ id: c.id, stage: 'clear', kind: 'chapter', at: c.at, text: `${c.title}：${c.headline}。${String(c.text).slice(0, 80)}` });
  }
  for (const w of (mem.weeklies || []).slice().sort((a, b) => String(b.from).localeCompare(String(a.from)))) {
    const st = weeklyStage(w, now, baseDays);
    if (st === 'forgotten' || !isYmd(w.from) || !isYmd(w.to)) continue;
    if (overlap(ymdMs(w.from), ymdMs(w.to) + DAY)) out.push({ id: w.id, stage: st, kind: 'weekly', at: w.at, text: `${w.headline}：${String(w.text).slice(0, 80)}` });
  }
  return out;
}
