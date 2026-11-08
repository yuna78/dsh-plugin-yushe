// S7 · 爸妈让她记住一件事（F-76 第三步）：规则查过才记；只在家里说（出门、写评论都想不起来）
import { defineTool, NO_FISH } from '../define.js';

export default defineTool({
  name: 'yushe_remember',
  kind: 'self',
  expose: { main: true, trip: false },
  description: '爸妈明确让你「记住」某件事时用：text 填爸妈要你记的那句话（用爸妈的原意，别添油加醋）。只记爸妈说的、关于家里或你们之间的事；不记密码、号码、链接；问题和猜测不记。每天最多 5 件，最多同时记 20 件。爸妈让你忘掉某件，先 list 看编号，再 forget。记下的事只在跟爸妈说话时想得起来，对外不说。',
  params: {
    text: { type: 'string', description: '要记住的那句话（60 字以内）' },
    forget: { type: 'string', description: '要忘掉的那一条的编号（T 开头，从 list 里看）' },
    list: { type: 'boolean', description: '看看现在记着哪些' },
  },
  async run(a, { pond, life, memory }) {
    const f = pond.current(); if (!f) return NO_FISH;
    if (!memory) return { ok: false, error: '记忆还没准备好' };
    if (a.list) return { ok: true, items: memory.told(f) };
    if (a.forget) {
      const r = memory.untell(f, a.forget);
      if (!r.ok) return { ok: false, error: r.why };
      life?.record?.(f, 'told', `${f.parentCall}让本鱼忘掉：「${r.item.text.slice(0, 30)}」`, {});
      return { ok: true, forgot: r.item.text };
    }
    const r = memory.tell(f, a.text);
    if (!r.ok) return { ok: false, error: r.why };
    if (!r.merged) life?.record?.(f, 'told', `${f.parentCall}让本鱼记住：「${r.item.text.slice(0, 30)}」`, { mood: 1 });
    return { ok: true, remembered: r.item.text, id: r.item.id, updated: r.merged || undefined, hint: '记下了，以后跟爸妈说话时会想起来' };
  },
});
