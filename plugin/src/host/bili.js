/**
 * 她的 B站号：游戏里扫码登录（F-38 开局设置）。和 tools/bili-login.mjs 同一套流程，搬到宿主端做成路由。
 *
 *   GET  /api/dsh-yushe/bili          {loggedIn, uname, mid, level}（凭证本身绝不回给浏览器）
 *   POST /api/dsh-yushe/bili/qr       生成二维码 → {id, svg}；id 是本机临时句柄，不是 B站的 qrcode_key
 *   GET  /api/dsh-yushe/bili/qr?id=   轮询一次 → {state: waiting|scanned|expired|done, uname?}
 *   POST /api/dsh-yushe/bili/logout   删掉本机凭证（换号用）；B站那边的登录设备请在 App 里下线
 *
 * 凭证 <storage>/bili_credential.json（600）。流程参考公开实现（MIT，见 NOTICE）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { nowMs, nowDate } from './clock.js';

export const BILI_PATH = '/api/dsh-yushe/bili';
export const BILI_QR_PATH = '/api/dsh-yushe/bili/qr';
export const BILI_LOGOUT_PATH = '/api/dsh-yushe/bili/logout';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header';
const POLL = (k) => `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(k)}&source=main-fe-header`;
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi';
const NAV = 'https://api.bilibili.com/x/web-interface/nav';

/** Set-Cookie 里挑出要的四个；其余丢掉。 */
export function pickCookies(list) {
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' };
  const jar = {};
  for (const raw of list || []) {
    const first = String(raw).split(';')[0];
    const i = first.indexOf('=');
    if (i > 0 && want[first.slice(0, i).trim()]) jar[want[first.slice(0, i).trim()]] = first.slice(i + 1).trim();
  }
  return jar;
}

/** 轮询返回码 → 状态。 */
export function pollState(code) {
  if (code === 0) return 'done';
  if (code === 86090) return 'scanned';
  if (code === 86038) return 'expired';
  return 'waiting';
}

export function createBili(storage, fetchImpl = fetch) {
  const file = join(storage, 'bili_credential.json');
  const sessions = new Map(); // id → { key, at }
  let who = null, whoAt = 0;

  const readCred = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
  const save = (cred) => {
    mkdirSync(storage, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...cred, savedAt: nowDate().toISOString() }, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    try { chmodSync(file, 0o600); } catch { /* 有的文件系统不支持 */ }
  };
  async function whoami(cred) {
    if (!cred?.sessdata) return null;
    const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; DedeUserID=${cred.dedeuserid}${cred.buvid3 ? `; buvid3=${cred.buvid3}` : ''}`;
    try {
      const j = await (await fetchImpl(NAV, { headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://www.bilibili.com/' } })).json();
      if (j?.code !== 0 || !j?.data?.isLogin) return null;
      return { uname: j.data.uname, mid: j.data.mid, level: j.data.level_info?.current_level ?? null };
    } catch { return null; }
  }

  return {
    /** 登录状态（账号信息缓存 10 分钟；凭证失效会显示「需要重新扫码」）。 */
    async status() {
      if (!existsSync(file)) return { loggedIn: false };
      if (!who || nowMs() - whoAt > 600_000) { who = await whoami(readCred()); whoAt = nowMs(); }
      return who ? { loggedIn: true, ...who } : { loggedIn: false, expired: true };
    },
    async newQr() {
      const gen = await (await fetchImpl(GEN, { headers: { 'User-Agent': UA } })).json();
      const { url, qrcode_key: key } = gen?.data || {};
      if (!url || !key) throw new Error(`生成二维码失败：${gen?.message || '没有 qrcode_key'}`);
      for (const [k, v] of sessions) if (nowMs() - v.at > 300_000) sessions.delete(k);
      const id = randomUUID();
      sessions.set(id, { key, at: nowMs() });
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#2a2440', light: '#ffffff' } });
      return { id, svg };
    },
    async poll(id) {
      const s = sessions.get(id);
      if (!s) return { state: 'expired' };
      const res = await fetchImpl(POLL(s.key), { headers: { 'User-Agent': UA }, redirect: 'manual' });
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      let body = {};
      try { body = await res.json(); } catch { /* 偶尔空体 */ }
      const state = pollState(body?.data?.code);
      if (state === 'expired') { sessions.delete(id); return { state }; }
      if (state !== 'done') return { state };
      sessions.delete(id);
      const cred = pickCookies(setCookies);
      if (!cred.sessdata) return { state: 'expired', error: '登录返回成功，但没拿到凭证，请重扫一次' };
      if (!cred.buvid3) { try { cred.buvid3 = (await (await fetchImpl(SPI, { headers: { 'User-Agent': UA } })).json())?.data?.b_3 || ''; } catch { /* 非必需 */ } }
      save(cred);
      who = await whoami(cred); whoAt = nowMs();
      return { state: 'done', ...(who || {}) };
    },
    logout() { rmSync(file, { force: true }); who = null; return { loggedIn: false }; },
  };
}

export function registerBiliRoutes({ scope, bili, isLoopbackRequest, writeJson }) {
  const reg = (path, handler, label) => scope.effect(() => scope.webServer.register({ kind: 'exact', path, handler: async (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
    try { await handler(req, res); } catch (e) { writeJson(res, 200, { ok: false, error: String(e?.message || e) }); }
  } }), `dsh-yushe: ${label}`);
  reg(BILI_PATH, async (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    writeJson(res, 200, { ok: true, ...(await bili.status()) });
  }, 'bili status route');
  reg(BILI_QR_PATH, async (req, res) => {
    if (req.method === 'POST') return writeJson(res, 200, { ok: true, ...(await bili.newQr()) });
    if (req.method === 'GET') return writeJson(res, 200, { ok: true, ...(await bili.poll(new URL(req.url || '', 'http://x').searchParams.get('id') || '')) });
    writeJson(res, 405, { ok: false, error: 'method not allowed' });
  }, 'bili qr route');
  reg(BILI_LOGOUT_PATH, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    writeJson(res, 200, { ok: true, ...bili.logout() });
  }, 'bili logout route');
}
