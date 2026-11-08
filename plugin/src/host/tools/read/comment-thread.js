// R4 · 某条评论下的楼中楼
import { defineTool } from '../define.js';
import { readyFor, limitOf, viewOf, replyOf, depthAllows } from '../bili-common.js';

export default defineTool({
  name: 'bili_comment_thread',
  kind: 'read',
  external: true,
  description: '看某条评论下面的楼中楼（回复）：视频评论给 bvid + rpid；动态下的评论给 oid + type（从 bili_dynamic 的 comment 字段拿）+ rpid。想知道一条评论下大家在吵什么、聊什么时用。只读。',
  params: { rpid: { type: 'string', description: '那条评论的 rpid', required: true }, bvid: { type: 'string', description: '视频评论：BV 号' }, oid: { type: 'string', description: '动态评论：评论区 id' }, type: { type: 'integer', description: '动态评论：评论区类型（11 图文 / 17 文字 / 1 视频）' }, limit: { type: 'integer', description: '最多几条（默认 10，最多 20）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/view' }, { host: 'api', method: 'GET', path: '/x/v2/reply/reply' }],
  readCost: 1,
  async run(a, { biliRead, habits }, { from }) {
    const no = readyFor(biliRead); if (no) return no;
    if (!depthAllows(habits, 'threads', from)) return { ok: false, error: '爸妈设置的是不看楼中楼（读多深）' };
    if (!/^\d{1,20}$/.test(String(a.rpid || ''))) return { ok: false, error: 'rpid 不对' };
    let type = 1, oid = null;
    if (a.bvid) oid = (await viewOf(biliRead, String(a.bvid))).aid;
    else if (/^\d{1,20}$/.test(String(a.oid || ''))) { oid = a.oid; type = Number(a.type) || 1; }
    if (!oid) return { ok: false, error: '要给 bvid，或者 oid + type' };
    const d = await biliRead.raw('/x/v2/reply/reply', { type, oid, root: a.rpid, ps: 20, pn: 1 });
    return { ok: true, root: d?.root ? replyOf(d.root) : null, replies: (d?.replies || []).slice(0, limitOf(a.limit, 10, 20)).map(replyOf), usage: biliRead.usage() };
  },
});
