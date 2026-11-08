// R8 · 热门
import { defineTool } from '../define.js';
import { readyFor, limitOf } from '../bili-common.js';

export default defineTool({
  name: 'bili_hot',
  kind: 'read',
  external: true,
  description: '看 B站现在的热门视频（大家都在看什么）。不用登录。只读。',
  params: { limit: { type: 'integer', description: '最多几条（默认 8，最多 20）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/popular' }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead, { login: false }); if (no) return no;
    return { ok: true, videos: await biliRead.popular(limitOf(a.limit, 8, 20)), usage: biliRead.usage() };
  },
});
