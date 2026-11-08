// R16 · 她关注的人
import { defineTool } from '../define.js';
import { readyFor, limitOf, clean, isoOf } from '../bili-common.js';

export default defineTool({
  name: 'bili_my_follows',
  kind: 'read',
  external: true,
  description: '看你（她的 B站号）关注了哪些人：名字、mid、签名、什么时候关注的，按最近关注排。page 翻页。只读。',
  params: { page: { type: 'integer', description: '第几页（默认 1）' }, limit: { type: 'integer', description: '每页几个（默认 20，最多 50）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/relation/followings', login: true }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead); if (no) return no;
    const mid = biliRead.myMid(); if (!mid) return { ok: false, error: '拿不到她的 B站号' };
    const n = limitOf(a.limit, 20, 50);
    const d = await biliRead.raw('/x/relation/followings', { vmid: mid, ps: n, pn: Math.max(1, Number(a.page) || 1), order: 'desc' });
    return { ok: true, total: Number(d?.total) || 0, follows: (d?.list || []).map((x) => ({ mid: String(x.mid), name: clean(x.uname, 30), sign: clean(x.sign, 60), since: isoOf(x.mtime) })), usage: biliRead.usage() };
  },
});
