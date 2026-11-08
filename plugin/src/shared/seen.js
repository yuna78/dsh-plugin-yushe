/**
 * 见闻流水账（F-86 一期-1，docs/设计/14-见闻流水与聊天翻找.md）。纯函数，verify 直接测。
 *
 * 出门 / 梦游时工具给她看过的每一条都记一行（不只是游记里挑的几条），她按关键词 / 时间词 / 读多深去翻、能翻页。
 * 「读多深」从浅到深：list 刷到 → detail 点开 → deep 读了字幕 / 评论 / 弹幕 → acted 点赞收藏评论过 → noted 写进游记 / 便利贴。
 * 时间词直接复用 memory.js 的 timeRange / localDay，不重写；读账格式看 shared/evidence.js 的 ledger.dump()。
 */
import { timeRange, localDay } from './memory.js';

export const DEPTHS = ['list', 'detail', 'deep', 'acted', 'noted'];
export const DEPTH_TEXT = { list: '刷到', detail: '点开看了', deep: '读了字幕或评论', acted: '点赞收藏评论过', noted: '记进游记' };

const DAY = 86400e3;
const CLEAN = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const asMs = (x) => { const t = typeof x === 'number' && Number.isFinite(x) ? x : Date.parse(String(x ?? '')); return Number.isFinite(t) ? t : NaN; };
const rank = (d) => Math.max(0, DEPTHS.indexOf(d));

export const emptySeenLog = () => ({ v: 1, items: [] });

/** key（bvid 或普通链接）→ BV 号（不是视频就是 null）。 */
const bvOf = (k) => {
  const s = String(k ?? '');
  if (/^BV[0-9A-Za-z]{10}$/.test(s)) return s;
  return s.match(/BV[0-9A-Za-z]{10}/)?.[0] || null;
};

/** 游记 seen + 便利贴（noted）按 url 对一下 → { depth:'noted', why? } 或 null。 */
function notedHit(noted, url) {
  for (const n of noted || []) {
    const u = typeof n === 'string' ? n : n?.url;
    if (u !== url) continue;
    const why = typeof n === 'string' ? '' : CLEAN(n.why ?? n.line, 120);
    return { depth: 'noted', ...(why ? { why } : {}) };
  }
  return null;
}

/**
 * 这趟 catalog（Map）每条一行：{ at, title, url, source, tag, up, mid, depth, why? }。
 * ledger = 读账 dump（{ BV: [层] }）；acts = { BV: [工具名] }；noted = 游记 seen + 便利贴（按 url 对）。
 * 深度：noted > acted > deep（字幕 / 评论 / 弹幕）> detail（读了详情，或 catalog 的 via === 'detail'）> list。
 */
export function entriesFrom({ catalog = null, ledger = {}, acts = {}, noted = [], at } = {}) {
  // 宿主调用方都会带 at（这趟的时刻）；真缺就按现在，别把行弄丢
  const atIso = Number.isFinite(asMs(at)) ? (typeof at === 'number' ? new Date(asMs(at)).toISOString() : String(at)) : new Date().toISOString();
  const rows = [];
  for (const [key, c] of (catalog?.entries?.() || [])) {
    if (!c?.url || !c?.title) continue;
    const bv = bvOf(key) || bvOf(c.url);
    const L = bv ? ledger[bv] || [] : [];
    const hit = notedHit(noted, c.url);
    let depth;
    let why = '';
    if (hit) ({ depth, why } = hit);
    else if (bv && (acts?.[bv] || []).length) depth = 'acted';
    else if (L.some((l) => l === 'subtitle' || l === 'comments' || l === 'danmaku')) depth = 'deep';
    else if (L.includes('detail') || c.via === 'detail') depth = 'detail';
    else depth = 'list';
    rows.push({ at: atIso, title: CLEAN(c.title, 80), url: String(c.url), source: CLEAN(c.source, 20), tag: CLEAN(c.tag, 12), up: CLEAN(c.up, 30), mid: c.mid ? String(c.mid) : '', depth, ...(why ? { why } : {}) });
  }
  return rows;
}

/**
 * 合并成一本流水账（不进老账）：每行加 day（本机时区 YYYY-MM-DD）；同一天同一 url 只留一行、深度取最深、why 有就留；
 * 超过 keepDays 天的扔掉；某天超过 perDay 行，先丢最浅、再丢最早的。返回新的 log，不动传入的。
 */
