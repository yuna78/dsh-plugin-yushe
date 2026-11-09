// R20 · 收件箱：回复 / @ / 点赞 / 未读
import { defineTool } from '../define.js';
import { readyFor, limitOf, clean, isoOf, safeBiliUrl } from '../bili-common.js';

export default defineTool({
  name: 'bili_inbox',
  kind: 'read',
  external: true,
  description: '直接去 B站看你的消息：what=回复（谁回了你什么）、@（谁 @ 了你）、点赞（谁赞了你哪条）、未读（各有几条没看）。和 yushe_recall inbox（鱼社记下来的）不同，这个是 B站上现在的。只读，不会把消息标成已读。',
  params: { what: { type: 'string', enum: ['回复', '@', '点赞', '未读'], description: '看哪一类', required: true }, limit: { type: 'integer', description: '最多几条（默认 10，最多 20）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/msgfeed/reply', login: true }, { host: 'api', method: 'GET', path: '/x/msgfeed/at', login: true }, { host: 'api', method: 'GET', path: '/x/msgfeed/like', login: true }, { host: 'api', method: 'GET', path: '/x/msgfeed/unread', login: true }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead); if (no) return no;
    const n = limitOf(a.limit, 10, 20);
    if (a.what === '未读') return { ok: true, unread: await biliRead.unread(), usage: biliRead.usage() };
    if (a.what === '回复') return { ok: true, items: await biliRead.repliesToMe(n), usage: biliRead.usage() };
    if (a.what === '点赞') return { ok: true, items: await biliRead.likesToMe(n), usage: biliRead.usage() };
    if (a.what === '@') {
      const d = await biliRead.raw('/x/msgfeed/at', { platform: 'web', build: 0, mobi_app: 'web' }, { kind: 'interact' });
      return { ok: true, items: (d?.items || []).slice(0, n).map((x) => ({ who: clean(x.user?.nickname, 20) || '有人', mid: x.user?.mid ? String(x.user.mid) : null, text: clean(x.item?.source_content, 140), where: clean(x.item?.title, 60), url: safeBiliUrl(x.item?.uri), at: isoOf(x.at_time) })), usage: biliRead.usage() };
    }
    return { ok: false, error: 'what 只能是 回复 / @ / 点赞 / 未读' };
  },
});
