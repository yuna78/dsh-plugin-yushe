// S6 · 爸妈同意后写入（47b）：只认 30 分钟内起草过、还没用过的那一份
import { defineTool } from '../define.js';

export default defineTool({
  name: 'yushe_config_apply',
  kind: 'self',
  expose: { main: true, trip: false },
  description: '把 yushe_config_propose 起草的那份改动真的写进去。**只有爸妈在这次对话里听完复述、明确说同意**时才能调，并且要 confirm=true。proposalId 30 分钟内有效、只能用一次；超时就重新起草。',
  params: { proposalId: { type: 'string', description: 'yushe_config_propose 返回的 proposalId', required: true }, confirm: { type: 'boolean', description: '爸妈在当前对话里明确同意了才设 true', required: true } },
  async run(a, { pond, life, habits }) {
    if (a.confirm !== true) return { ok: false, needsConfirmation: true, error: '要爸妈在这次对话里明确同意，并且设 confirm=true。' };
    const r = habits.apply(a.proposalId);
    if (!r.ok) return r;
    const f = pond.current();
    if (f && r.changed.length) life.record(f, 'habits', `${f.parentCall}在 DSH 里让本鱼调了上网配置：${r.changed.slice(0, 6).map((c) => `${c.label} ${Array.isArray(c.from) ? c.from.join('、') || '无' : c.from} → ${Array.isArray(c.to) ? c.to.join('、') || '无' : c.to}`).join('，')}${r.changed.length > 6 ? ` 等 ${r.changed.length} 项` : ''}`, {});
    return r;
  },
});
