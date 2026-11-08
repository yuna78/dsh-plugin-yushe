// R5 · 字幕全文（截到细配置 subtitleChars）
import { defineTool } from '../define.js';
import { readyFor, viewOf, cidOf, depthAllows } from '../bili-common.js';

export default defineTool({
  name: 'bili_subtitle',
  kind: 'read',
  external: true,
  expose: { main: true, trip: true, room: true }, // F-86：房间追问细节可以回去读字幕
  description: '读一个 B站视频的字幕（AI 字幕或 UP 主上传的），看视频里到底说了什么。给 BV 号，多 P 的给 page。字幕太长会截断（有字数上限）；没有字幕会直接说没有——那就别说自己知道视频内容。只读。',
  params: { bvid: { type: 'string', description: 'BV 号', required: true }, page: { type: 'integer', description: '第几 P（默认 1）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/view' }, { host: 'api', method: 'GET', path: '/x/player/wbi/v2', wbi: true, login: true }],
  readCost: 3,
  async run(a, { biliRead, habits }, { from }) {
    const no = readyFor(biliRead); if (no) return no;
    if (!depthAllows(habits, 'subtitle', from)) return { ok: false, error: '爸妈设置的是不看字幕（读多深）' };
    const max = habits?.get?.().subtitleChars ?? 1500;
    if (from === 'trip' && !max) return { ok: false, error: '爸妈设置的字幕字数是 0' };
    const limit = from === 'trip' ? max : Math.max(max, 1500);
    const v = await viewOf(biliRead, String(a.bvid || ''));
    const cid = cidOf(v, a.page);
    if (!cid) return { ok: false, error: '拿不到这一 P 的 id' };
    const p = await biliRead.raw('/x/player/wbi/v2', { bvid: v.bvid, cid }, { signed: true });
    const subs = p?.subtitle?.subtitles || [];
    const pick = subs.find((s) => /^zh|ai-zh/.test(s.lan)) || subs[0];
    if (!pick?.subtitle_url) return { ok: true, has: false, title: v.title, hint: '这个视频没有字幕（或者要登录才看得到），不知道视频里具体说了什么' };
    const lines = await biliRead.subtitleFile(pick.subtitle_url);
    let text = '', cut = false;
    for (const l of lines) { if (text.length + l.content.length + 1 > limit) { cut = true; break; } text += (text ? ' ' : '') + l.content; }
    return { ok: true, has: true, title: v.title, bvid: v.bvid, lang: pick.lan_doc || pick.lan, text, cut, chars: text.length, usage: biliRead.usage() };
  },
});
