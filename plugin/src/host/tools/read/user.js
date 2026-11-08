// R13 · 用户信息
import { defineTool } from '../define.js';
import { readyFor, clean, okMid } from '../bili-common.js';

export default defineTool({
  name: 'bili_user',
  kind: 'read',
  external: true,
  description: '看一个 B站用户（UP 主）的信息：名字、签名、粉丝数、关注数、投稿数、等级。给数字 id（mid）。想了解一个 UP 主、决定要不要关注之前用。只读。',
  params: { mid: { type: 'string', description: '用户的数字 id', required: true } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/card' }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead, { login: false }); if (no) return no;
    if (!okMid(a.mid)) return { ok: false, error: 'mid 要是一串数字' };
    const d = await biliRead.raw('/x/web-interface/card', { mid: a.mid, photo: 'false' });
    const c = d?.card || {};
    return { ok: true, user: { mid: String(a.mid), name: clean(c.name, 30), sign: clean(c.sign, 100), fans: Number(d?.follower ?? c.fans) || 0, following: Number(c.attention) || 0, videos: Number(d?.archive_count) || 0, level: c.level_info?.current_level ?? null, url: `https://space.bilibili.com/${a.mid}` }, usage: biliRead.usage() };
  },
});
