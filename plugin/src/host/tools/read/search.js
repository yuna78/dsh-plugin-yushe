// R1 · 搜视频 / 搜用户
import { defineTool } from '../define.js';
import { readyFor, limitOf, clean, vidOf, okBv } from '../bili-common.js';

const ORDER = { 综合: 'totalrank', 播放: 'click', 最新: 'pubdate', 弹幕: 'dm' };

export default defineTool({
  name: 'bili_search',
  kind: 'read',
  external: true,
  description: '用你自己的 B站号搜东西：type=video 搜视频（标题、BV 号、UP 主、播放量、分区），type=user 搜 UP 主（名字、mid、粉丝数、签名）；order 可以按综合 / 播放 / 最新 / 弹幕排。爸妈让你「去 B站搜一下」或者你出门想找某类内容时用。只读；一天有读取次数上限，遇到风控会暂停一会儿。',
  params: { keyword: { type: 'string', description: '搜什么', required: true }, type: { type: 'string', enum: ['video', 'user'], description: '搜视频还是搜 UP 主（默认 video）' }, order: { type: 'string', enum: Object.keys(ORDER), description: '视频怎么排（默认综合）' }, limit: { type: 'integer', description: '最多几条（默认 5，最多 10）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/wbi/search/type', wbi: true }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead, { login: false }); if (no) return no;
    const n = limitOf(a.limit);
    const kw = clean(a.keyword, 40); if (!kw) return { ok: false, error: '要给关键词' };
    if (a.type === 'user') {
      const d = await biliRead.raw('/x/web-interface/wbi/search/type', { search_type: 'bili_user', keyword: kw, page: 1 }, { signed: true });
      return { ok: true, users: (d?.result || []).slice(0, n).map((u) => ({ mid: String(u.mid), name: clean(u.uname, 30), fans: u.fans || 0, videos: u.videos || 0, sign: clean(u.usign, 80), url: `https://space.bilibili.com/${u.mid}` })), usage: biliRead.usage() };
    }
    if (!a.order || a.order === '综合') return { ok: true, videos: await biliRead.search(kw, n), usage: biliRead.usage() };
    const d = await biliRead.raw('/x/web-interface/wbi/search/type', { search_type: 'video', keyword: kw, page: 1, order: ORDER[a.order] || 'totalrank' }, { signed: true });
    return { ok: true, videos: (d?.result || []).filter((v) => okBv(v.bvid)).slice(0, n).map((v) => vidOf({ ...v, owner: { name: v.author, mid: v.mid }, tname: v.typename, stat: { view: v.play } })), usage: biliRead.usage() };
  },
});
