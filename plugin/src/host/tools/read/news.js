// R22 · 今天的新闻（宿主预取的固定新闻源）
import { nowDate } from '../../clock.js';
import { fetchNews, pickSources } from '../../sources.js';
import { newsSourcesFor } from '../../../shared/habits.js';
import { defineTool } from '../define.js';
import { limitOf } from '../bili-common.js';

export default defineTool({
  name: 'news_today',
  kind: 'read',
  external: true,
  description: '看今天的新闻：从鱼社固定的几个科技 / 数码 / AI 新闻站（Solidot、IT之家、少数派、爱范儿、量子位、极客公园）里挑几个，返回标题和链接。不占 B站读次数。想念新闻、找话题时用。',
  params: { limit: { type: 'integer', description: '每个站最多几条（默认 5，最多 10）' } },
  async run(a, { pond, habits, fetchNewsImpl }) {
    const f = pond?.current?.();
    const k = newsSourcesFor(habits?.get?.().lean || 'both');
    const sources = pickSources(`${nowDate().toISOString().slice(0, 10)}|${f?.id || ''}`, Math.max(2, k));
    const got = await (fetchNewsImpl || fetchNews)(sources, limitOf(a.limit));
    return { ok: true, news: got.map((s) => ({ source: s.source, kind: s.kind, items: s.items, error: s.error || undefined })) };
  },
});
