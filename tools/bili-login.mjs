#!/usr/bin/env node
// 鱼社 · 给鱼的 B站号扫码登录（纯 JS，不需要 Python）
//
// 用法：node tools/bili-login.mjs            扫码登录，凭证存到鱼社自己的目录
//       node tools/bili-login.mjs --check    只检查已存的凭证还能不能用（显示昵称和 UID）
//       node tools/bili-login.mjs --dry      只生成二维码看看，不轮询、不写任何文件（自检用）
//
// 流程（参考公开实现，MIT，见 plugin/NOTICE）：
//   ① GET passport …/qrcode/generate → url + qrcode_key，终端里画二维码
//   ② 手机 B站 App（登录鱼的新号）扫一扫 → 确认
//   ③ 轮询 …/qrcode/poll：86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期
//   ④ 凭证在成功那次响应的 Set-Cookie 里 → 写到 ~/.dsh/storages/dsh-yushe/bili_credential.json（权限 600）
//
// 安全：凭证只写本机文件，终端里只打印昵称和 UID，绝不打印 cookie。
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header';
const POLL = (k) => `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(k)}&source=main-fe-header`;
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi';
const NAV = 'https://api.bilibili.com/x/web-interface/nav';
const DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-yushe');
const FILE = join(DIR, 'bili_credential.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickCookies(list) {
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' };
  const jar = {};
  for (const raw of list || []) {
    const first = String(raw).split(';')[0];
    const i = first.indexOf('=');
    if (i > 0 && want[first.slice(0, i).trim()]) jar[want[first.slice(0, i).trim()]] = first.slice(i + 1).trim();
  }
  return jar;
}

async function whoami(cred) {
  const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; DedeUserID=${cred.dedeuserid}${cred.buvid3 ? `; buvid3=${cred.buvid3}` : ''}`;
  const r = await fetch(NAV, { headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://www.bilibili.com/' } });
  const j = await r.json();
  if (j?.code !== 0 || !j?.data?.isLogin) return null;
  return { uname: j.data.uname, mid: j.data.mid, level: j.data.level_info?.current_level };
}

function save(cred) {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...cred, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
  try { chmodSync(FILE, 0o600); } catch { /* 有的文件系统不支持 */ }
}

async function check() {
  if (!existsSync(FILE)) { console.log('还没有登录过。运行：node tools/bili-login.mjs'); return; }
  const me = await whoami(JSON.parse(readFileSync(FILE, 'utf8')));
  console.log(me ? `✓ 凭证有效：${me.uname}（UID ${me.mid}，Lv${me.level}）` : '✗ 凭证失效了，需要重新扫码：node tools/bili-login.mjs');
}

async function main() {
  if (process.argv.includes('--check')) return check();
  const gen = await (await fetch(GEN, { headers: { 'User-Agent': UA } })).json();
  const { url, qrcode_key: key } = gen?.data || {};
  if (!url || !key) throw new Error(`生成二维码失败：${gen?.message || '没有 qrcode_key'}`);
  console.log('\n🐟 用手机 B站 App 扫下面的二维码（先在 App 里切换到「鱼的新号」！）\n   App 首页右上角 → 扫一扫 → 确认登录\n');
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  if (process.argv.includes('--dry')) { console.log('（--dry：二维码生成正常，不轮询、不写文件）'); return; }

  let last = '';
  const deadline = Date.now() + 170_000; // 二维码大约 3 分钟过期
  while (Date.now() < deadline) {
    await sleep(2000);
    const res = await fetch(POLL(key), { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    let body = {};
    try { body = await res.json(); } catch { /* 偶尔空体 */ }
    const code = body?.data?.code;
    if (code === 86090 && last !== 'scanned') { console.log('📱 已扫码，请在手机上点「确认登录」…'); last = 'scanned'; }
    if (code === 86038) { console.log('⌛ 二维码过期了，重新运行一次就好。'); process.exit(2); }
    if (code === 0) {
      const cred = pickCookies(setCookies);
      if (!cred.sessdata) { console.log('登录返回成功，但没拿到 SESSDATA。请重试一次。'); process.exit(3); }
      if (!cred.buvid3) { try { cred.buvid3 = (await (await fetch(SPI, { headers: { 'User-Agent': UA } })).json())?.data?.b_3 || ''; } catch { /* 非必需 */ } }
      const me = await whoami(cred);
      save(cred);
      console.log(me
        ? `\n✓ 登录成功：${me.uname}（UID ${me.mid}，Lv${me.level}）\n  凭证已存到 ${FILE}（只有你能读）\n  ⚠️ 如果这不是鱼的新号，请在手机 B站「设置 → 安全中心 → 登录设备」里把这次登录下线，然后重新扫。`
        : `\n✓ 已保存凭证，但验证账号信息失败，稍后运行 --check 再看看。`);
      return;
    }
  }
  console.log('⌛ 等太久了，二维码已过期，重新运行一次就好。');
  process.exit(2);
}

main().catch((e) => { console.error('出错了：', e.message); process.exit(1); });
