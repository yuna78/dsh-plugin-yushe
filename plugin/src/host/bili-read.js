/**
 * 她的 B站（只读，M5a）：首页推荐、搜索、视频详情、热门评论、UP 主的新视频。
 * 用她自己的号（扫码凭证，本机 600 文件）；只请求固定的 api.bilibili.com 路径，不跟随重定向。
 *
 * WBI 签名（搜索 / 首页推荐 / UP 主投稿要）：nav 里拿 img_key + sub_key → 按固定换位表取 32 位 mixin_key →
 * 参数加 wts、按键排序、去掉 !'()*、encodeURIComponent 拼成 query → md5(query + mixin_key) = w_rid。
 * 算法照公开文档（bilibili-API-collect「WBI 签名」）（见 NOTICE）；这里是自己写的 JS。
 *
 * 风控（规矩 G3，08 工具明细 0.5 节）：每天读请求有预算（默认 300 次），另有每分钟 ≤ 6、每小时 ≤ 60 的窗口——
 * 分钟窗口满了就等一会儿再发（不报错），小时窗口满了报错；请求一发出就计数，失败也算。
 * 遇到 -352 / -412 / 412 / 429 这类风控码就退避：30 分钟起，6 小时内再碰翻倍，最长 8 小时；退避期间读和写（bili-write 问 blocked()）都停。
 *
 * 白名单：宿主自己用的路径（下面 PATHS / VC_PATHS）+ 工具表里声明的（createBiliRead 的 extraPaths，由 tools/registry.js 生成）。
 */
import { createHash } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowMs, nowDate } from './clock.js';

const API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const PATHS = new Set(['/x/web-interface/nav', '/x/web-interface/wbi/index/top/feed/rcmd', '/x/web-interface/wbi/search/type', '/x/web-interface/view', '/x/v2/reply/main', '/x/space/wbi/arc/search', '/x/web-interface/popular', '/x/msgfeed/unread', '/x/msgfeed/reply', '/x/msgfeed/like', '/x/relation/followers', '/x/relation/stat', '/x/relation']);
// 私信在另一个域名（任务 46）：会话列表、某个人最近的消息
const VC = 'https://api.vc.bilibili.com';
const VC_PATHS = new Set(['/session_svr/v1/session_svr/get_sessions', '/svr_sync/v1/svr_sync/fetch_session_msgs']);
export const DAILY_BUDGET = 300;
export const PER_MINUTE = 6;
export const PER_HOUR = 60;
const BACKOFF_BASE = 30 * 60_000, BACKOFF_MAX = 8 * 3600_000, STREAK_WINDOW = 6 * 3600_000;
const RISK_CODES = new Set([-352, -412, -401, -509, 412, 429]);

