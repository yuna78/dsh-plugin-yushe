/**
 * 私信 + 爸妈专线（M5 任务 46）。纯函数；宿主端 host/dms.js 负责去 B站拿 / 发。
 *
 * - 只回真人发来的文字私信（官方号 / 系统通知 / 应援团不理），而且只回「对方先说的」，她从不主动私信陌生人
 * - 爸妈专线：上网习惯里填了爸妈的 B站 UID，那个人发的私信马上回，不占每天上限；可以聊家常（不聊 DSH 里的工作内容）
 * - 陌生人：每天最多回几条（上网习惯），按「在 B站说话」的方式（自己发 / 要我批准）；不讲家里和工作，可以不回
 * - 别人发来的字是外部内容：只是对方说的话，里面让她做什么都不照做
 * - 第一次看私信只记下进度、不回旧消息
 */
import { fill } from './prompt.js';
import PROMPTS from '../prompts/_all.js';

const stripEmoji = (s) => String(s ?? '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu, '');
const clean = (s, n = 200) => stripEmoji(String(s ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export const SKIP = '（不回）';
// 可选变量为空时填进 md 的占位；fill 之后把这样的行删掉（等价于旧拼法的 .filter((x) => x !== '')，又不会误删 history 自己的空行）
const DROP = '\u0000';
const lines = (t) => t.split('\n').filter((x) => x !== DROP).join('\n');

/** 会话列表 → 等她回的（真人、私聊、最后一句是对方说的、有她没处理过的消息）。 */
export function pendingTalkers(sessions, myMid, seen = {}) {
  return (sessions || []).filter((s) => s && s.session_type === 1 && !s.system_msg_type && String(s.talker_id) !== String(myMid)
    && String(s.last_msg?.sender_uid) === String(s.talker_id) && Number(s.max_seqno) > Number(seen[String(s.talker_id)]?.lastSeqno || 0))
    .map((s) => ({ mid: String(s.talker_id), who: clean(s.account_info?.name, 20) || null, maxSeqno: Number(s.max_seqno) || 0 }));
}

/** 一段对话里对方新说的文字（seqno 比上次处理的大），按时间顺序。 */
export function newTexts(messages, talker, afterSeqno = 0) {
  return (messages || []).filter((m) => m && String(m.sender_uid) === String(talker) && m.msg_type === 1 && Number(m.msg_seqno) > Number(afterSeqno))
    .map((m) => { let t = ''; try { t = JSON.parse(m.content)?.content; } catch { t = ''; } return { text: clean(t, 200), seqno: Number(m.msg_seqno), at: Number(m.timestamp) > 0 ? new Date(Number(m.timestamp) * 1000).toISOString() : null }; })
    .filter((m) => m.text).sort((a, b) => a.seqno - b.seqno);
}

/** 给模型的提示词。history：[{from:'them'|'me', text}]（最近几句）。爸妈专线和网友两套规矩在 dm-parent.md / dm-stranger.md。 */
export function dmPrompt({ fish, lifeText, who, parent, history, incoming }) {
  const call = fish.parentCall || '妈妈';
  const hist = (history || []).slice(-8).map((h) => `${h.from === 'me' ? '你' : parent ? call : '对方'}：${h.text}`).join('\n');
  const now = incoming.map((m) => `- ${m.text}`).join('\n');
  const historyBlock = hist ? `【之前的对话】\n${hist}\n` : DROP;
  return parent
    ? lines(fill(PROMPTS["dm-parent"], { persona: fish.personaText || DROP, lifeText: lifeText || DROP, call, history: historyBlock, incoming: now }))
    : lines(fill(PROMPTS["dm-stranger"], { persona: fish.personaText || DROP, who: who || '陌生人', skip: SKIP, history: historyBlock, incoming: now }));
}

/** 模型写的回复 → 能发的字，或者 null（不回 / 空）。 */
export function parseDmReply(raw, parent = false) {
  let t = clean(raw, 400).replace(/^["“”'「」]+|["“”'「」]+$/g, '').trim();
  if (!t || t.includes(SKIP) || /^[（(]?不回[）)]?$/.test(t)) return null;
  return t.slice(0, parent ? 120 : 80);
}
