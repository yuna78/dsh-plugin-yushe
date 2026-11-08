// T2 · 回复一条评论（视频下 / 动态下，含回她的人）
import { defineTool } from '../define.js';
import { viewOf, clean, replyOf, okBv, sentReceipt } from '../bili-common.js';
import { createLedger } from '../../../shared/evidence.js';
import { speak, speakReady } from '../speak-common.js';

const CAP = { key: 'repliesPerDay', label: '每天最多回复几条评论', levels: { 少: 4, 适中: 12, 多: 20 }, max: 30 };

export default defineTool({
  name: 'bili_reply',
  kind: 'speak',
  perPerson: true,
  description: '回复 B站上的一条评论（视频评论给 bvid + rpid；动态下的评论给 oid + type + rpid，从 bili_dynamic 的 comment 字段拿）。有人在评论区回你、或者你想接一句别人的话时用。DSH 里爸妈让你回：给一句 intent（想回的方向），正文你自己在鱼社里写，再过规矩。同一条只回一次，每天有上限，对同一个人每天也有上限。',
  params: { rpid: { type: 'string', description: '要回的那条评论的 rpid', required: true }, bvid: { type: 'string', description: '视频评论：BV 号' }, oid: { type: 'string', description: '动态评论：评论区 id' }, type: { type: 'integer', description: '动态评论：评论区类型' }, intent: { type: 'string', description: '想回的方向（一句话，≤ 40 字）', required: true } },
  tripParams: { rpid: { type: 'string', description: '要回的那条评论的 rpid', required: true }, bvid: { type: 'string', description: '视频评论：BV 号' }, oid: { type: 'string', description: '动态评论：评论区 id' }, type: { type: 'integer', description: '动态评论：评论区类型' }, text: { type: 'string', description: '你要回的话（2–80 字）', required: true } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/view' }, { host: 'api', method: 'GET', path: '/x/v2/reply/detail' }, { host: 'api', method: 'POST', path: '/x/v2/reply/add', login: true, csrf: true }],
  readCost: 2,
  cap: CAP,
  draft: { kind: 'reply', name: '回复', min: 2, max: 80 },
  receipt: sentReceipt,
  /** 闸门放行后真的发。 */
  async send(d, { biliWrite }) {
    const t = d.target || {};
    const r = await biliWrite.raw('/x/v2/reply/add', { type: t.type, oid: t.oid, root: t.root, parent: t.parent, message: d.text, plat: 1 }, { referer: t.bvid ? `https://www.bilibili.com/video/${t.bvid}` : 'https://t.bilibili.com/' });
    if (r.status === 'sent') r.url = t.bvid ? `https://www.bilibili.com/video/${t.bvid}#reply${r.data?.rpid_str || r.data?.rpid || ''}` : t.url || null;
    return r;
  },
  async run(a, deps, { from }) {
    const no = speakReady(deps); if (no) return no;
    const { biliRead } = deps;
    if (!/^\d{1,20}$/.test(String(a.rpid || ''))) return { ok: false, error: 'rpid 不对' };
    let type = 1, oid = null, bvid = null, title = '';
    if (a.bvid && okBv(a.bvid)) { const v = await viewOf(biliRead, a.bvid); oid = String(v.aid); bvid = v.bvid; title = clean(v.title, 40); }
    else if (/^\d{1,20}$/.test(String(a.oid || ''))) { oid = String(a.oid); type = Number(a.type) || 1; }
    if (!oid) return { ok: false, error: '要给 bvid，或者 oid + type' };
    const det = await biliRead.raw('/x/v2/reply/detail', { type, oid, root: a.rpid });
    const c = det?.root;
    if (!c) return { ok: false, error: '找不到这条评论' };
    const mid = c.member?.mid ? String(c.member.mid) : null;
    if (mid && mid === String(biliRead.myMid())) return { ok: false, error: '这是你自己的评论' };
    const root = Number(c.root) ? String(c.root) : String(a.rpid);
    const ledger = from === 'trip' ? null : createLedger();
    if (ledger && bvid) ledger.note('bili_comments', { bvid }, { ok: true });
    const material = [title ? `视频：《${title}》` : '一条动态下面的评论', `${clean(c.member?.uname, 20)} 说：${clean(c.content?.message, 160)}`, ...(det?.replies || c.replies || []).slice(0, 5).map(replyOf).map((r) => `楼里（${r.user}）：${r.text}`)];
    return speak(deps, from, { kind: 'reply', what: `回复 ${clean(c.member?.uname, 20) || '一位网友'} 的评论`, max: 80, args: a, material, ledger, bvid,
      target: { key: `reply:${oid}:${a.rpid}`, type, oid, root, parent: String(a.rpid), mid, who: clean(c.member?.uname, 20), bvid, title } });
  },
});
