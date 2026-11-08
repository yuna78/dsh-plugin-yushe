/**
 * 相册照片（F-46）：用妈妈在设置里配的生图 API（OpenAI 兼容 /images/generations）画照片，存本机。
 *   readImageApi(storage)       读设置（key 只在宿主内存里用，不回浏览器）
 *   generatePhoto(storage, p)   画一张 → { id }；没配 / 失败抛错
 *   GET /api/dsh-yushe/photo/<id>   取照片（id 只认 [a-z0-9-]，不会越界读文件）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// 前缀路由注册时不能带结尾斜杠：DSH 只认「等于前缀」或「以 前缀 + / 开头」（带斜杠就变成要 photo// 才匹配）
export const PHOTO_ROUTE = '/api/dsh-yushe/photo';
export const PHOTO_PREFIX = `${PHOTO_ROUTE}/`;

export function readImageApi(storage) {
  try { const c = JSON.parse(readFileSync(join(storage, 'image-api.json'), 'utf8')); return { baseUrl: c.baseUrl || '', model: c.model || '', size: c.size || '1024x1024', apiKey: c.apiKey || '' }; } catch { return { baseUrl: '', model: '', size: '1024x1024', apiKey: '' }; }
}
export const imageApiReady = (storage) => { const c = readImageApi(storage); return Boolean(c.baseUrl && c.apiKey); };

const sniff = (buf) => (buf[0] === 0x89 && buf[1] === 0x50 ? 'png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.slice(8, 12).toString() === 'WEBP' ? 'webp' : 'png');
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export async function generatePhoto(storage, prompt, fetchImpl = fetch) {
  const c = readImageApi(storage);
  if (!c.baseUrl || !c.apiKey) throw new Error('还没配生图 API');
  const url = `${c.baseUrl.replace(/\/+$/, '')}/images/generations`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 240_000);
  let buf;
  try {
    const r = await fetchImpl(url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify({ model: c.model || undefined, prompt, size: c.size, n: 1 }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`生图 API 返回 ${r.status}：${String(j?.error?.message || '').slice(0, 120)}`);
    const item = j?.data?.[0];
    if (item?.b64_json) buf = Buffer.from(item.b64_json, 'base64');
    else if (item?.url) buf = Buffer.from(await (await fetchImpl(item.url, { signal: ctl.signal })).arrayBuffer());
    else throw new Error('生图 API 没有返回图片');
  } finally { clearTimeout(timer); }
  const id = `p${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const dir = join(storage, 'photos');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.${sniff(buf)}`), buf);
  return { id };
}

export function registerPhotoRoute({ scope, storage, isLoopbackRequest, writeJson }) {
  scope.effect(() => scope.webServer.register({
    kind: 'prefix', path: PHOTO_ROUTE,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
      const id = decodeURIComponent(new URL(req.url || '', 'http://x').pathname.slice(PHOTO_PREFIX.length));
      if (!/^[a-z0-9-]{4,40}$/.test(id)) { res.statusCode = 404; return res.end('not found'); }
      for (const ext of ['png', 'jpg', 'webp']) {
        const f = join(storage, 'photos', `${id}.${ext}`);
        if (existsSync(f)) { res.statusCode = 200; res.setHeader('content-type', TYPES[ext]); res.setHeader('cache-control', 'max-age=86400'); return res.end(readFileSync(f)); }
      }
      res.statusCode = 404; res.end('not found');
    },
  }), 'dsh-yushe: photo route');
}
