// S5 · 按爸妈的话起草一份配置改动（47b）：规则夹紧到范围和硬顶，不写
import { defineTool } from '../define.js';

export default defineTool({
  name: 'yushe_config_propose',
  kind: 'self',
  expose: { main: true, trip: false },
  description: '爸妈想调你的上网配置时（比如「多看点做饭的」「少点赞」「看深一点，字幕也看」「关注要克制」），按他们的话起草一份改动：changes 里可以给档位（out: 宅/看性格/爱逛，depth: 浅/中/深，interact: 少/适中/多），也可以给细项（字段名见 yushe_config_get）。这一步**不会真的改**，会返回改哪些、从多少到多少、有没有被夹到范围里，以及 proposalId。拿到后一定要把改动用大白话复述给爸妈，等爸妈说行，再用 yushe_config_apply。性格和人设不在这里——你更喜欢自由生长。',
  params: { changes: { type: 'object', description: '要改的档位或细项：{ 名字: 新值 }', additionalProperties: true, required: true }, reason: { type: 'string', description: '爸妈为什么想这么改（一句话）' } },
  async run(a, { habits }) {
    if (!a.changes || typeof a.changes !== 'object' || Array.isArray(a.changes)) return { ok: false, error: 'changes 要是 { 名字: 新值 }' };
    const r = habits.propose(a.changes, { reason: a.reason || '' });
    if (!r.ok) return r;
    return { ...r, next: '把 diff 用大白话复述给爸妈（被夹到范围里的要说明），爸妈同意后调 yushe_config_apply，带上这个 proposalId 和 confirm=true。' };
  },
});
