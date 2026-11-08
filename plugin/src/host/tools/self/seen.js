// S8 · 翻自己的见闻流水账（F-86 一期-1）：出门 / 梦游看过的每一条都在，比记忆全；房间聊天也能用
import { defineTool, NO_FISH } from '../define.js';
import { DEPTHS } from '../../../shared/seen.js';

export default defineTool({
  name: 'yushe_seen',
  kind: 'self',
  external: true,
  expose: { main: true, trip: false, room: true },
  description: '翻你自己的见闻流水账：看过的所有视频 / 新闻（比记忆全，记忆是印象，这里是查得到的清单，每条带哪天、来源、分区、UP 主、读多深）。爸妈问「你今天 / 某天 / 最近看了什么、有没有某类或某个 UP 的东西」时先用它。query 写关键词（空格分开，可以带时间词，比如「昨天 猫咪」「11月8日 新闻」）；minDepth 只看读得至少这么深的；offset / limit 翻页，翻到更多就接着翻或换个词；stats 只回统计（多少条、各深度多少、最多的分区 / UP）。只讲翻到的，没翻到的就说没印象；别编工具没给你的标题、链接。',
  params: {
    query: { type: 'string', description: '关键词，空格分开；可带时间词（今天 / 昨天 / 3天前 / 11月8日…）；也可以只给时间词' },
    minDepth: { type: 'string', enum: DEPTHS, description: '只看读得至少这么深的：list 刷到 / detail 点开看了 / deep 读了字幕或评论 / acted 点赞收藏评论过 / noted 记进游记' },
    offset: { type: 'integer', description: '翻页：从第几条开始（默认 0）' },
    limit: { type: 'integer', description: '一页几条（默认 20，最多 50）' },
    stats: { type: 'boolean', description: 'true 时只回统计，不回清单' },
  },
  async run(a, { pond, seenLog }) {
    const f = pond.current(); if (!f) return NO_FISH;
    if (!seenLog) return { ok: false, error: '见闻流水账还没准备好' };
    const opts = {
      query: String(a.query ?? '').slice(0, 120),
      minDepth: DEPTHS.includes(a.minDepth) ? a.minDepth : null,
      offset: Math.max(0, Math.round(Number(a.offset) || 0)),
      limit: Math.max(1, Math.min(50, Math.round(Number(a.limit) || 20))),
    };
    if (a.stats) return { ok: true, stats: seenLog.stats(f, opts) };
    const q = seenLog.query(f, opts);
    return { ok: true, total: q.total, offset: q.offset, more: q.more, items: q.items, hint: q.more ? `一共 ${q.total} 条，还有的没翻到，可以用 offset: ${q.offset + q.items.length} 翻下一页，或换个词再找` : `一共 ${q.total} 条` };
  },
});
