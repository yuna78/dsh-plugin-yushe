// T1 · 评论视频：主会话只给意图（她自己写），出门直接给 text
import { defineTool } from '../define.js';
import { viewOf, clean, replyOf, cidOf, sentReceipt } from '../bili-common.js';
import { createLedger } from '../../../shared/evidence.js';
import { speak, speakReady } from '../speak-common.js';

const CAP = { key: 'commentsPerDay', label: '每天最多评论几条', levels: { 少: 2, 适中: 6, 多: 12 }, max: 20 };

/** 写评论用的公开资料：标题、简介、标签、热评、（有就）字幕开头。顺便记读账。 */
export async function videoMaterial(biliRead, bvid, ledger) {
  const v = await viewOf(biliRead, bvid);
  ledger.note('bili_video', { bvid: v.bvid }, { ok: true });
  const tags = await biliRead.raw('/x/tag/archive/tags', { bvid: v.bvid }).then((d) => (d || []).map((t) => clean(t.tag_name, 12)).slice(0, 6)).catch(() => []);
  const hot = v.aid ? await biliRead.raw('/x/v2/reply/main', { type: 1, oid: v.aid, mode: 3, next: 0 }).then((d) => (d?.replies || []).slice(0, 3).map(replyOf)).catch(() => []) : [];
  let sub = '';
  try {
    const p = await biliRead.raw('/x/player/wbi/v2', { bvid: v.bvid, cid: cidOf(v) }, { signed: true });
    const pick = (p?.subtitle?.subtitles || []).find((x) => /^zh|ai-zh/.test(x.lan)) || p?.subtitle?.subtitles?.[0];
    if (pick?.subtitle_url) { sub = (await biliRead.subtitleFile(pick.subtitle_url)).map((l) => l.content).join(' ').slice(0, 500); if (sub) ledger.note('bili_subtitle', { bvid: v.bvid }, { ok: true, has: true }); }
  } catch { /* 没字幕就不用 */ }
  return { v, material: [`视频：《${clean(v.title, 60)}》（UP 主：${clean(v.owner?.name, 20)}）`, v.desc ? `简介：${clean(v.desc, 120)}` : '', tags.length ? `标签：${tags.join('、')}` : '', ...hot.map((c) => `热评（${c.user}）：${c.text}`), sub ? `字幕开头：${sub}` : '（没有字幕）'] };
}

export default defineTool({
  name: 'bili_comment',
  kind: 'speak',
  description: '用你自己的 B站号在一个视频下面发评论。在 DSH 里爸妈让你评论时：给 bvid 和一句 intent（想说的方向，比如「夸夸配乐」），正文由你在鱼社里自己写（不会带上这里聊的内容），再过鱼社的规矩；默认按发言间隔自己发，「要我批准」模式下寄到信箱。同一个视频只评论一次，每天有上限。',
  params: { bvid: { type: 'string', description: 'BV 号', required: true }, intent: { type: 'string', description: '想说的方向（一句话，≤ 40 字），不是正文', required: true } },
  tripParams: { bvid: { type: 'string', description: 'BV 号', required: true }, text: { type: 'string', description: '你要发的评论（2–80 字）', required: true } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/view' }, { host: 'api', method: 'GET', path: '/x/tag/archive/tags' }, { host: 'api', method: 'GET', path: '/x/v2/reply/main' }, { host: 'api', method: 'GET', path: '/x/player/wbi/v2', wbi: true }],
  readCost: 5,
  cap: CAP,
  draft: { kind: 'comment', name: '评论', min: 2, max: 80 },
  receipt: sentReceipt,
  async run(a, deps, { from }) {
    const no = speakReady(deps); if (no) return no;
    const ledger = from === 'trip' ? null : createLedger();
    let v, material = [];
    if (from === 'trip') v = await viewOf(deps.biliRead, String(a.bvid || ''));
    else ({ v, material } = await videoMaterial(deps.biliRead, String(a.bvid || ''), ledger));
    return speak(deps, from, { kind: 'comment', what: `给视频《${clean(v.title, 40)}》写一条评论`, max: 80, args: a, material, ledger, bvid: v.bvid, target: { bvid: v.bvid, aid: v.aid, title: clean(v.title, 60) } });
  },
});
