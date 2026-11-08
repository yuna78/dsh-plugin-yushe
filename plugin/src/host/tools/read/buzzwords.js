// R12 · 热搜词
import { defineTool } from '../define.js';
import { readyFor, limitOf, clean } from '../bili-common.js';

export default defineTool({
  name: 'bili_buzzwords',
  kind: 'read',
  external: true,
  description: '看 B站热搜词（大家现在在搜什么）。想找话题、看今天流行什么梗时用。只读。',
  params: { limit: { type: 'integer', description: '最多几个（默认 10，最多 10）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/wbi/search/square', wbi: true }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead, { login: false }); if (no) return no;
    const d = await biliRead.raw('/x/web-interface/wbi/search/square', { limit: 10 }, { signed: true });
    return { ok: true, words: (d?.trending?.list || []).slice(0, limitOf(a.limit, 10, 10)).map((w) => clean(w.show_name || w.keyword, 30)).filter(Boolean), usage: biliRead.usage() };
  },
});
