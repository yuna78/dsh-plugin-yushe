/**
 * 记忆（F-76，docs/设计/09-记忆.md）。纯函数，规则算：记得什么、忘到哪一步、召回哪几条；模型只管说。
 *
 *   经历 episode：从档案抄来，按重要性 × 记性档位定半衰期，清晰 → 模糊 → 印象 → 忘了；擦细节是一次性的（floor）。
 *   认人 person：B站上打过交道的人，越熟忘得越慢；爸妈不忘。
 *   召回 recall：本地切词打分，按范围（家里 / B站）过滤，条数和字数预算。
 */
const DAY = 86400e3;
export const STAGES = ['clear', 'fuzzy', 'trace', 'forgotten'];
export const STAGE_TEXT = { clear: '清晰', fuzzy: '模糊', trace: '印象', forgotten: '忘了' };
export const MAX_EPISODES = 400;
export const MAX_PEOPLE = 120;
const IMP_MULT = [0.15, 0.3, 0.6, 1, 1.8, 4];
const REINFORCE_MAX = 5;

/** 种类 → 重要性 + 范围（规则定，不让模型打分）。 */
export const KINDS = {
  born: { imp: 5, scope: 'home' },
  'dm-parent': { imp: 4, scope: 'home' },
  'got-reply': { imp: 4, scope: 'public' },
  mood: { imp: 3, scope: 'home' },
  diary: { imp: 3, scope: 'home' },
  postcard: { imp: 3, scope: 'public' },
  comment: { imp: 3, scope: 'public' },
  reply: { imp: 3, scope: 'public' },
  post: { imp: 3, scope: 'public' },
  dyncomment: { imp: 3, scope: 'public' },
  dm: { imp: 3, scope: 'public' },
  follow: { imp: 3, scope: 'public' },
  'got-follow': { imp: 3, scope: 'public' },
  'dm-in': { imp: 3, scope: 'public' },
  seen: { imp: 2, scope: 'public' },
  'got-like': { imp: 2, scope: 'public' },
  nap: { imp: 2, scope: 'home' },
  'late-work': { imp: 2, scope: 'home' },
  chat: { imp: 1, scope: 'home' },
  feed: { imp: 1, scope: 'home' },
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

export const emptyMemory = () => ({ version: 1, episodes: [], people: {}, beliefs: [], cursors: {}, seq: 0 });

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

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
    case 'seen': return e.keys?.bvid ? `在 B站看过一个${tag}视频` : `看过一条${tag}新闻`;
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
/** 阶段：按留存算，但不会好过到过的最差阶段（floor）。 */
export function stageOf(ep, now, baseDays = 30) {
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

/** 推进遗忘：擦细节、删掉忘了的、超出上限丢留存最低的。返回 { mem, forgot, faded }。 */
export function settleMemory(mem, now, baseDays = 30) {
  let forgot = 0, faded = 0;
  const eps = [];
  for (const ep of mem.episodes || []) {
    const st = stageOf(ep, now, baseDays);
    if (st === 'forgotten') { forgot += 1; continue; }
    const d = degrade(ep, st);
    if (d !== ep) faded += 1;
    eps.push(d);
  }
  if (eps.length > MAX_EPISODES) {
    const keep = new Set(eps.map((e) => [e, retention(e, now, baseDays)]).sort((a, b) => b[1] - a[1]).slice(0, MAX_EPISODES).map(([e]) => e.id));
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
const STOP = new Set(['本鱼', '爸妈', '妈妈', '爸爸', '一个', '什么', '这个', '那个', '我们', '你们', '他们', '没有', '就是', '还是', '可以', '今天']);

/** 说出来的样子（跟阶段走）。 */
export function phrase(ep, stage) {
  const when = clean(ep.at, 10);
  if (stage === 'clear') return `${when} ${ep.text}${ep.url ? `（${ep.url}）` : ''}`;
  if (stage === 'fuzzy') return `好像是前阵子，${ep.text}`;
  return `隐约记得${ep.text}`;
}

/**
 * 召回。scope = 'public'（对外说话）只给 B站范围；'all' 都给。
 * 返回 [{ id, stage, kind, at, text, url? }]（text 已按阶段说好）。
 */
export function recall(mem, { query = '', scope = 'all', limit = 5, chars = 600, now, baseDays = 30, kinds = null } = {}) {
  const q = [...tokens(query)].filter((w) => !STOP.has(w));
  const ids = String(query).match(/BV[0-9A-Za-z]{10}|\d{5,}/g) || [];
  const cands = [];
  for (const ep of mem.episodes || []) {
    if (scope === 'public' && ep.scope !== 'public') continue;
    if (kinds && !kinds.includes(ep.kind)) continue;
    const st = stageOf(ep, now, baseDays);
    if (st === 'forgotten') continue;
    const r = retention(ep, now, baseDays);
    let score;
    if (q.length || ids.length) {
      const hay = tokens(`${ep.text} ${ep.gist} ${ep.keys?.tag || ''} ${ep.keys?.who || ''}`);
      let hit = 0; for (const w of q) if (hay.has(w)) hit += 1;
      let rel = q.length ? hit / Math.sqrt(q.length * Math.max(4, hay.size) / 4) : 0;
      if (ids.some((x) => x === ep.keys?.bvid || x === ep.keys?.mid)) rel += 1;
      if (rel <= 0) continue;
      score = 0.6 * Math.min(1.5, rel) + 0.25 * r + 0.15 * ep.imp / 5;
    } else {
      const fresh = Math.pow(0.5, Math.max(0, (now - ms(ep.at)) / DAY) / 3);
      score = 0.5 * r + 0.3 * ep.imp / 5 + 0.2 * fresh;
    }
    cands.push({ ep, st, score });
  }
  cands.sort((a, b) => b.score - a.score);
  const out = []; let used = 0; const seenText = new Set();
  for (const { ep, st } of cands) {
    if (out.length >= limit) break;
    const text = phrase(ep, st);
    if (seenText.has(ep.text)) continue;
    if (used + text.length > chars && out.length) break;
    seenText.add(ep.text); used += text.length;
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

/** 给模型的一段「你记得的事」。 */
export function memoryText(items, people = [], { title = '【你记得的事】', tail = '', beliefs = [] } = {}) {
  if (!items.length && !people.length && !beliefs.length) return '';
  const lines = [];
  if (beliefs.length) lines.push('【你对自己的认识】（睡前反思攒下的）', ...beliefs.map((b) => `- ${b.text}`));
  if (items.length || people.length) lines.push(title);
  for (const it of items) lines.push(`- ${it.text}`);
  if (people.length) lines.push(`B站上你认识的人：${people.map((p) => `${p.who}（${p.tier}${p.fuzzy ? '，有点记不清' : ''}）`).join('、')}`);
  lines.push(tail || '这些是你自己的记忆，模糊的就说得含糊些，别编细节；没想起来的事就是忘了。');
  return lines.join('\n');
}

/** 统计（给页面）。 */
export function memoryStats(mem, { now, baseDays = 30 } = {}) {
  const by = { clear: 0, fuzzy: 0, trace: 0 };
  for (const ep of mem.episodes || []) { const st = stageOf(ep, now, baseDays); if (by[st] !== undefined) by[st] += 1; }
  return { ...by, people: Object.keys(mem.people || {}).length, beliefs: (mem.beliefs || []).length };
}

/* ---------- 长期认识（F-76 第二步）：睡前反思，AI 摘、规则验引用 ---------- */
export const MAX_BELIEFS = 30;
export const BELIEF_ABOUT = ['自己', '喜好', '人', '爸妈'];
const REFLECT_SKIP = new Set(['feed', 'news', 'like', 'comment_like', 'collect', 'got-like']);

/** 反思的素材：还没忘的经历（最近 + 重要的），最多 n 条。用的是已经擦过细节的样子，忘掉的不会回来。 */
export function reflectCandidates(mem, { now, baseDays = 30, n = 30 } = {}) {
  const live = (mem.episodes || []).filter((e) => !REFLECT_SKIP.has(e.kind) && stageOf(e, now, baseDays) !== 'forgotten');
  const recent = live.filter((e) => now - ms(e.at) < 7 * DAY).slice(-20);
  const important = live.filter((e) => !recent.includes(e)).sort((a, b) => (b.imp - a.imp) || (ms(b.at) - ms(a.at))).slice(0, n - recent.length);
  return [...important, ...recent].sort((a, b) => ms(a.at) - ms(b.at)).slice(-n);
}

/** 反思提示词（只给她自己的人设和还记得的事）。 */
export function reflectPrompt({ persona = '', call = '爸妈', episodes = [], beliefs = [] }) {
  return [persona, '',
    `【睡前想一想】日记写完了。回头看看最近还记得的事，想想有没有让你对自己、对喜欢的东西、对 B站上认识的人、对${call}多了一点认识。`,
    '【还记得的事】（编号在方括号里；模糊的事就只记得这么多）',
    ...episodes.map((e) => `- [${e.id}] ${clean(e.at, 10)} ${e.text}`), '',
    beliefs.length ? '【你已经有的认识】' : '', ...beliefs.map((b) => `- [${b.id}] ${b.text}`), '',
    '规矩：',
    '- 只能从上面的事里想，不编没发生的事；普通寒暄、一次性的小事不用总结。',
    '- 每条认识写出依据：from 填事情编号，至少两件（很重要的一件事也可以只填一件）。',
    `- 每条不超过 30 字，用「我」来说；about 只能是 ${BELIEF_ABOUT.join(' / ')}。`,
    '- 和已有的认识意思一样就别再写；某条旧认识明显不对了，可以把它的编号放进 drop（最多 2 条）。',
    '- 最多 3 条新认识；没有新认识就给空数组。',
    '只输出 JSON，不要别的字：{"add":[{"text":"…","about":"喜好","from":["M1a","M3"]}],"drop":[]}',
  ].filter((x) => x !== '').join('\n');
}

const sim = (a, b) => { const x = tokens(a), y = tokens(b); if (!x.size || !y.size) return 0; let n = 0; for (const w of x) if (y.has(w)) n += 1; return n / Math.min(x.size, y.size); };

/**
 * 规则验模型的反思，并进长期认识。返回 { added, merged, dropped, rejected: [{text, why}] }（改 mem）。
 * 依据必须是此刻还没忘的经历；家里的经历做依据 → 这条认识也算家里的（对外不说）。
 */
export function applyReflection(mem, raw, { now, baseDays = 30, at } = {}) {
  let j = null;
  try { const s = String(raw || ''); const m = s.match(/\{[\s\S]*\}/); j = JSON.parse(m ? m[0] : s); } catch { j = null; }
  const out = { added: [], merged: [], dropped: [], rejected: [], parsed: Boolean(j) };
  if (!j) return out;
  mem.beliefs = Array.isArray(mem.beliefs) ? mem.beliefs : [];
  const byId = new Map((mem.episodes || []).map((e) => [e.id, e]));
  for (const id of (Array.isArray(j.drop) ? j.drop : []).slice(0, 2)) {
    const i = mem.beliefs.findIndex((b) => b.id === String(id));
    if (i >= 0) out.dropped.push(mem.beliefs.splice(i, 1)[0].text);
  }
  for (const a of (Array.isArray(j.add) ? j.add : []).slice(0, 3)) {
    const text = clean(a?.text, 40).replace(/https?:\/\/\S+|BV[0-9A-Za-z]{10}|\d{5,}/g, '').trim();
    if (text.length < 4) { out.rejected.push({ text, why: '太短' }); continue; }
    const cites = [...new Set((Array.isArray(a?.from) ? a.from : []).map(String))].map((id) => byId.get(id)).filter((e) => e && stageOf(e, now, baseDays) !== 'forgotten');
    if (!(cites.length >= 2 || (cites.length === 1 && cites[0].imp >= 4))) { out.rejected.push({ text, why: '依据不够（要两件还记得的事，或一件很重要的事）' }); continue; }
    const scope = cites.some((e) => e.scope === 'home') ? 'home' : 'public';
    const same = mem.beliefs.find((b) => sim(b.text, text) >= 0.6);
    if (same) { same.n = (same.n || 1) + 1; same.lastAt = at; same.from = [...new Set([...(same.from || []), ...cites.map((e) => e.id)])].slice(-8); if (scope === 'home') same.scope = 'home'; out.merged.push(same.text); continue; }
    mem.seq = (mem.seq || 0) + 1;
    const b = { id: `B${mem.seq.toString(36)}`, text, about: BELIEF_ABOUT.includes(a?.about) ? a.about : '自己', scope, from: cites.map((e) => e.id), at, lastAt: at, n: 1 };
    mem.beliefs.push(b); out.added.push(b.text);
  }
  if (mem.beliefs.length > MAX_BELIEFS) {
    const score = (b) => (b.n || 1) * 10 + ms(b.lastAt) / DAY / 30; // 想到次数多的、最近想到的留下
    mem.beliefs = mem.beliefs.sort((x, y) => score(y) - score(x)).slice(0, MAX_BELIEFS);
  }
  return out;
}

/** 给模型看的认识（按范围过滤）：想到次数多的在前。 */
export function beliefsFor(mem, { scope = 'all', limit = 5 } = {}) {
  return (mem.beliefs || []).filter((b) => scope !== 'public' || b.scope === 'public')
    .slice().sort((a, b) => ((b.n || 1) - (a.n || 1)) || (ms(b.lastAt) - ms(a.lastAt))).slice(0, limit);
}
