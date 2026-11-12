// 四期-3 J0/J · 爸妈说「把那件事忘了吧」：一律两步走。第一次只起草（复述 + proposalId，不删），
// 爸妈点头以后再带 proposalId + confirm=true 才真的忘。yushe_remember 的 forget 也是走这张起草单（J0）。
// 档案（life 里的日记、笔记本、足迹…）一个字都不动，只是她这里不再记得。
import { defineTool, NO_FISH } from '../define.js';

export default defineTool({
  name: 'yushe_memory_drop',
  kind: 'self',
  expose: { main: true, room: true, trip: false }, // 主会话和鱼社房间都能办；出门（trip）别动家里记的东西
  description: '爸妈说「把那件事忘了吧」「忘了它吧」时用来忘掉一条记忆（M 经历 / B 认识 / T 爸妈让记的 / W 周记，编号从 yushe_recall 或 list 里看），一律两步：**第一次只调 target 起草，先不删**。起草返回 proposalId，还带着那条是什么（what，白话种类 + 开头几个字）——用大白话复述给爸妈（比如「是要把『看到洋葱会发光』那条日记从记忆里扔掉吗」），**爸妈点头**，再调一次：带上 proposalId 和 confirm=true，这时才真的忘。只忘爸妈明确说的那条，别自己挑；拿不准是哪条先问清楚。档案页照旧能看到（笔记本、日记、足迹都在，只动她记得的部分）。proposalId 30 分钟有效、只能用一次。办完用一句带自己口吻的话告诉爸妈（比如「嗯，那我就当没看见过啦，档案页里还翻得到」），别流水账地报。',
  params: {
    target: { type: 'string', description: '要忘掉的那条的编号（M / B / T / W 开头，从 yushe_recall 或 list 里看）' },
    proposalId: { type: 'string', description: '上次起草返回的 proposalId（爸妈点头以后才带）' },
    confirm: { type: 'boolean', description: '爸妈听完复述、点头了，才设 true' },
  },
  async run(a, { pond, life, memory }, ctx) {
    const f = pond.current(); if (!f) return NO_FISH;
    if (!memory) return { ok: false, error: '记忆还没准备好' };
    const confirmStep = a.proposalId != null && a.proposalId !== '' || a.confirm != null; // 带了单号或者带了 confirm：按确认这一步办
    if (confirmStep) {
      if (a.confirm !== true) return { ok: false, needsConfirmation: true, error: '还没有真的忘掉。要爸妈在这次对话里听完复述、点头了，再设 confirm=true 调一次。' };
      const r = memory.applyDrop(f, a.proposalId, { from: ctx?.from }); // 修补-2 J：把出口（room / main）交给宿主——房间里要等爸妈再说一句才能办
      if (!r.ok) return { ok: false, error: r.why };
      if (r.kind === '要记的') {
        life?.record?.(f, 'told', `${f.parentCall}让本鱼忘掉一条嘱咐`, {});
        life?.dropHope?.(f, r.item); // 五期-2 C：爸妈改口了——那条嘱咐挂着的惦记一起撤掉，不产生情绪
      }
      return { ok: true, dropped: r.item, archive: r.archive, hint: '忘掉了，档案页里照旧看得见' };
    }
    const r = memory.propose(f, 'drop', a.target);
    if (!r.ok) return { ok: false, error: r.why };
    return { ok: true, proposalId: r.proposalId, what: r.what, next: '还没删。把 what 用大白话复述给爸妈，确认要忘的就是那一条，再调一次 yushe_memory_drop，带上这个 proposalId 和 confirm=true；不是那一条就重新起草。' };
  },
});
