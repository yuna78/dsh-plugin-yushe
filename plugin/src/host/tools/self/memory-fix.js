// 四期-3 I · 爸妈说「你记错了，其实是……」：和配置三件套一样两步走。第一次只起草（复述 + proposalId），
// 爸妈说对了再带 proposalId + confirm=true 才真的改。规则都在 shared/memory.js（fixBelief），这里只传话。
import { defineTool, NO_FISH } from '../define.js';

export default defineTool({
  name: 'yushe_memory_fix',
  kind: 'self',
  expose: { main: true, room: true, trip: false }, // 主会话和鱼社房间都能办；出门（trip）别动家里记的东西
  description: '爸妈说「你记错了，其实是……」时用来纠正认识（B 开头）或爸妈让记的嘱咐（T 开头），一律两步：**第一次只调 target + text 起草，先不写**。起草返回 proposalId，还有原来记的（before）和新说法（after）——把它用大白话复述给爸妈（比如「原来记的是『……』，改成『……』，对吗」），**爸妈说对了**，再调一次：带上 proposalId 和 confirm=true，这时才真的改。只改爸妈明确说的那条，别自己挑；拿不准是哪条先用 yushe_recall 查编号。经历（M 开头）改不了：让她忘掉这条，再记一条对的。proposalId 30 分钟有效、只能用一次。办完用一句带自己口吻的话告诉爸妈改了什么（比如「原来是这么记的呀，那错了的这条扔掉啦」）。改完页面会标「纠正过」，旧说法不再出现、新的说法记住了。',
  params: {
    target: { type: 'string', description: '要改的那条的编号（B 开头 = 认识，T 开头 = 爸妈让记的；从 yushe_recall 或 list 里看）' },
    text: { type: 'string', description: '爸妈说的正确说法，照爸妈的原意，别添油加醋' },
    proposalId: { type: 'string', description: '上次起草返回的 proposalId（爸妈说对了才带）' },
    confirm: { type: 'boolean', description: '爸妈听完复述、说记的对了，才设 true' },
  },
  async run(a, { pond, life, memory }) {
    const f = pond.current(); if (!f) return NO_FISH;
    if (!memory) return { ok: false, error: '记忆还没准备好' };
    const confirmStep = a.proposalId != null && a.proposalId !== '' || a.confirm != null; // 带了单号或者带了 confirm：按确认这一步办
    if (confirmStep) {
      if (a.confirm !== true) return { ok: false, needsConfirmation: true, error: '还没有真的改成。要爸妈在这次对话里听完复述、明确说记的是对的，再设 confirm=true 调一次。' };
      const r = memory.applyFix(f, a.proposalId);
      if (!r.ok) return { ok: false, error: r.why };
      life?.record?.(f, 'told', `${f.parentCall}纠正本鱼一处记错的（${r.kind}）：「${String(r.text ?? '').slice(0, 20)}」`, {});
      return { ok: true, fixed: r.text, id: r.id, ...(r.fixedAt ? { fixedAt: r.fixedAt } : {}), hint: '改好了，以后按新的说；旧的那个说法不再提了' };
    }
    const r = memory.propose(f, 'fix', a.target, a.text);
    if (!r.ok) return { ok: false, error: r.why };
    return { ok: true, proposalId: r.proposalId, before: r.before, after: r.after, next: '还没改。把原来记的（before）和爸妈说的（after）用大白话复述给爸妈，说的对就再调一次 yushe_memory_fix，带上这个 proposalId 和 confirm=true；说错了就重新起草一份。' };
  },
});
