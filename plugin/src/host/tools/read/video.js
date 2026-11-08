// R2 · 视频详情（标签、分 P、数据，附前 3 条热门评论）
import { defineTool } from '../define.js';
import { readyFor, viewOf, vidOf, clean, replyOf } from '../bili-common.js';

export default defineTool({
  name: 'bili_video',
  kind: 'read',
  external: true,
  description: '看一个 B站视频的详情：标题、简介、UP 主、分区、标签、时长、分 P、播放 / 点赞 / 收藏 / 评论数，附前 3 条热门评论。给 BV 号。只读；读到的是标题和简介，不等于看过视频内容（想知道视频里说了什么用 bili_subtitle）。',
  params: { bvid: { type: 'string', description: 'BV 号，比如 BV1xx411c7mD', required: true } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/view' }, { host: 'api', method: 'GET', path: '/x/tag/archive/tags' }, { host: 'api', method: 'GET', path: '/x/v2/reply/main' }],
  readCost: 3,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead); if (no) return no;
    const v = await viewOf(biliRead, String(a.bvid || ''));
    const tags = await biliRead.raw('/x/tag/archive/tags', { bvid: v.bvid }).then((d) => (d || []).map((t) => clean(t.tag_name, 16)).filter(Boolean).slice(0, 10)).catch(() => []);
    const hot = v.aid ? await biliRead.raw('/x/v2/reply/main', { type: 1, oid: v.aid, mode: 3, next: 0 }).then((d) => (d?.replies || []).slice(0, 3).map(replyOf)).catch(() => []) : [];
    return { ok: true, video: vidOf(v, { duration: v.duration, pubdate: v.pubdate, like: v.stat?.like ?? 0, coin: v.stat?.coin ?? 0, favorite: v.stat?.favorite ?? 0, reply: v.stat?.reply ?? 0, danmaku: v.stat?.danmaku ?? 0, tags, pages: (v.pages || []).slice(0, 10).map((p) => ({ page: p.page, title: clean(p.part, 40), duration: p.duration })) }), hotComments: hot, usage: biliRead.usage() };
  },
});
