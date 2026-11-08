// R10 · 分区排行榜
import { defineTool } from '../define.js';
import { readyFor, limitOf, vidOf, okBv, zoneRid, ZONES } from '../bili-common.js';

export default defineTool({
  name: 'bili_rank',
  kind: 'read',
  external: true,
  description: `看 B站排行榜：zone 给分区名（${ZONES.map(([n]) => n).join(' / ')}），不给就是全站。返回名次和视频。不用登录。只读。`,
  params: { zone: { type: 'string', description: '分区名（默认全站），分区表见 bili_zones' }, limit: { type: 'integer', description: '最多几条（默认 10，最多 20）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/ranking/v2' }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead, { login: false }); if (no) return no;
    const rid = zoneRid(a.zone);
    if (rid === null) return { ok: false, error: `没有这个分区，可以是：${ZONES.map(([n]) => n).join('、')}` };
    const d = await biliRead.raw('/x/web-interface/ranking/v2', { rid, type: 'all' });
    return { ok: true, zone: ZONES.find(([, r]) => r === rid)?.[0] || '全站', videos: (d?.list || []).filter((v) => okBv(v.bvid)).slice(0, limitOf(a.limit, 10, 20)).map((v, i) => vidOf(v, { rank: i + 1 })), usage: biliRead.usage() };
  },
});
