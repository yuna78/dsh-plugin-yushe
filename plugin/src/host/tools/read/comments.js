// R3 · 视频评论（热门 / 最新，翻页）
import { defineTool } from '../define.js';
import { readyFor, limitOf, viewOf, replyOf } from '../bili-common.js';

export default defineTool({
  name: 'bili_comments',
  kind: 'read',
  external: true,
  description: '看一个 B站视频下面的评论：sort=热门 或 最新，page 翻页。每条有用户名、内容、点赞数、回复数和 rpid（想看某条下面的楼中楼，把 rpid 给 bili_comment_thread）。想知道大家怎么评价一个视频时用。只读。',
  params: { bvid: { type: 'string', description: 'BV 号', required: true }, sort: { type: 'string', enum: ['热门', '最新'], description: '默认热门' }, page: { type: 'integer', description: '第几页（默认 1）' }, limit: { type: 'integer', description: '最多几条（默认 5，最多 20）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/view' }, { host: 'api', method: 'GET', path: '/x/v2/reply/main' }],
  readCost: 2,
  async run(a, { biliRead, habits }, { from }) {
    const no = readyFor(biliRead); if (no) return no;
    const v = await viewOf(biliRead, String(a.bvid || ''));
    if (!v.aid) return { ok: false, error: '拿不到这个视频的 id' };
    const cap = from === 'trip' ? Math.max(1, habits?.get?.().commentsPerVideo ?? 5) : 20; // 出门按「每个视频看几条评论」
    const n = Math.min(limitOf(a.limit, 5, 20), cap);
    const d = await biliRead.raw('/x/v2/reply/main', { type: 1, oid: v.aid, mode: a.sort === '最新' ? 2 : 3, next: Math.max(0, (Number(a.page) || 1) - 1) });
    return { ok: true, video: { title: v.title, bvid: v.bvid, url: `https://www.bilibili.com/video/${v.bvid}`, aid: v.aid }, comments: (d?.replies || []).slice(0, n).map(replyOf), more: !d?.cursor?.is_end, usage: biliRead.usage() };
  },
});
