// A4 · 关注 UP 主
import { defineTool } from '../define.js';
import { writeReadyFor, clean, okMid, sentReceipt } from '../bili-common.js';

const CAP = { key: 'followsPerDay', label: '每天最多关注几个 UP 主', levels: { 少: 1, 适中: 2, 多: 4 }, max: 10 };

export default defineTool({
  name: 'bili_follow',
  kind: 'act',
  description: '用你自己的 B站号关注一个 UP 主（给数字 id，mid）。想关注谁由你自己决定；只是每天关注几个有节奏（别一下子关注太多，B站会风控）。关注了会记进你的足迹和「你自己关注的」名单（只有这名单里的以后能取关）。',
  params: { mid: { type: 'string', description: 'UP 主的数字 id', required: true } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/card' }, { host: 'api', method: 'POST', path: '/x/relation/modify', login: true, csrf: true }],
  readCost: 1,
  cap: CAP,
  receipt: sentReceipt,
  perPerson: true,
  footprint: true,
  async run(a, deps) {
    const no = writeReadyFor(deps); if (no) return no;
    const { biliRead, biliWrite, acts } = deps;
    const mid = String(a.mid || '');
    if (!okMid(mid)) return { ok: false, error: 'mid 要是一串数字' };
    if (mid === String(biliRead.myMid())) return { ok: false, error: '不能关注自己' };
    if (acts.follows()[mid]) return { ok: true, already: true, hint: '已经关注了' };
    const card = await biliRead.raw('/x/web-interface/card', { mid, photo: 'false' }).catch(() => null);
    const who = clean(card?.card?.name, 30) || `UP ${mid}`;
    return acts.act('follow', {
      cap: CAP, mid, receipt: sentReceipt, already: [22014],
      run: () => biliWrite.raw('/x/relation/modify', { fid: mid, act: 1, re_src: 11 }, { referer: `https://space.bilibili.com/${mid}` }),
      footprint: { text: who, url: `https://space.bilibili.com/${mid}`, target: { mid, who } },
    });
  },
});