export function mergeSeen(log, entries = [], { now = Date.now(), keepDays = 30, perDay = 800 } = {}) {
  const cut = now - keepDays * DAY;
  const map = new Map(); // `${day}|${url}` → 行
  for (const it of [...(log?.items || []), ...(Array.isArray(entries) ? entries : [])]) {
    const t = asMs(it?.at);
    if (!Number.isFinite(t) || t < cut) continue; // 没时间的行没法算日子；超过保留天数的扔掉
    const row = {
      at: it.at, title: it.title ?? '', url: String(it.url ?? ''), source: it.source ?? '', tag: it.tag ?? '',
      up: it.up ?? '', mid: it.mid ?? '', depth: DEPTHS.includes(it.depth) ? it.depth : 'list',
      day: localDay(t), ...(it.why ? { why: String(it.why).slice(0, 120) } : {}),
    };
    const old = map.get(`${row.day}|${row.url}`);
    if (!old) { map.set(`${row.day}|${row.url}`, row); continue; }
    const deeper = rank(row.depth) > rank(old.depth) || (rank(row.depth) === rank(old.depth) && asMs(row.at) > asMs(old.at));
    const why = row.why || old.why;
    map.set(`${row.day}|${row.url}`, { ...(deeper ? row : old), ...(why ? { why } : {}) });
  }
  const byDay = new Map();
  for (const row of map.values()) { const arr = byDay.get(row.day) || []; arr.push(row); byDay.set(row.day, arr); }
  const items = [];
  for (const arr of byDay.values()) {
    if (arr.length > perDay) { // 满了：最深的、最新的先留（丢的时候先丢最浅、再丢最早）
      arr.sort((a, b) => rank(b.depth) - rank(a.depth) || asMs(b.at) - asMs(a.at));
      arr.length = Math.max(1, Math.round(perDay));
    }
    items.push(...arr);
  }
  return { v: 1, items };
}

/** 泛泛的词不当筛选条件（问「看了什么」别把全账筛光）；纯助词也顺手滤掉。 */
export const GENERIC_WORDS = new Set([
  '视频', '新闻', '文章', '动态', '内容', '东西', '什么', '啥', '事情', '几个', '一些', '很多', '好多', '有点', '大概', '好像', '可能',
  '看了', '看到', '看看', '看到过', '刷到', '刷过', '刷刷', '逛了', '逛逛', '浏览', '打开', '点开', '找找', '搜搜', '讲讲', '说说', '聊聊',
  '的', '了', '吧', '呢', '吗', '啊', '呀', '哦', '嘛', '还', '又', '都', '也', '再', '就', '挺', '给', '让', '有', '在',
]);

const GENERIC_MULTI = [...GENERIC_WORDS].filter((w) => w.length >= 2).sort((x, y) => y.length - x.length);
/** 连写的词里去掉两字以上的泛泛词（单字助词不动，免得把「有趣」拆坏）；剩不到 1 个字就当没有。 */
function stripGeneric(w) {
  if (w.length <= 2) return w;
  let out = w;
  for (const g of GENERIC_MULTI) out = out.split(g).join(' ');
  const parts = out.split(/\s+/).filter((x) => x && !GENERIC_WORDS.has(x));
  return parts.length ? parts.sort((x, y) => y.length - x.length)[0] : '';
}

