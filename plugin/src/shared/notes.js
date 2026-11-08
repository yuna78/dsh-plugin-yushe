/**
 * 笔记本（F-82，docs/设计/13-笔记本.md）：只做验收，不替她想。纯函数，verify 直接测。
 *
 * 她在游记里写便利贴（讲了啥 / 标签 / 一句话）和对点进去过的东西的态度；怎么写在 prompts/trip-report.md。
 * 这里只管结果：
 *   - 链接只认这趟真看过的（parseReport 已经挡过一次）
 *   - 「讲了啥」不能比读到的那层深：只扫过标题 → 清空；没读字幕却说「视频里说」→ 清空（G2 同一条正则）
 *   - 标签只能是五种之一；一句话为空不贴；一趟最多几张；7 天内贴过的链接不再贴
 *   - 读过清单：点进去过的每条都记（读到哪层、做了什么、喜不喜欢）；只在列表里扫过的只记个数
 *   - 态度只认点进去过的；没表态的按她做了什么填，不替她编「不喜欢」
 */
import { CLAIM } from './evidence.js';

export const NOTE_TAGS = ['学到的', '感悟', '好点子', '心得', '踩雷'];
export const LIKES = ['喜欢', '一般', '不喜欢'];
export const DEPTH_NAMES = { title: '只扫了一眼标题', summary: '看了摘要', detail: '点进去了', comments: '看了评论', subtitle: '看了字幕' };
const DEEP = new Set(['detail', 'comments', 'danmaku', 'subtitle']);
const ACT_NAMES = { bili_like: '点赞', bili_collect: '收藏', bili_comment: '评论', bili_reply: '回复' };
export const NOTE_DEDUPE_DAYS = 7;

const CLEAN = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>`]/g, ' ').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const BV = (u) => String(u || '').match(/BV[0-9A-Za-z]{10}/)?.[0] || null;

/**
 * 这一条读到了哪一层。ledger = 读账 dump（{ BV: [层] }）；没有读账（老路）→ null（不知道）。
 * 视频：字幕 > 评论 / 弹幕 > 详情 > 只扫过标题；新闻：有摘要 → summary，否则 title。
 */
export function depthOf(item, ledger, catalog = null) {
  if (!ledger) return null;
  const bv = BV(item?.url);
  if (bv) {
    const L = new Set(ledger[bv] || []);
    return L.has('subtitle') ? 'subtitle' : L.has('comments') || L.has('danmaku') ? 'comments' : L.has('detail') ? 'detail' : 'title';
  }
  const c = catalog?.get?.(item?.url) || [...(catalog?.values?.() || [])].find((x) => x.url === item?.url);
  return (c?.summary || item?.summary) ? 'summary' : 'title';
}

/** 最近 days 天贴过便利贴的链接（防止每天刷到同一个热门就贴一张）。 */
export function recentNoteUrls(journal = [], now = Date.now(), days = NOTE_DEDUPE_DAYS) {
  const from = now - days * 86400e3, out = new Set();
  for (const j of journal) if (j?.note && Date.parse(j.at) >= from) for (const x of j.seen || []) if (x?.url) out.add(x.url);
  return out;
}

/**
 * 她写的便利贴 → 验收过的便利贴。seen = parseReport 的 seen（已核实链接，带 gist / label / line / why；tag 是分区）。
 * 返回 [{ title, url, source, tag（分区）, up, mid, verified, line, note: { tag（她选的标签）, gist, depth } }]，按她写的顺序，最多 cap 张。
 */
export function acceptNotes({ seen = [], ledger = null, catalog = null, cap = 6, recent = new Set() } = {}) {
  const out = [], urls = new Set();
  for (const x of seen) {
    if (out.length >= cap) break;
    if (!x?.url || urls.has(x.url) || recent.has(x.url)) continue;
    const line = CLEAN(x.line || x.why, 60);
    if (!line) continue;
    const depth = depthOf(x, ledger, catalog);
    let gist = CLEAN(x.gist, 100);
    if (depth === 'title') gist = '';
    if (gist && CLAIM.test(gist) && depth !== 'subtitle') gist = ''; // G2：没读字幕不能说「视频里说 / 看完了」
    const label = NOTE_TAGS.includes(x.label) ? x.label : '心得';
    urls.add(x.url);
    out.push({ title: x.title, url: x.url, source: x.source, tag: x.tag, up: x.up, mid: x.mid, verified: true, line, note: { tag: label, gist, depth } }); // tag 是分区（小东西 / 爱好 / 记忆在用），她选的标签在 note.tag
  }
  return out;
}

/**
 * 读过清单：点进去过（读账里有详情 / 评论 / 弹幕 / 字幕）的每条视频都记一行；只在列表里扫过的只记个数。
 * catalog：这趟工具给过的所有条目（Map）；acts：{ BV: [工具名] }；verdict：她写的态度（parseReport 收的，未验收）。
 */
export function readList({ catalog = new Map(), ledger = {}, acts = {}, verdict = [], max = 20 } = {}) {
  const said = new Map();
  for (const v of verdict || []) {
    const bv = BV(v?.bvid || v?.ref || v?.url);
    if (bv && LIKES.includes(v.like) && !said.has(bv)) said.set(bv, { like: v.like, why: CLEAN(v.why, 30) });
  }
  const read = [];
  for (const [bv, layers] of Object.entries(ledger || {})) {
    if (!layers.some((l) => DEEP.has(l))) continue;
    const c = catalog.get(bv) || [...catalog.values()].find((x) => BV(x.url) === bv);
    if (!c) continue;
    const did = [...new Set((acts[bv] || []).map((t) => ACT_NAMES[t]).filter(Boolean))];
    const v = said.get(bv);
    read.push({ title: c.title, url: c.url, up: c.up || undefined, tag: c.tag || undefined, depth: depthOf(c, ledger), acts: did, like: v ? v.like : did.length ? '喜欢' : '没说', why: v?.why || '', ...(!v && did.length ? { inferred: true } : {}) }); // inferred：她没开口，是按她点赞收藏推的（页面写「看样子喜欢」）
    if (read.length >= max) break;
  }
  return { scanned: catalog.size, read };
}

/** 这趟她不喜欢的（态度「不喜欢」或「踩雷」便利贴）→ [{ tag, up }]，同一个链接只算一次。 */
export function dislikedFrom({ read = [], notes = [] } = {}) {
  const seen = new Set(), out = [];
  const add = (x) => { if (!x?.url || seen.has(x.url)) return; seen.add(x.url); if (x.tag || x.up) out.push({ tag: x.tag || null, up: x.up || null }); };
  for (const r of read) if (r.like === '不喜欢') add(r);
  for (const n of notes) if (n.note?.tag === '踩雷') add(n);
  return out;
}

/**
 * 页面 / recall 用：一条 journal 是哪种。F-84：只有她真写的（有 note）才是便利贴；
 * 回家那页是「这一趟」；以前的见闻（只有链接 / 占位话）是「见闻」，不冒充「心得」。
 */
export function noteKind(j) {
  if (!j) return null;
  if (j.dream) return '梦';
  if (j.final) return '这一趟';
  return j.note?.tag && NOTE_TAGS.includes(j.note.tag) ? j.note.tag : '见闻';
}

/** 以前的见闻里那种占位话（「在B站看到的」「11-06 挑了 10 条值得看的…」）不是她的话，页面不当心得显示。 */
export const isFiller = (t) => !t || /^在.{0,12}看到的$/.test(String(t).trim()) || /挑了 ?\d+ ?条值得看的/.test(String(t));
