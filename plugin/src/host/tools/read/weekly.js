// R9 · 每周必看
import { defineTool } from '../define.js';
import { readyFor, limitOf, clean, vidOf, okBv } from '../bili-common.js';

export default defineTool({
  name: 'bili_weekly',
  kind: 'read',
  external: true,
  description: '看 B站「每周必看」：不给 number 就是最新一期（期号、主题、视频列表）。想知道这周大家公认的好视频时用。不用登录。只读。',
  params: { number: { type: 'integer', description: '第几期（不给 = 最新）' }, limit: { type: 'integer', description: '最多几条（默认 10，最多 20）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/popular/series/list' }, { host: 'api', method: 'GET', path: '/x/web-interface/popular/series/one' }],
  readCost: 2,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead, { login: false }); if (no) return no;
    let num = Number(a.number) || 0;
    if (!num) num = Number((await biliRead.raw('/x/web-interface/popular/series/list'))?.list?.[0]?.number) || 0;
    if (!num) return { ok: false, error: '拿不到每周必看的期号' };
    const d = await biliRead.raw('/x/web-interface/popular/series/one', { number: num });
    return { ok: true, number: num, subject: clean(d?.config?.subject || d?.config?.label, 40), videos: (d?.list || []).filter((v) => okBv(v.bvid)).slice(0, limitOf(a.limit, 10, 20)).map((v) => vidOf(v, { why: clean(v.rcmd_reason, 30) })), usage: biliRead.usage() };
  },
});
