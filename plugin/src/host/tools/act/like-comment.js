// A2 · 给评论点赞 / 取消
import { defineTool } from '../define.js';
import { writeReadyFor, viewOf, sentReceipt } from '../bili-common.js';

const CAP = { key: 'commentLikesPerDay', label: '每天最多给几条评论点赞', levels: { 少: 5, 适中: 15, 多: 30 }, max: 50 };

export default defineTool({
  name: 'bili_like_comment',
  kind: 'act',
  description: '给一条评论点赞（undo=true 取消）：视频下的评论给 bvid + rpid；动态下的评论给 oid + type（从 bili_dynamic 的 comment 字段拿）+ rpid。觉得哪条评论说得好就点；每天有上限。',
  params: { rpid: { type: 'string', description: '评论的 rpid', required: true }, bvid: { type: 'string', description: '视频评论：BV 号' }, oid: { type: 'string', description: '动态评论：评论区 id' }, type: { type: 'integer', description: '动态评论：评论区类型' }, undo: { type: 'boolean', description: '取消点赞' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/view' }, { host: 'api', method: 'POST', path: '/x/v2/reply/action', login: true, csrf: true }],
  readCost: 1,
  cap: CAP,
  receipt: sentReceipt,
  async run(a, deps) {
    const no = writeReadyFor(deps); if (no) return no;
    const { biliRead, biliWrite, acts } = deps;
    if (!/^\d{1,20}$/.test(String(a.rpid || ''))) return { ok: false, error: 'rpid 不对' };
    let type = 1, oid = null, title = null, url = null;
    if (a.bvid) { const v = await viewOf(biliRead, String(a.bvid)); oid = v.aid; title = v.title; url = `https://www.bilibili.com/video/${v.bvid}#reply${a.rpid}`; }
    else if (/^\d{1,20}$/.test(String(a.oid || ''))) { oid = String(a.oid); type = Number(a.type) || 1; }
    if (!oid) return { ok: false, error: '要给 bvid，或者 oid + type' };
    const undo = a.undo === true;
    return acts.act('comment_like', {
      cap: undo ? null : CAP, key: undo ? null : `clike:${oid}:${a.rpid}`, undoKey: undo ? `clike:${oid}:${a.rpid}` : null, receipt: sentReceipt,
      run: () => biliWrite.raw('/x/v2/reply/action', { type, oid, rpid: a.rpid, action: undo ? 0 : 1 }),
      footprint: undo ? null : { text: title ? `《${String(title).slice(0, 40)}》下的一条评论` : '一条动态评论', url, target: { oid, rpid: a.rpid } },
    });
  },
});
