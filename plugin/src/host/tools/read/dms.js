// R21 · 私信：会话列表 / 和某人最近的消息
import { defineTool } from '../define.js';
import { readyFor, limitOf, clean, isoOf, okMid } from '../bili-common.js';

export default defineTool({
  name: 'bili_dms',
  kind: 'read',
  external: true,
  description: '直接去 B站看你的私信：不给 mid 就是会话列表（谁、最后一句、有没有没看的）；给 mid 就是和这个人最近的消息（谁说的、说了什么）。只看真人发来的文字，官方号和系统通知不算。只读，不回复（回私信鱼社会自己按规矩处理）。',
  params: { mid: { type: 'string', description: '对方的数字 id（不给 = 会话列表）' }, limit: { type: 'integer', description: '最多几条（默认 10，最多 20）' } },
  endpoints: [{ host: 'vc', method: 'GET', path: '/session_svr/v1/session_svr/get_sessions', login: true }, { host: 'vc', method: 'GET', path: '/svr_sync/v1/svr_sync/fetch_session_msgs', login: true }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead); if (no) return no;
    const n = limitOf(a.limit, 10, 20);
    const me = String(biliRead.myMid() || '');
    const textOf = (m) => { try { return clean(JSON.parse(m.content)?.content, 160); } catch { return ''; } };
    if (!a.mid) {
      const list = (await biliRead.dmSessions()).filter((s) => s?.session_type === 1 && !s.system_msg_type);
      return { ok: true, sessions: list.slice(0, n).map((s) => ({ mid: String(s.talker_id), who: clean(s.account_info?.name, 20) || null, last: s.last_msg?.msg_type === 1 ? textOf(s.last_msg) : '（不是文字）', lastFromThem: String(s.last_msg?.sender_uid) === String(s.talker_id), unread: Number(s.unread_count) || 0, at: isoOf(s.session_ts ? Math.floor(s.session_ts / 1e6) : s.last_msg?.timestamp) })), usage: biliRead.usage() };
    }
    if (!okMid(a.mid)) return { ok: false, error: 'mid 要是一串数字' };
    const msgs = (await biliRead.dmMessages(String(a.mid), 30)).filter((m) => m?.msg_type === 1).sort((x, y) => Number(x.msg_seqno) - Number(y.msg_seqno)).slice(-n);
    return { ok: true, mid: String(a.mid), messages: msgs.map((m) => ({ from: String(m.sender_uid) === me ? '你' : '对方', text: textOf(m), at: isoOf(m.timestamp) })).filter((m) => m.text), usage: biliRead.usage() };
  },
});
