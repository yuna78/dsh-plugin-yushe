// S1 · 她现在怎么样（08 工具明细 第 1 节）
import { nowDate } from '../../clock.js';
import { snapshot, dayOf } from '../../life-engine.js';
import { describeHabits } from '../../../shared/habits.js';
import { tokensText } from '../../../shared/allowance.js';
import { homeOf } from '../../../shared/homes.js';
import { outgoingness } from '../../../shared/trip.js';
import { planNow } from '../../../shared/plan.js';
import { defineTool, NO_FISH } from '../define.js';

export default defineTool({
  name: 'yushe_status',
  kind: 'self',
  description: '看看你（鱼社里的这条鱼）自己现在怎么样：在做什么、心情精力、今天发生的事、零花钱、是不是在外面闲逛、上网习惯。爸妈问「你在干嘛 / 今天怎么样 / 还有零花钱吗」时用。',
  async run(_a, { pond, life, wallet, habits }) {
    const f = pond.current(); if (!f) return NO_FISH;
    const s = life.state(f), snap = snapshot(s), act = life.activity(f, s, wallet.busy), w = wallet.view();
    return { ok: true, name: f.name, call: f.parentCall, home: homeOf(f.home).name, doing: act.activityText, mood: snap.moodWord, energy: snap.energy >= 70 ? '精神饱满' : snap.energy >= 40 ? '有点累' : snap.energy >= 15 ? '很困' : '撑不住了',
      today: life.eventsOf(s, dayOf()).slice(-10).map((e) => e.text), allowance: w.unlimited ? '不限' : `还剩 ${tokensText(w.left)} token（今天花了 ${tokensText(w.spentToday)}）`,
      trip: s.trip ? { note: s.trip.note, back: s.trip.returnAt ? new Date(s.trip.returnAt).toTimeString().slice(0, 5) : '还在逛' } : null, habits: describeHabits(habits.get()),
      plan: (s.plans?.[dayOf()]?.rows || []).filter((r) => !r.fixed).map((r) => `${r.from}–${r.to} ${r.what}`), planNow: planNow(s.plans?.[dayOf()]?.rows, nowDate())?.what || null,
      workspace: f.workspace ? `${f.workspace.title}（${f.workspace.path}）：只在这个工作区上工` : '所有工作区',
      personality: s.growth?.type || f.personality, outgoing: (() => { const o = outgoingness(s.growth?.pts || f.pts, s.growth?.lean); return `${o.label}${o.why.length ? `（${o.why.join('、')}）` : ''}`; })() };
  },
});