/** 公开文档的 WBI 签名（纯函数，verify 用文档里的例子校验）。 */
export function mixinKey(imgKey, subKey) { const k = imgKey + subKey; return MIXIN.map((i) => k[i]).join('').slice(0, 32); }
export function wbiSign(params, imgKey, subKey, wts = Math.floor(Date.now() / 1000)) {
  const d = { ...params, wts };
  const q = Object.keys(d).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(d[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return { query: q, w_rid: createHash('md5').update(q + mixinKey(imgKey, subKey)).digest('hex') };
}
const keyOf = (url) => String(url || '').split('/').pop().split('.')[0];
// 外面的标题里常带 emoji：进游戏前去掉（F-39 游戏里不放 emoji，连外部内容也一样）
export const stripEmoji = (s) => String(s ?? '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu, '');
export const clean = (s, n = 120) => stripEmoji(String(s ?? '').replace(/<[^>]+>/g, '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
// 收件箱里的链接只认 B站自己的（外部内容，别的域名一律不给链接）
export const safeBiliUrl = (u) => (/^https:\/\/([a-z0-9-]+\.)*bilibili\.com\/[^\s"'<>]*$/i.test(String(u || '')) ? String(u) : null);
export const isoOf = (sec) => (Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString() : null);
export const okBv = (b) => /^BV[0-9A-Za-z]{10}$/.test(String(b || ''));

/** 一条视频 → 统一的样子（工具和出门共用）。 */
export const vidOf = (v, extra = {}) => ({ title: clean(v.title), url: `https://www.bilibili.com/video/${v.bvid}`, bvid: v.bvid, aid: v.aid || v.id || null, up: clean(v.owner?.name || v.author, 30), mid: v.owner?.mid || v.mid || null, tname: clean(v.tname || v.typename, 12), play: v.stat?.view ?? v.play ?? 0, desc: clean(v.desc || v.description, 80), ...extra });
// 字幕文件在 B站自己的 CDN 上（播放器接口给的地址），只认这几个域名
const SUB_HOST = /^https:\/\/(aisubtitle|i0|i1|i2)\.hdslb\.com\/[\w/.\-?=&%]+$/;
/** 弹幕 xml 是 deflate 压过的（有时候 fetch 已经解好了）：依次试 raw deflate / zlib / 原文。 */
export function decodeMaybeDeflated(buf) {
  const b = Buffer.from(buf);
  for (const f of [inflateRawSync, inflateSync]) { try { return f(b).toString('utf8'); } catch { /* 试下一个 */ } }
  return b.toString('utf8');
}

export function createBiliRead(storage, fetchImpl = fetch, { extraPaths = null, budget = () => DAILY_BUDGET, perMinute = PER_MINUTE, perHour = PER_HOUR, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const isApi = (p) => PATHS.has(p) || Boolean(extraPaths?.api?.has(p));
  const isVc = (p) => VC_PATHS.has(p) || Boolean(extraPaths?.vc?.has(p));
  const credFile = join(storage, 'bili_credential.json');
  const stateFile = join(storage, 'bili-read.json');
  let wbi = null, wbiAt = 0;
  const state = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const saveState = (s) => { try { mkdirSync(storage, { recursive: true }); writeFileSync(stateFile, JSON.stringify(s)); } catch { /* 记账失败不影响 */ } };
  const today = () => nowDate().toISOString().slice(0, 10);
  const cookie = () => {
    if (!existsSync(credFile)) return '';
    try { const c = JSON.parse(readFileSync(credFile, 'utf8')); return c.sessdata ? `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct || ''}; DedeUserID=${c.dedeuserid || ''}; buvid3=${c.buvid3 || ''}` : ''; } catch { return ''; }
  };
  /** 今天还能不能读：预算 + 风控退避 + 小时窗口。 */
  const gate = () => {
    const s = state();
    if (s.backoffUntil && nowMs() < s.backoffUntil) return { ok: false, why: 'B站暂时不让读（风控），过一会儿再试' };
    const cap = Math.max(1, Number(budget()) || DAILY_BUDGET);
    if (s.day === today() && (s.count || 0) >= cap) return { ok: false, why: `今天 B站已经读了 ${cap} 次，歇歇眼睛` };
    if ((s.recent || []).filter((t) => nowMs() - t < 3600_000).length >= perHour) return { ok: false, why: `这一小时 B站已经读了 ${perHour} 次，慢一点` };
    return { ok: true };
  };
  /** 放行一次读：过 gate；分钟窗口满了就等到有空位（最多等一分钟）；放行时就计数（失败也算）。串行，免得并发绕过窗口。 */
  let queue = Promise.resolve();
  const admit = () => {
    const run = queue.then(async () => {
      let g = gate(); if (!g.ok) throw new Error(g.why);
      const inMinute = (state().recent || []).filter((t) => nowMs() - t < 60_000).sort((a, b) => a - b);
      if (inMinute.length >= perMinute) { await sleep(Math.max(0, 60_000 - (nowMs() - inMinute[inMinute.length - perMinute]))); g = gate(); if (!g.ok) throw new Error(g.why); }
      const s = state();
      saveState({ ...s, day: today(), count: (s.day === today() ? s.count || 0 : 0) + 1, recent: [...(s.recent || []).filter((t) => nowMs() - t < 3600_000), nowMs()] });
    });
    queue = run.catch(() => {});
    return run;
  };
  /** 碰到风控：退避，6 小时内连着碰就翻倍，最长 8 小时。 */
  const riskHit = (code) => {
    const s = state();
    const streak = s.lastRiskAt && nowMs() - s.lastRiskAt < STREAK_WINDOW ? (s.riskStreak || 1) + 1 : 1;
    const wait = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** (streak - 1));
    saveState({ ...s, backoffUntil: nowMs() + wait, lastRisk: code, lastRiskAt: nowMs(), riskStreak: streak });
    return wait;
  };
  /** WBI 签名后的 query（读接口和发私信都用）。 */
  async function signQuery(params) {
    if (!wbi || nowMs() - wbiAt > 3600_000) {
      const nav = await get('/x/web-interface/nav', {});
      wbi = { img: keyOf(nav?.wbi_img?.img_url), sub: keyOf(nav?.wbi_img?.sub_url) }; wbiAt = nowMs();
      if ((wbi.img + wbi.sub).length < 64) throw new Error('拿不到 WBI 签名钥匙');
    }
    const sg = wbiSign(params, wbi.img, wbi.sub);
    return `${sg.query}&w_rid=${sg.w_rid}`;
  }
  async function get(path, params = {}, { signed = false, as = 'json' } = {}) {
    const vc = isVc(path);
    if (!isApi(path) && !vc) throw new Error('不认识的 B站接口');
    let query;
    if (signed) query = await signQuery(params);
    else query = Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`).join('&');
    await admit();
    const headers = { 'User-Agent': UA, Referer: vc ? 'https://message.bilibili.com/' : 'https://www.bilibili.com/', Origin: vc ? 'https://message.bilibili.com' : 'https://www.bilibili.com', Accept: 'application/json' };
    const ck = cookie(); if (ck) headers.Cookie = ck;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 12_000);
    let res, j;
    try {
      res = await fetchImpl(`${vc ? VC : API}${path}${query ? `?${query}` : ''}`, { headers, redirect: 'manual', signal: ctl.signal });
      if (as === 'text') { // 弹幕这种返回 xml 的
        if (res.status === 412 || res.status === 429) { const wait = riskHit(res.status); throw new Error(`B站风控（${res.status}），先歇 ${Math.round(wait / 60_000)} 分钟`); }
        if (!res.ok && res.status) throw new Error(`B站返回 HTTP ${res.status}`);
        return decodeMaybeDeflated(await res.arrayBuffer());
      }
      j = await res.json().catch(() => ({}));
    } finally { clearTimeout(timer); }
    const code = j?.code ?? res?.status;
    if (RISK_CODES.has(code) || res?.status === 412 || res?.status === 429) { const wait = riskHit(code); throw new Error(`B站风控（${code}），先歇 ${Math.round(wait / 60_000)} 分钟`); }
    if (path === '/x/web-interface/nav' && j?.data?.wbi_img) return j.data; // 没登录时 nav 返回 -101，但签名钥匙照样给
    if (j?.code !== 0) throw new Error(`B站返回 ${j?.code}：${clean(j?.message, 60)}`);
    return j.data;
  }

  const vid = vidOf;

  const myMid = () => { try { const c = JSON.parse(readFileSync(credFile, 'utf8')); return /^\d{1,20}$/.test(String(c.dedeuserid || '')) ? String(c.dedeuserid) : null; } catch { return null; } };
  const MSG = { platform: 'web', build: 0, mobi_app: 'web' };

  return {
    loggedIn: () => Boolean(cookie()),
    /** 风控退避中：写操作也要停（bili-write 问这个）。 */
    blocked: () => { const s = state(); return Boolean(s.backoffUntil && nowMs() < s.backoffUntil); },
    /** 工具用的通用读：只认白名单（宿主的 + 工具表声明的），照样过预算 / 窗口 / 风控。返回 B站的 data。 */
    raw: (path, params = {}, { signed = false } = {}) => get(path, params, { signed }),
    /** 通用读，返回文本（弹幕 xml）。 */
    rawText: (path, params = {}) => get(path, params, { as: 'text' }),
    /** 字幕文件（播放器接口给的地址，只认 B站 CDN）：返回 [{from, to, content}]。照样占读次数。 */
    async subtitleFile(url) {
      const u = String(url || '').startsWith('//') ? `https:${url}` : String(url || '');
      if (!SUB_HOST.test(u)) throw new Error('字幕地址不是 B站的');
      await admit();
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 12_000);
      try {
        const res = await fetchImpl(u, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }, redirect: 'manual', signal: ctl.signal });
        const j = await res.json().catch(() => null);
        return (j?.body || []).map((x) => ({ from: Number(x.from) || 0, to: Number(x.to) || 0, content: clean(x.content, 200) })).filter((x) => x.content);
      } finally { clearTimeout(timer); }
    },
    myMid,
    signQuery,
    /** 她和某个人的关系：0 没关注、2 关注了、6 互关、128 拉黑。 */
    async relationTo(mid) { if (!/^\d{1,20}$/.test(String(mid))) throw new Error('UID 不对'); const d = await get('/x/relation', { fid: mid }); return Number(d?.attribute) || 0; },
    /** 私信会话列表（原样给 shared/dm.js 的 pendingTalkers 挑）。 */
    async dmSessions() { const d = await get('/session_svr/v1/session_svr/get_sessions', { session_type: 1, group_fold: 1, unfollow_fold: 0, sort_rule: 2, build: 0, mobi_app: 'web' }); return d?.session_list || []; },
    /** 和某个人最近的消息（原样给 newTexts 挑）。 */
    async dmMessages(mid, n = 20) { if (!/^\d{1,20}$/.test(String(mid))) throw new Error('UID 不对'); const d = await get('/svr_sync/v1/svr_sync/fetch_session_msgs', { talker_id: mid, session_type: 1, size: Math.min(30, n), build: 0, mobi_app: 'web' }); return d?.messages || []; },
    /** 收件箱未读数（回复 / 点赞 / @）。 */
    async unread() { const d = await get('/x/msgfeed/unread'); return { reply: Number(d?.reply) || 0, like: Number(d?.like) || 0, at: Number(d?.at) || 0 }; },
    /** 别人回她的（最近一页）。 */
    async repliesToMe(n = 20) {
      const d = await get('/x/msgfeed/reply', MSG);
      return (d?.items || []).slice(0, n).map((x) => ({ id: `r${x.id}`, who: clean(x.user?.nickname, 20) || '有人', text: clean(x.item?.source_content, 120), mine: clean(x.item?.target_reply_content || x.item?.root_reply_content || x.item?.title, 80), title: clean(x.item?.title, 60), url: safeBiliUrl(x.item?.uri), at: isoOf(x.reply_time) })).filter((x) => x.text);
    },
    /** 别人给她点的赞（累计那一页；同一条被多人赞是一条，count = 人数）。 */
    async likesToMe(n = 20) {
      const d = await get('/x/msgfeed/like', MSG);
      return (d?.total?.items || []).slice(0, n).map((x) => ({ id: `l${x.id}`, who: (x.users || []).slice(0, 2).map((u) => clean(u.nickname, 20)).filter(Boolean).join('、') || '有人', count: Number(x.counts) || (x.users || []).length || 1, mine: clean(x.item?.title || x.item?.desc, 80), url: safeBiliUrl(x.item?.uri), at: isoOf(x.like_time) }));
    },
    /** 她的粉丝（最新的一页）。 */
    async followers(n = 20) {
      const mid = myMid(); if (!mid) throw new Error('还没登录 B站');
      const d = await get('/x/relation/followers', { vmid: mid, ps: Math.min(50, n), pn: 1, order: 'desc' });
      return (d?.list || []).filter((x) => x?.mid).map((x) => ({ mid: String(x.mid), who: clean(x.uname, 20) || '有人', at: isoOf(x.mtime) }));
    },
    /** 粉丝数 / 关注数。 */
    async myStat() { const mid = myMid(); if (!mid) throw new Error('还没登录 B站'); const d = await get('/x/relation/stat', { vmid: mid }); return { follower: Number(d?.follower) || 0, following: Number(d?.following) || 0 }; },
    usage: () => { const s = state(); return { today: s.day === today() ? s.count || 0 : 0, budget: Math.max(1, Number(budget()) || DAILY_BUDGET), thisHour: (s.recent || []).filter((t) => nowMs() - t < 3600_000).length, perHour, backoffUntil: s.backoffUntil || 0 }; },
    /** 首页推荐（用她的号，越刷越像她）。 */
    async homeFeed(n = 10) {
      const d = await get('/x/web-interface/wbi/index/top/feed/rcmd', { fresh_type: 4, ps: Math.min(20, n + 4), fresh_idx: 1, fresh_idx_1h: 1, brush: 1 }, { signed: true });
      return (d?.item || []).filter((v) => v.goto === 'av' && okBv(v.bvid) && !v.business_info && !v.is_ad).slice(0, n).map((v) => vid(v));
    },
    /** 搜视频。 */
    async search(keyword, n = 8) {
      const kw = clean(keyword, 40); if (!kw) return [];
      const d = await get('/x/web-interface/wbi/search/type', { search_type: 'video', keyword: kw, page: 1 }, { signed: true });
      return (d?.result || []).filter((v) => okBv(v.bvid)).slice(0, n).map((v) => vid({ ...v, owner: { name: v.author, mid: v.mid }, tname: v.typename, stat: { view: v.play } }));
    },
    /** 视频详情。 */
    async videoInfo(bvid) {
      if (!okBv(bvid)) throw new Error('BV 号不对');
      const v = await get('/x/web-interface/view', { bvid });
      return vid(v, { duration: v.duration, pubdate: v.pubdate, like: v.stat?.like ?? 0, reply: v.stat?.reply ?? 0 });
    },
    /** 热门评论（前几条，只取文字和赞数）。 */
    async hotComments(aid, n = 5) {
      const d = await get('/x/v2/reply/main', { type: 1, oid: aid, mode: 3, next: 0 });
      return (d?.replies || []).slice(0, n).map((r) => ({ user: clean(r.member?.uname, 20), text: clean(r.content?.message, 140), like: r.like || 0 }));
    },
    /** UP 主最近的投稿。 */
    async upVideos(mid, n = 5) {
      if (!/^\d{1,20}$/.test(String(mid))) throw new Error('UP 主 id 不对');
      const d = await get('/x/space/wbi/arc/search', { mid, ps: Math.min(30, n), pn: 1, order: 'pubdate' }, { signed: true });
      return (d?.list?.vlist || []).filter((v) => okBv(v.bvid)).slice(0, n).map((v) => vid({ ...v, owner: { name: v.author, mid }, stat: { view: v.play } }));
    },
    /** 热门（不用登录）。 */
    async popular(n = 12) {
      const d = await get('/x/web-interface/popular', { ps: n, pn: 1 });
      return (d?.list || []).filter((v) => okBv(v.bvid)).slice(0, n).map((v) => vid(v));
    },
  };
}
