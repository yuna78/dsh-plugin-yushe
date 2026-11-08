// T3 · 评论别人的动态
import { defineTool } from '../define.js';
import { dynOf, replyOf, sentReceipt } from '../bili-common.js';
import { createLedger } from '../../../shared/evidence.js';
import { speak, speakReady } from '../speak-common.js';

const CAP = { key: 'dynCommentsPerDay', label: '每天最多评论几条动态', levels: { 少: 1, 适中: 3, 多: 6 }, max: 10 };

export default defineTool({
  name: 'bili_dynamic_comment',
  kind: 'speak',
  perPerson: true,
  description: '在别人的 B站动态下面评论（给动态 id）。刷关注动态看到想接话的时候用。DSH 里爸妈让你评论：给一句 intent，正文你自己在鱼社里写，再过规矩。同一条动态只评论一次，每天有上限，对同一个人每天也有上限。',
  params: { dynamicId: { type: 'string', description: '动态 id', required: true }, intent: { type: 'string', description: '想说的方向（一句话，≤ 40 字）', required: true } },
  tripParams: { dynamicId: { type: 'string', description: '动态 id', required: true }, text: { type: 'string', description: '你要发的评论（2–80 字）', required: true } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/polymer/web-dynamic/v1/detail' }, { host: 'api', method: 'GET', path: '/x/v2/reply/main' }, { host: 'api', method: 'POST', path: '/x/v2/reply/add', login: true, csrf: true }],
  readCost: 2,
  cap: CAP,
  draft: { kind: 'dyncomment', name: '动态评论', min: 2, max: 80 },
  receipt: sentReceipt,
  async send(d, { biliWrite }) {
    const t = d.target || {};
    const r = await biliWrite.raw('/x/v2/reply/add', { type: t.type, oid: t.oid, message: d.text, plat: 1 }, { referer: `https://t.bilibili.com/${t.dynamicId}` });
    if (r.status === 'sent') r.url = `https://t.bilibili.com/${t.dynamicId}`;
    return r;
  },
  async run(a, deps, { from }) {
    const no = speakReady(deps); if (no) return no;
    const { biliRead } = deps;
    if (!/^\d{1,30}$/.test(String(a.dynamicId || ''))) return { ok: false, error: '动态 id 要是一串数字' };
    const dyn = dynOf((await biliRead.raw('/x/polymer/web-dynamic/v1/detail', { id: a.dynamicId }))?.item);
    if (!dyn.comment) return { ok: false, error: '这条动态拿不到评论区' };
    if (dyn.mid && dyn.mid === String(biliRead.myMid())) return { ok: false, error: '这是你自己的动态' };
    const hot = await biliRead.raw('/x/v2/reply/main', { type: dyn.comment.type, oid: dyn.comment.oid, mode: 3, next: 0 }).then((r) => (r?.replies || []).slice(0, 3).map(replyOf)).catch(() => []);
    const ledger = from === 'trip' ? null : createLedger();
    if (ledger && dyn.video) ledger.note('bili_video', { bvid: dyn.video.bvid }, { ok: true });
    const material = [`${dyn.who} 的动态：${dyn.text || '（没有文字）'}`, dyn.video ? `带的视频：《${dyn.video.title}》` : '', ...hot.map((c) => `评论（${c.user}）：${c.text}`)];
    return speak(deps, from, { kind: 'dyncomment', what: `评论 ${dyn.who || '一位 UP 主'} 的动态`, max: 80, args: a, material, ledger, bvid: dyn.video?.bvid || null,
      target: { key: `dyn:${a.dynamicId}`, dynamicId: String(a.dynamicId), type: dyn.comment.type, oid: dyn.comment.oid, mid: dyn.mid, who: dyn.who, title: (dyn.text || '').slice(0, 40) } });
  },
});