/** 按空白 / 标点切词；时间词交给 timeRange，剩下的只留过滤后的实词。 */
function wordsOf(query, now) {
  const tr = timeRange(query, now);
  const rest = tr ? tr.rest : String(query ?? '');
  const words = String(rest).split(/[\s,，。.;；:：、!！?？|/~～"'`()（）[\]【】《》]+/)
    .map((w) => w.trim().toLowerCase()).filter((w) => w && !GENERIC_WORDS.has(w))
    .map((w) => stripGeneric(w)).filter(Boolean); // 「猫咪视频」这种连写的：去掉里面泛泛的词，只拿「猫咪」去找
  return { tr, words };
}

const hayOf = (x) => [x?.title, x?.up, x?.tag, x?.source].map((s) => String(s ?? '').toLowerCase()).join(' ');
const msOf = (x) => asMs(x?.at);
const inRange = (tr) => (x) => { const t = msOf(x); return Number.isFinite(t) && t >= tr.from && t < tr.to; };

/** 按关键词 / 深度 / 时间筛好、排好（不动账）。 */
function picksSeen(log, { query = '', minDepth = null, now } = {}) {
  const { tr, words } = wordsOf(query, now);
  const min = DEPTHS.includes(minDepth) ? rank(minDepth) : -1;
  const out = [];
  for (const x of log?.items || []) {
    if (tr && !inRange(tr)(x)) continue;
    if (rank(x.depth) < min) continue;
    if (words.length && !words.some((w) => hayOf(x).includes(w))) continue;
    out.push({ x, hits: words.filter((w) => hayOf(x).includes(w)).length });
  }
  out.sort((a, b) => (words.length ? b.hits - a.hits : 0) || rank(b.x.depth) - rank(a.x.depth) || msOf(b.x) - msOf(a.x));
  return out.map(({ x }) => ({ ...x, depthText: DEPTH_TEXT[x.depth] || DEPTH_TEXT.list }));
}

/** 每 5 个算一组最多谁。 */
const top5 = (m) => [...m.entries()].filter(([v]) => v).sort((a, b) => b[1] - a[1]).slice(0, 5);

/**
 * 翻。query 里的时间词（复用 memory.js 的 timeRange）只在那几天里找，剩下按空白 / 标点切词；
 * 有关键词：只留命中的，命中多的在前、深度深的在前、时间新的在前；没有关键词：深度、时间。能翻页，每页最多 50。
 */
export function querySeen(log, { query = '', minDepth = null, offset = 0, limit = 20, now } = {}) {
  const ranked = picksSeen(log, { query, minDepth: DEPTHS.includes(minDepth) ? minDepth : null, now });
  const total = ranked.length;
  const o = Math.max(0, Math.round(Number(offset) || 0));
  const page = Math.max(1, Math.min(50, Math.round(Number(limit) || 20)));
  const items = ranked.slice(o, o + page);
  return { total, offset: o, more: o + items.length < total, items };
}

/** 统计（今天 / 关键词筛同上）：多少条、各深度多少、最多的分区 / UP 主（各最多 5 个）。 */
export function seenStats(log, { query = '', now } = {}) {
  const ranked = picksSeen(log, { query, now });
  const byDepth = { list: 0, detail: 0, deep: 0, acted: 0, noted: 0 };
  const tags = new Map(), ups = new Map();
  for (const x of ranked) {
    if (!DEPTHS.includes(x.depth)) continue;
    byDepth[x.depth] = (byDepth[x.depth] || 0) + 1;
    if (x.tag) tags.set(x.tag, (tags.get(x.tag) || 0) + 1);
    if (x.up) ups.set(x.up, (ups.get(x.up) || 0) + 1);
  }
  return { total: ranked.length, byDepth, topTags: top5(tags).map(([tag, n]) => ({ tag, n })), topUps: top5(ups).map(([up, n]) => ({ up, n })) };
}

/** 今天的概览（一小段文字，提示词用）：几个数 + 读得最深的 max 条标题（带 UP）。≤500 字；今天没有就空串。 */
export function seenOverview(log, { now, max = 5 } = {}) {
  const tr = timeRange('今天', now);
  const today = (log?.items || []).filter(inRange(tr));
  if (!today.length) return '';
  const n = (d) => today.filter((x) => x.depth === d).length;
  const deepest = today.slice().sort((a, b) => rank(b.depth) - rank(a.depth) || msOf(b) - msOf(a));
  const lines = deepest.slice(0, Math.max(0, Math.round(Number(max) || 5)))
    .map((x) => `《${CLEAN(x.title, 60)}》${x.up ? ` ${CLEAN(x.up, 20)}` : ''}`).join('');
  const head = `今天刷到了 ${today.length} 条：点开 ${n('detail')} 条，${n('deep')} 条读到了字幕 / 评论，${n('acted')} 条互动过（点赞/收藏/评论），${n('noted')} 条记进了游记`;
  const out = `${head}${lines ? `。看得最深的：${lines}` : '。'}`;
  return out.length <= 500 ? out : `${out.slice(0, 499)}…`;
}
