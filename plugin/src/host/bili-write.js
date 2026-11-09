/**
 * 她在 B站发声（M5b）：只有闸门 + 爸妈批准之后才会被调用。只认两个固定接口：
 *   评论  POST https://api.bilibili.com/x/v2/reply/add            （表单：type=1, oid=视频 aid, message, plat=1, csrf）
 *   动态  POST https://api.bilibili.com/x/dynamic/feed/create/dyn （JSON：纯文字动态）
 *   关注  POST https://api.bilibili.com/x/relation/modify（表单：fid, act=1, re_src=11, csrf）——只在爸妈点了「关注」时调
 *   私信  POST https://api.vc.bilibili.com/web_im/v1/web_im/send_msg（表单 msg[...] + csrf；query 要 WBI 签名，签名器由 bili-read 给）
 * 超时 / 网络错误**绝不重试**（可能已经发出去了，重试会发两条一样的公开内容），标成「不确定」交给爸妈去 B站看。
 * 请求形状参考公开实现（见 NOTICE），JS 自写。
 *
 * G3：B站风控退避期间（bili-read 的 blocked()）一律不发。
 * 工具表里的互动工具（点赞 / 收藏 / 关注…，任务 49）走 raw()：只认工具表声明过的 POST 路径（extraPaths，由 tools/registry.js 生成）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

export function createBiliWrite(storage, fetchImpl = fetch, { sign = null, blocked = () => false, extraPaths = null } = {}) {
  const cred = () => { const f = join(storage, 'bili_credential.json'); if (!existsSync(f)) return null; try { const c = JSON.parse(readFileSync(f, 'utf8')); return c.sessdata && c.bili_jct ? c : null; } catch { return null; } };
  async function post(url, { body, contentType, referer, origin = 'https://www.bilibili.com' }) {
    const c = cred(); if (!c) return { status: 'rejected', reason: '她还没有登录 B站' };
    if (blocked()) return { status: 'rejected', reason: 'B站正在风控，先不发' };
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15_000);
    try {
      const res = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: ctl.signal, body, headers: { 'Content-Type': contentType, Cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; DedeUserID=${c.dedeuserid || ''}; buvid3=${c.buvid3 || ''}`, 'User-Agent': UA, Referer: referer, Origin: origin } });
      const j = await res.json().catch(() => null);
      if (!j) return { status: 'uncertain', reason: `B站没回正常结果（HTTP ${res.status}），不重试，去 B站看看有没有发出去` };
      if (j.code === 0) return { status: 'sent', data: j.data || {} };
      return { status: 'rejected', code: j.code, reason: `B站拒绝了（${j.code}）：${String(j.message || '').slice(0, 80)}` };
    } catch (e) {
      return { status: 'uncertain', reason: `网络问题（${String(e?.name || e).slice(0, 40)}），不重试，去 B站看看有没有发出去` };
    } finally { clearTimeout(timer); }
  }
  return {
    ready: () => Boolean(cred()),
    /** 关注一个 UP 主（只在爸妈明确点了「关注」时调用）。 */
    async follow({ mid }) {
      const c = cred(); if (!c) return { status: 'rejected', reason: '她还没有登录 B站' };
      if (!/^\d{1,20}$/.test(String(mid || ''))) return { status: 'rejected', reason: 'UID 不对' };
      const form = new URLSearchParams({ fid: String(mid), act: '1', re_src: '11', csrf: c.bili_jct });
      return post('https://api.bilibili.com/x/relation/modify', { body: form.toString(), contentType: 'application/x-www-form-urlencoded', referer: `https://space.bilibili.com/${mid}` });
    },
    /** 工具用的通用写（表单 POST，自动带 csrf）：只认工具表声明的路径。返回 { status: sent|rejected|uncertain, data? }。 */
    async raw(path, fields = {}, { host = 'api', referer = 'https://www.bilibili.com/' } = {}) {
      if (!extraPaths?.[host]?.has(path)) return { status: 'rejected', reason: '不认识的 B站接口' };
      const base = host === 'vc' ? 'https://api.vc.bilibili.com' : 'https://api.bilibili.com';
      const form = new URLSearchParams({ ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])), csrf: cred()?.bili_jct || '' });
      return post(`${base}${path}`, { body: form.toString(), contentType: 'application/x-www-form-urlencoded', referer });
    },
    /** 私信（只回别人先发来的，宿主端 dms.js 保证）。 */
    async dm({ mid, text }) {
      const c = cred(); if (!c) return { status: 'rejected', reason: '她还没有登录 B站' };
      if (!/^\d{1,20}$/.test(String(mid || '')) || !/^\d{1,20}$/.test(String(c.dedeuserid || ''))) return { status: 'rejected', reason: 'UID 不对' };
      if (!sign) return { status: 'rejected', reason: '没有签名器' };
      let q; try { q = await sign({ w_sender_uid: c.dedeuserid, w_receiver_id: mid }); } catch (e) { return { status: 'rejected', reason: `签名失败：${String(e?.message || e).slice(0, 60)}` }; }
      const form = new URLSearchParams({ 'msg[sender_uid]': String(c.dedeuserid), 'msg[receiver_id]': String(mid), 'msg[receiver_type]': '1', 'msg[msg_type]': '1', 'msg[msg_status]': '0', 'msg[content]': JSON.stringify({ content: String(text) }), 'msg[dev_id]': randomUUID().toUpperCase(), 'msg[new_face_version]': '0', 'msg[timestamp]': String(Math.floor(Date.now() / 1000)), from_filework: '0', build: '0', mobi_app: 'web', csrf: c.bili_jct, csrf_token: c.bili_jct });
      return post(`https://api.vc.bilibili.com/web_im/v1/web_im/send_msg?${q}`, { body: form.toString(), contentType: 'application/x-www-form-urlencoded', referer: 'https://message.bilibili.com/', origin: 'https://message.bilibili.com' });
    },
    async comment({ aid, bvid, text }) {
      if (!/^\d{1,20}$/.test(String(aid || ''))) return { status: 'rejected', reason: '视频 id 不对' };
      const form = new URLSearchParams({ type: '1', oid: String(aid), message: String(text), plat: '1', csrf: cred()?.bili_jct || '' });
      const r = await post('https://api.bilibili.com/x/v2/reply/add', { body: form.toString(), contentType: 'application/x-www-form-urlencoded', referer: `https://www.bilibili.com/video/${bvid || ''}` });
      if (r.status === 'sent') r.url = `https://www.bilibili.com/video/${bvid}#reply${r.data?.rpid_str || r.data?.rpid || ''}`;
      return r;
    },
    /** 传一张图到 B站图床，返回 { img_src, img_width, img_height }；失败返回 { status:'rejected', reason }。 */
    async uploadImage({ data, filename = 'image.png', mime = 'image/png' }) {
      const c = cred(); if (!c) return { status: 'rejected', reason: '她还没有登录 B站' };
      if (blocked()) return { status: 'rejected', reason: 'B站正在风控，先不发' };
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length > 20 * 1024 * 1024) return { status: 'rejected', reason: '图片太大（超过 20MB）' };
      const form = new FormData();
      form.append('file_up', new Blob([buf], { type: mime }), filename);
      form.append('category', 'daily'); form.append('biz', '3'); form.append('csrf', c.bili_jct || '');
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60_000);
      try {
        const res = await fetchImpl('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', {
          method: 'POST', signal: ctl.signal, body: form,
          headers: { Cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; DedeUserID=${c.dedeuserid || ''}; buvid3=${c.buvid3 || ''}`, 'User-Agent': UA, Referer: 'https://t.bilibili.com/' },
        });
        const j = await res.json().catch(() => null);
        if (!j) return { status: 'uncertain', reason: `图床没回正常结果（HTTP ${res.status}）` };
        if (j.code !== 0) return { status: 'rejected', reason: `图床拒绝了（${j.code}）：${String(j.message || '').slice(0, 60)}` };
        const d = j.data || {};
        return { status: 'sent', pic: { img_src: d.image_url, img_width: d.image_width, img_height: d.image_height } };
      } catch (e) {
        return { status: 'uncertain', reason: `传图出问题（${String(e?.name || e).slice(0, 40)}），不重试` };
      } finally { clearTimeout(timer); }
    },
    async post({ text, pics = null }) {
      const c = cred();
      // 带图：pics 要放在 dyn_req 这一层（放 content 里会被静默忽略，发出去只有字）
      const payload = { dyn_req: { content: { contents: [{ raw_text: String(text), type: 1, biz_id: '' }] }, scene: 1 } };
      if (Array.isArray(pics) && pics.length) payload.dyn_req.pics = pics.slice(0, 9);
      const r = await post(`https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=${encodeURIComponent(c?.bili_jct || '')}`, { body: JSON.stringify(payload), contentType: 'application/json', referer: 'https://t.bilibili.com/' });
      if (r.status === 'sent') r.url = r.data?.dyn_id_str ? `https://t.bilibili.com/${r.data.dyn_id_str}` : 'https://t.bilibili.com/';
      return r;
    },
  };
}
