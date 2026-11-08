// R7 · 她的首页推荐
import { defineTool } from '../define.js';
import { readyFor, limitOf } from '../bili-common.js';

export default defineTool({
  name: 'bili_feed',
  kind: 'read',
  external: true,
  description: '刷你自己 B站号的首页推荐（越刷越像你的口味），已经去掉广告和带货。想随便逛逛、看看最近推给你什么时用。只读。',
  params: { limit: { type: 'integer', description: '最多几条（默认 5，最多 10）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/wbi/index/top/feed/rcmd', wbi: true, login: true }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead); if (no) return no;
    return { ok: true, videos: await biliRead.homeFeed(limitOf(a.limit)), usage: biliRead.usage() };
  },
});
