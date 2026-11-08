// 读 B站工具共用的小东西（不是工具，gen-tools 不扫这个文件）。
import { clean, okBv, isoOf, vidOf, safeBiliUrl } from '../bili-read.js';

export { clean, okBv, isoOf, vidOf, safeBiliUrl };
export const NOT_READY = { ok: false, error: 'B站读取没开' };
export const NOT_LOGGED_IN = { ok: false, error: '她还没有自己的 B站号：在鱼社右上角「设置」里扫码登录' };
export const limitOf = (v, def = 5, max = 10) => Math.max(1, Math.min(max, Math.round(Number(v) || def)));
export const okMid = (m) => /^\d{1,20}$/.test(String(m || ''));

/** 读之前的检查：biliRead 在不在、要不要登录。返回错误对象或 null。 */
export function readyFor(biliRead, { login = true } = {}) {
  if (!biliRead) return NOT_READY;
  if (login && !biliRead.loggedIn()) return NOT_LOGGED_IN;
  return null;
}

/** 视频详情（原始 data），拿 aid / cid / 分 P。 */
export async function viewOf(biliRead, bvid) {
  if (!okBv(bvid)) throw new Error('BV 号不对');
  return biliRead.raw('/x/web-interface/view', { bvid });
}
export const cidOf = (view, page = 1) => (view?.pages?.[Math.max(0, (Number(page) || 1) - 1)]?.cid) || view?.cid || null;

/** 读多深的开关（细配置）：出门时按爸妈定的来；主会话是爸妈当面要，照办（字数上限照样管）。 */
export function depthAllows(habits, key, from) {
  if (from !== 'trip') return true;
  const h = habits?.get?.();
  return h ? h[key] !== false : true;
}

/** 一条评论 → 统一的样子。 */
export const replyOf = (r) => ({ rpid: String(r.rpid_str || r.rpid || ''), user: clean(r.member?.uname, 20), text: clean(r.content?.message, 160), like: r.like || 0, replies: r.rcount || r.count || 0, at: isoOf(r.ctime) });

/** 一条动态 → 统一的样子（关注动态、动态详情共用）。 */
export function dynOf(it) {
  const m = it?.modules || {};
  const arc = m.module_dynamic?.major?.archive;
  return {
    id: String(it?.id_str || ''), type: String(it?.type || '').replace('DYNAMIC_TYPE_', '').toLowerCase(),
    who: clean(m.module_author?.name, 20), mid: m.module_author?.mid ? String(m.module_author.mid) : null, at: isoOf(m.module_author?.pub_ts),
    text: clean(m.module_dynamic?.desc?.text || m.module_dynamic?.major?.opus?.summary?.text, 200),
    video: arc && okBv(arc.bvid) ? { bvid: arc.bvid, title: clean(arc.title), url: `https://www.bilibili.com/video/${arc.bvid}` } : null,
    url: it?.id_str ? `https://t.bilibili.com/${it.id_str}` : null,
    stat: { comment: m.module_stat?.comment?.count || 0, like: m.module_stat?.like?.count || 0, forward: m.module_stat?.forward?.count || 0 },
    comment: it?.basic?.comment_id_str ? { type: Number(it.basic.comment_type) || 0, oid: String(it.basic.comment_id_str) } : null,
  };
}

/** B站的主分区（排行榜用的 rid）。 */
export const ZONES = [
  ['全站', 0], ['动画', 1], ['音乐', 3], ['舞蹈', 129], ['游戏', 4], ['知识', 36], ['科技', 188], ['运动', 234], ['汽车', 223],
  ['生活', 160], ['美食', 211], ['动物圈', 217], ['鬼畜', 119], ['时尚', 155], ['娱乐', 5], ['影视', 181], ['纪录片', 177], ['电影', 23], ['电视剧', 11], ['国创', 168],
];
export function zoneRid(z) {
  if (z === undefined || z === null || z === '') return 0;
  const byName = ZONES.find(([n]) => n === String(z).trim());
  if (byName) return byName[1];
  const n = Number(z);
  return ZONES.some(([, r]) => r === n) ? n : null;
}

/** 互动工具共用：写之前的检查（能读能写、登录了、账本在）。 */
export function writeReadyFor({ biliRead, biliWrite, acts }) {
  if (!biliRead || !biliWrite || !acts) return { ok: false, error: 'B站互动没开' };
  if (!biliWrite.ready() || !biliRead.loggedIn()) return NOT_LOGGED_IN;
  if (biliRead.blocked?.()) return { ok: false, error: 'B站正在风控，先不动' };
  return null;
}
/** G1：只有 B站明确成功（code 0）才算数。 */
export const sentReceipt = (r) => (r?.status === 'sent' ? { ok: true, id: r.data?.id ?? null } : null);
