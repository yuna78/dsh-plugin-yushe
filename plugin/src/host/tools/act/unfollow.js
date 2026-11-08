// A5 · 取关（只能取关她自己关注的）
import { defineTool } from '../define.js';
import { writeReadyFor, okMid, sentReceipt } from '../bili-common.js';

const CAP = { key: 'unfollowsPerDay', label: '每天最多取关几个', levels: { 少: 0, 适中: 1, 多: 2 }, max: 5 };

export default defineTool({
  name: 'bili_unfollow',
  kind: 'act',
  description: '取关一个 UP 主（给数字 id，mid）。**只能取关你自己用 bili_follow 关注的人**（换过号、或者以前别的方式关注的取关不了）；每天有上限。不再喜欢了、或者爸妈让你取关时用。',
  params: { mid: { type: 'string', description: 'UP 主的数字 id', required: true } },
  endpoints: [{ host: 'api', method: 'POST', path: '/x/relation/modify', login: true, csrf: true }],
  cap: CAP,
  receipt: sentReceipt,
  perPerson: true,
  footprint: true,
  async run(a, deps) {
    const no = writeReadyFor(deps); if (no) return no;
    const { biliWrite, acts } = deps;
    const mid = String(a.mid || '');
    if (!okMid(mid)) return { ok: false, error: 'mid 要是一串数字' };
    const mine = acts.follows()[mid];
    if (!mine) return { ok: false, error: '这个人不在你自己关注的名单里，取关不了（只能取关你自己关注的）' };
    return acts.act('unfollow', {
      cap: CAP, mid, receipt: sentReceipt,
      run: () => biliWrite.raw('/x/relation/modify', { fid: mid, act: 2, re_src: 11 }, { referer: `https://space.bilibili.com/${mid}` }),
      footprint: { text: mine.who || `UP ${mid}`, url: `https://space.bilibili.com/${mid}`, target: { mid, who: mine.who } },
    });
  },
});
