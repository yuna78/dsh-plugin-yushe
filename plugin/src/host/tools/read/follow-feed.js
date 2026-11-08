// R17 · 她关注的人的新动态
import { defineTool } from '../define.js';
import { readyFor, limitOf, dynOf } from '../bili-common.js';

export default defineTool({
  name: 'bili_follow_feed',
  kind: 'read',
  external: true,
  description: '刷你关注的人最近发了什么：type=全部（文字、图文、转发、视频）或 视频。每条有作者、文字、带的视频、动态 id（想看评论用 bili_dynamic）。给上次返回的 offset 能接着往下刷。只读。',
  params: { type: { type: 'string', enum: ['全部', '视频'], description: '默认全部' }, offset: { type: 'string', description: '接着上次往下刷（上次返回的 offset）' }, limit: { type: 'integer', description: '最多几条（默认 8，最多 20）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/polymer/web-dynamic/v1/feed/all', login: true }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead); if (no) return no;
    const d = await biliRead.raw('/x/polymer/web-dynamic/v1/feed/all', { type: a.type === '视频' ? 'video' : 'all', ...(a.offset && /^\d{1,30}$/.test(String(a.offset)) ? { offset: a.offset } : {}) });
    return { ok: true, items: (d?.items || []).slice(0, limitOf(a.limit, 8, 20)).map(dynOf), offset: d?.offset ? String(d.offset) : null, more: Boolean(d?.has_more), usage: biliRead.usage() };
  },
});
