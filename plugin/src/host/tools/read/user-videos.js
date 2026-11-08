// R14 · UP 主的投稿（最新 / 最多播放）
import { defineTool } from '../define.js';
import { readyFor, limitOf, okMid, vidOf, okBv } from '../bili-common.js';

export default defineTool({
  name: 'bili_user_videos',
  kind: 'read',
  external: true,
  description: '看某个 UP 主发的视频：给数字 id（mid），order=最新 或 最多播放。想追一个常看的 UP 主有没有更新、或者看看他最火的是哪个时用。只读。',
  params: { mid: { type: 'string', description: 'UP 主的数字 id', required: true }, order: { type: 'string', enum: ['最新', '最多播放'], description: '默认最新' }, limit: { type: 'integer', description: '最多几条（默认 5，最多 10）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/space/wbi/arc/search', wbi: true }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead); if (no) return no;
    if (!okMid(a.mid)) return { ok: false, error: 'mid 要是一串数字' };
    const n = limitOf(a.limit);
    if (a.order !== '最多播放') return { ok: true, videos: await biliRead.upVideos(String(a.mid), n), usage: biliRead.usage() };
    const d = await biliRead.raw('/x/space/wbi/arc/search', { mid: a.mid, ps: Math.min(30, n), pn: 1, order: 'click' }, { signed: true });
    return { ok: true, videos: (d?.list?.vlist || []).filter((v) => okBv(v.bvid)).slice(0, n).map((v) => vidOf({ ...v, owner: { name: v.author, mid: a.mid }, stat: { view: v.play } })), usage: biliRead.usage() };
  },
});
