// S7 · 爸妈让她记住一件事 / 「不再提」「记牢」（四期-2 D/E）：规则查过才认；名字照任务书
import { defineTool, NO_FISH } from '../define.js';

const MARK_TIP = { mute: '不再提了，以后想起也不说', unmute: '接着照旧提', pin: '记牢了，不会忘', unpin: '不用记牢了，照旧慢慢糊涂' };

export default defineTool({
  name: 'yushe_remember',
  kind: 'self',
  expose: { main: true, trip: false, room: true }, // 四期-2 H：鱼社房间里爸妈说一句也能办
  description: '爸妈让你「记住」某件事时用：text 填爸妈要你记的那句话（用爸妈的原意，别添油加醋）。爸妈刚说完那件事还没有编号（刚说完、还没整理进记忆）时，不要硬找编号，只用 text 把它记成爸妈让记的。带日子、且是爸妈答应你的事（比如「周末陪你看电影」）→ promise 填 true，她会一直惦记着，到了那天爸妈来过就开心。爸妈在主会话里只是顺口说到带日子的安排（出差、考试、约了谁）时，可以问一句「要我记着吗」；拿不准就不问，别连着问。爸妈说「别再提 X」「这个别提了」→ 先用 yushe_recall 按 query 找到那条的编号（M 经历 / B 认识 / T 爸妈让的 / W 周记），再 mutate 参数 mute 填编号；想重新提用 unmute。爸妈说「这个记牢」「要一直记得」→ pin 填编号（M 或 B；T 本来就不忘不会接受）；想让记忆照旧糊涂用 unpin。mute / pin 一次只能办一条，别自己挑哪条改爸妈的意思；办完别报流水账，用你自己的口吻一句话告诉爸妈办了什么（例如「好，那我以后不提这个啦」）；拿不准爸妈说的是哪一条就先问清楚。爸妈让你忘掉某件，先 list 看编号再 forget——forget 只是起草、先不删：复述给爸妈、爸妈点头后用 yushe_memory_drop 带 proposalId 和 confirm=true 才真的忘。不记密码、号码、链接；问题和猜测不记。每天最多 5 件，最多同时记 20 件。记下的事只在跟爸妈说话时想得起来，对外不说。',
  params: {
    text: { type: 'string', description: '要记住的那句话（60 字以内）' },
    promise: { type: 'boolean', description: '爸妈答应你的事、而且带日子（比如「周末陪你看电影」「下周三一起吃饭」）才填 true：你会一直惦记着，到了那天爸妈来过就开心，没来会失落。爸妈让你办事、交代任务、普通嘱咐都不填' },
    mute: { type: 'string', description: '爸妈说「别再提」的那一条的编号（M / B / T / W，从 yushe_recall 或 list 里看）' },
    unmute: { type: 'string', description: '要重新提起来的一条的编号' },
    pin: { type: 'string', description: '爸妈说「这个记牢」的那条的编号（M 或 B）' },
    unpin: { type: 'string', description: '要松开的一条的编号（M 或 B）' },
    forget: { type: 'string', description: '要忘掉的那一条的编号（T 开头，从 list 里看）' },
    list: { type: 'boolean', description: '看看现在记着哪些' },
  },
  async run(a, { pond, life, memory }) {
    const f = pond.current(); if (!f) return NO_FISH;
    if (!memory) return { ok: false, error: '记忆还没准备好' };
    if (a.list) return { ok: true, items: memory.told(f) };
    const ops = [['mute', a.mute], ['unmute', a.unmute], ['pin', a.pin], ['unpin', a.unpin]].filter(([, v]) => v);
    if (ops.length > 1) return { ok: false, error: '一次只办一条，爸妈想办几件就分几句说' };
    if (ops.length === 1) {
      const [op, id] = ops[0];
      const r = memory.mark(f, id, op);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, id: r.id, mark: r.mark, kind: r.kind, text: r.text, muted: r.muted, pinned: r.pinned, hint: MARK_TIP[op] };
    }
    if (a.forget) {
      // 四期-3 J0：忘了吧一律两步——这里只起草（yushe_memory_drop 共用那张单）、返回 proposalId；真的删要在那边带 proposalId + confirm 确认
      const r = memory.propose(f, 'drop', a.forget);
      if (!r.ok) return { ok: false, error: r.why };
      return { ok: true, proposalId: r.proposalId, what: r.what, forgot: r.what, next: '还没删。把要忘的那条用大白话复述给爸妈，爸妈点头后再调 yushe_memory_drop，带上这个 proposalId 和 confirm=true 才真的忘掉。' };
    }
    const r = memory.tell(f, a.text);
    if (!r.ok) return { ok: false, error: r.why };
    if (!r.merged) life?.record?.(f, 'told', `${f.parentCall}让本鱼记住：「${r.item.text.slice(0, 30)}」`, { mood: 1 });
    // 五期-2 C：带日子、是爸妈答应她的 → 挂惦记（拍板 a：她当场说一句开心的话，让爸妈知道她会惦记着、可以改口）；没日子不挂
    const hoping = Boolean(a.promise) && Boolean(r.item?.due);
    if (hoping) life?.addHope?.(f, { cause: r.item.text, until: r.item.due, ref: r.item.id });
    return {
      ok: true, remembered: r.item.text, id: r.item.id, updated: r.merged || undefined,
      hint: hoping
        ? `记下了，也记着日子呢。用你自己的口吻开心地跟${f.parentCall}说一句，让他们知道你会惦记着这件事（他们要是改了主意，直接说一声就行）`
        : '记下了，以后跟爸妈说话时会想起来',
    };
  },
});
