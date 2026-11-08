/**
 * 关注接生员的 B站号（F-61）：她扫码登录好以后，问爸妈一次「要不要让她关注鱼见未来本鱼的号」。
 * 只在爸妈点了「关注」时才关注；点「先不用」就记下来，不再追问（设置里还能手动关注）。
 *
 *   GET  /api/dsh-yushe/bili/official   { available, name, loggedIn, following, declined }
 *   POST /api/dsh-yushe/bili/official   {follow:true} 关注（再查一次关系，已关注就不重复点）；{decline:true} 先不用
 *
 * 报告问题（F-65）：设置里写一段，用她的号私信接生员（得先关注）。带版本和鱼的基本情况，不带密钥；每天最多 3 条。
 *   POST {report:'…'} → { ok } | { ok:false, needFollow:true } | { ok:false, error }
 *
 * 接生员的 UID 写在 OFFICIAL.mid；空着就整个功能不出现。关注走 bili-write.follow，不重试。存 <storage>/official.json。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonBody } from './game-routes.js';
import { nowDate } from './clock.js';

export const OFFICIAL = { name: '鱼见未来本鱼', mid: '3744986388500351' }; // mid：接生员 B站号的数字 UID（空 = 不出现）
export const OFFICIAL_PATH = '/api/dsh-yushe/bili/official';

export const REPORTS_PER_DAY = 3;
const SECRETY = /(sk-[A-Za-z0-9]{12,}|SESSDATA|bili_jct|api[_ ]?key\s*[:=]|token\s*[:=]\s*\S{12,})/i;

/** 报告问题的私信正文：头一行是版本和鱼的情况，后面是爸妈写的。纯函数（verify 用）。 */
export function reportText({ text, version, fish, call }) {
  const body = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 400);
  const who = fish ? `${fish.name}（${fish.proto}${fish.rarity ? ` · ${fish.rarity}` : ''}）` : '还没领养';
  return `【鱼社问题反馈】v${version || '?'} · ${who}${call ? ` · ${call}写的` : ''}\n${body}`;
}

export function createOfficial({ storage, biliRead, biliWrite, life, pond, official = OFFICIAL, version = '' }) {
  const file = join(storage, 'official.json');
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const save = (v) => { mkdirSync(storage, { recursive: true }); writeFileSync(file, JSON.stringify(v)); };
  const available = () => /^\d{1,20}$/.test(String(official.mid || ''));
  const fishNow = () => pond?.current?.() || pond?.list?.().fish?.at(-1) || null;
  const followingNow = async () => { try { const a = await biliRead.relationTo(official.mid); return a === 2 || a === 6; } catch { return null; } };
  return {
    async view() {
      const st = load(), loggedIn = Boolean(biliRead?.loggedIn?.());
      if (!available() || !loggedIn) return { available: available(), name: official.name, loggedIn, following: false, declined: Boolean(st.declined) };
      // 先问 B站（爸妈可能在 App 里取消了关注）；问不到再用记下来的
      const live = await followingNow();
      const following = live === null ? Boolean(st.followed) : live;
      if (live === false && st.followed) save({ ...st, followed: false });
      return { available: true, name: official.name, loggedIn, following: Boolean(following), declined: Boolean(st.declined) };
    },
    async follow() {
      if (!available()) return { ok: false, error: '还没设置接生员的 B站号' };
      if (!biliWrite?.ready?.()) return { ok: false, error: '她还没登录 B站' };
      if (await followingNow()) { save({ ...load(), followed: true, declined: false }); return { ok: true, already: true }; }
      const r = await biliWrite.follow({ mid: official.mid });
      if (r.status !== 'sent') return { ok: false, error: r.reason || '没关注上', uncertain: r.status === 'uncertain' };
      save({ ...load(), followed: true, declined: false, at: nowDate().toISOString() });
      const f = fishNow(); if (f) life.record(f, 'follow-official', `在 B站关注了接生员「${official.name}」，以后有新鱼、新玩法会第一个看到`, { mood: 2 });
      return { ok: true };
    },
    decline() { save({ ...load(), declined: true }); return { ok: true }; },
    /** 报告问题：先关注才能发；内容不能像密钥；每天最多 3 条；同一段话 10 分钟内不重发。 */
    async report(text) {
      if (!available()) return { ok: false, error: '还没设置接生员的 B站号' };
      if (!biliWrite?.ready?.()) return { ok: false, error: '她还没登录 B站，先在设置里扫码' };
      const body = String(text ?? '').trim();
      if (body.length < 4) return { ok: false, error: '多写几个字吧，说说遇到了什么' };
      if (body.length > 400) return { ok: false, error: '太长啦，400 个字以内' };
      if (SECRETY.test(body)) return { ok: false, error: '里面像是有密钥 / 登录凭证，别发出去，删掉再发' };
      const st = load(), today = nowDate().toISOString().slice(0, 10);
      const sent = (st.reports || []).filter((r) => (r.at || '').slice(0, 10) === today);
      if (sent.length >= REPORTS_PER_DAY) return { ok: false, error: `今天已经发了 ${REPORTS_PER_DAY} 条，明天再来吧` };
      if ((st.reports || []).some((r) => r.text === body && Date.parse(nowDate().toISOString()) - Date.parse(r.at) < 600_000)) return { ok: false, error: '这段刚刚发过了' };
      if (!(await followingNow())) return { ok: false, needFollow: true, error: `要先关注「${official.name}」才能给她发私信` };
      const f = fishNow();
      const r = await biliWrite.dm({ mid: official.mid, text: reportText({ text: body, version, fish: f, call: f?.parentCall }) });
      if (r.status !== 'sent') return { ok: false, error: r.status === 'uncertain' ? `不确定发出去没有（${r.reason || ''}），去 B站私信里看看，先别重发` : (r.reason || '没发出去') };
      save({ ...load(), reports: [...(load().reports || []), { at: nowDate().toISOString(), text: body }].slice(-50) });
      return { ok: true, left: REPORTS_PER_DAY - sent.length - 1 };
    },
  };
}

export function registerOfficialRoutes({ scope, official, isLoopbackRequest, writeJson }) {
  scope.effect(() => scope.webServer.register({ kind: 'exact', path: OFFICIAL_PATH, handler: async (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
    try {
      if (req.method === 'GET') return writeJson(res, 200, { ok: true, ...(await official.view()) });
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
      const b = await readJsonBody(req);
      if (b?.follow === true) return writeJson(res, 200, await official.follow());
      if (b?.decline === true) return writeJson(res, 200, official.decline());
      if (typeof b?.report === 'string') return writeJson(res, 200, await official.report(b.report));
      writeJson(res, 400, { ok: false, error: '请求格式不对' });
    } catch (e) { writeJson(res, 200, { ok: false, error: String(e?.message || e).slice(0, 120) }); }
  } }), 'dsh-yushe: official follow route');
}
