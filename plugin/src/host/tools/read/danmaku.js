// R6 · 弹幕抽样（高频词 + 若干条）
import { defineTool } from '../define.js';
import { readyFor, viewOf, cidOf, clean, depthAllows } from '../bili-common.js';

/** xml → 弹幕文字。 */
export function parseDanmaku(xml) {
  return [...String(xml || '').matchAll(/<d [^>]*>([\s\S]*?)<\/d>/g)].map((m) => clean(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), 60)).filter(Boolean);
}
/** 高频的弹幕（同一句刷屏的算一条）。 */
export function topDanmaku(list, k = 10) {
  const count = new Map();
  for (const t of list) count.set(t, (count.get(t) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([text, n]) => ({ text, n }));
}

export default defineTool({
  name: 'bili_danmaku',
  kind: 'read',
  external: true,
  description: '看一个 B站视频的弹幕：刷得最多的 10 句（带次数）+ 随手抽 20 条。想知道看的人在哪儿笑、在刷什么梗时用。给 BV 号，多 P 的给 page。只读。',
  params: { bvid: { type: 'string', description: 'BV 号', required: true }, page: { type: 'integer', description: '第几 P（默认 1）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/view' }, { host: 'api', method: 'GET', path: '/x/v1/dm/list.so' }],
  readCost: 2,
  async run(a, { biliRead, habits }, { from }) {
    const no = readyFor(biliRead); if (no) return no;
    if (!depthAllows(habits, 'danmaku', from)) return { ok: false, error: '爸妈设置的是不看弹幕（读多深）' };
    const v = await viewOf(biliRead, String(a.bvid || ''));
    const cid = cidOf(v, a.page);
    if (!cid) return { ok: false, error: '拿不到这一 P 的 id' };
    const list = parseDanmaku(await biliRead.rawText('/x/v1/dm/list.so', { oid: cid }));
    const step = Math.max(1, Math.floor(list.length / 20));
    return { ok: true, title: v.title, bvid: v.bvid, total: list.length, top: topDanmaku(list), sample: list.filter((_, i) => i % step === 0).slice(0, 20), usage: biliRead.usage() };
  },
});
