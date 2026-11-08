// S3 · 问她想不想出门（她可以拒绝，规则决定）
import { nowMs } from '../../clock.js';
import { snapshot, asleepAt } from '../../life-engine.js';
import { goOutAnswer, REFUSE_TEXT } from '../../../shared/room.js';
import { defineTool, NO_FISH } from '../define.js';

export default defineTool({
  name: 'yushe_go_out',
  kind: 'self',
  expose: { main: true, trip: false },
  description: '爸妈让你出去逛逛（刷新闻、刷 B站）时用：这是「问你想不想去」，不是命令——你睡着、太累、没零花钱、闹别扭或者不想去都会拒绝，结果由规则决定。答应了就出门 1–3 小时，见闻会一条条记下来，回家带小东西。',
  async run(_a, { pond, life, wallet, trips }) {
    const f = pond.current(); if (!f) return NO_FISH;
    if (life.isOut(f)) return { ok: false, refused: true, line: '本鱼已经在外面啦～' };
    const snap = snapshot(life.state(f));
    const ans = goOutAnswer({ fishId: f.id, call: f.parentCall, energy: snap.energy, mood: snap.mood, asleep: asleepAt() || snap.where === 'sleep', broke: wallet.view().broke, now: nowMs() });
    if (!ans.go) { life.record(f, 'ask-out', `${f.parentCall}在 DSH 里问要不要出门，本鱼说不去（${REFUSE_TEXT[ans.reason] || ans.reason}）`, { visit: true }); return { ok: false, refused: true, reason: ans.reason, line: ans.line }; }
    const { id } = trips.start(f, 'asked');
    return { ok: true, tripId: id, line: ans.line, hint: '出门了。见闻会陆续记进鱼社右上角「见闻」，回家后有信和小东西。' };
  },
});
