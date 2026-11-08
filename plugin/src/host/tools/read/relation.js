// R15 · 她和某人的关系
import { defineTool } from '../define.js';
import { readyFor, okMid } from '../bili-common.js';

const REL = { 0: '没关注', 1: '悄悄关注', 2: '关注了', 6: '互相关注', 128: '拉黑了' };

export default defineTool({
  name: 'bili_relation',
  kind: 'read',
  external: true,
  description: '看你（她的 B站号）和某个人的关系：你关注了 TA 没、TA 关注你没、是不是互关。给对方的数字 id（mid）。关注 / 取关之前先看一眼时用。只读。',
  params: { mid: { type: 'string', description: '对方的数字 id', required: true } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/space/wbi/acc/relation', wbi: true, login: true }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead); if (no) return no;
    if (!okMid(a.mid)) return { ok: false, error: 'mid 要是一串数字' };
    if (String(a.mid) === String(biliRead.myMid())) return { ok: true, self: true, hint: '这就是你自己' };
    const d = await biliRead.raw('/x/space/wbi/acc/relation', { mid: a.mid }, { signed: true });
    const mine = Number(d?.relation?.attribute) || 0, theirs = Number(d?.be_relation?.attribute) || 0;
    return { ok: true, mid: String(a.mid), you: REL[mine] || '没关注', them: theirs === 2 || theirs === 6 ? '关注了你' : '没关注你', mutual: mine === 6 || (mine === 2 && (theirs === 2 || theirs === 6)), usage: biliRead.usage() };
  },
});
