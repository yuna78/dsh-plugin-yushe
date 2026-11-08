// R18 · 一条动态的内容 + 评论
import { defineTool } from '../define.js';
import { readyFor, limitOf, dynOf, replyOf } from '../bili-common.js';

export default defineTool({
  name: 'bili_dynamic',
  kind: 'read',
  external: true,
  description: '看一条 B站动态：正文、作者、带的视频、转发 / 评论 / 点赞数；withComments=true 再附几条热门评论。给动态 id（t.bilibili.com/后面那串数字）。返回的 comment 字段（type + oid）是这条动态的评论区，想看楼中楼或者以后回复都用它。只读。',
  params: { id: { type: 'string', description: '动态 id', required: true }, withComments: { type: 'boolean', description: '要不要附热门评论（默认要）' }, limit: { type: 'integer', description: '评论最多几条（默认 5，最多 10）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/polymer/web-dynamic/v1/detail' }, { host: 'api', method: 'GET', path: '/x/v2/reply/main' }],
  readCost: 2,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead); if (no) return no;
    if (!/^\d{1,30}$/.test(String(a.id || ''))) return { ok: false, error: '动态 id 要是一串数字' };
    const d = await biliRead.raw('/x/polymer/web-dynamic/v1/detail', { id: a.id });
    const dyn = dynOf(d?.item);
    let comments = [];
    if (a.withComments !== false && dyn.comment) comments = await biliRead.raw('/x/v2/reply/main', { type: dyn.comment.type, oid: dyn.comment.oid, mode: 3, next: 0 }).then((r) => (r?.replies || []).slice(0, limitOf(a.limit)).map(replyOf)).catch(() => []);
    return { ok: true, dynamic: dyn, comments, usage: biliRead.usage() };
  },
});
