/**
 * 她每天的打算 + 23:30 写日记（F-52）。
 *   planner.ensure(fish)   今天还没打算、她醒着 → 后台让她写一份（模型；花一点零花钱），不合格 / 没钱用模板
 *   planner.tick(fish)     宿主 10 分钟定时器：早上补打算；23:30 以后写今天的日记
 */
import { nowDate, nowMs } from './clock.js';
import { dayOf, asleepAt, lifeSection, snapshot } from './life-engine.js';
import { planPrompt, validatePlan, templatePlan, diaryDue } from '../shared/plan.js';
import { outgoingness } from '../shared/trip.js';
import { writeDiary } from './life-routes.js';

export function createPlanner({ life, wallet, pond, log, memory = null }) {
  const busy = new Set();
  const parseArr = (text) => { const m = String(text || '').match(/\[[\s\S]*\]/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };
  const planner = {
    ensure(fish) {
      if (!fish || asleepAt() || busy.has(fish.id)) return false;
      const s = life.state(fish), day = dayOf();
      if (s.plans?.[day]) return false;
      busy.add(fish.id);
      const working = pond.current()?.id === fish.id;
      (async () => {
        let rows = null, ai = false;
        try {
          const og = outgoingness(s.growth?.pts || fish.pts, s.growth?.lean);
          const facts = [
            `性格：${s.growth?.type || fish.personality}；爱不爱出门：${og.label}`,
            `最近最爱：${Object.entries(s.growth?.interests || {}).sort((a, b) => b[1].heat - a[1].heat).slice(0, 3).map(([t]) => t).join('、') || '还没特别爱的'}`,
            `精力：${snapshot(s).energy >= 70 ? '精神饱满' : snapshot(s).energy >= 40 ? '有点累' : '很困'}`,
            working ? `你在 DSH 上工，白天要帮${fish.parentCall}干活` : '今天你歇着，不用帮忙干活',
            ...((s.diary || []).at(-1) ? [`昨天的日记：${(s.diary || []).at(-1).text.slice(0, 80)}`] : []),
          ];
          const r = await wallet.say('plan', planPrompt({ fish, lifeText: lifeSection(fish, s), facts }), null, 45_000);
          rows = validatePlan(parseArr(r.text)); ai = Boolean(rows);
        } catch (e) { log?.info?.(`[dsh-yushe] 今天的打算没让模型写（${e?.message || e}），用模板`); }
        life.setPlan(fish, day, { rows: rows || templatePlan({ call: fish.parentCall, working }), ai, at: nowDate().toISOString() });
      })().finally(() => busy.delete(fish.id));
      return true;
    },
    async tick(fish) {
      if (!fish) return;
      planner.ensure(fish);
      const s = life.state(fish), day = dayOf();
      if (diaryDue({ d: nowDate(), hasEventsToday: (s.events || []).some((e) => e.day === day), hasDiaryToday: (s.diary || []).some((x) => x.day === day) }) && !busy.has(`diary:${fish.id}`)) {
        busy.add(`diary:${fish.id}`);
        try { await writeDiary({ wallet, life, memory }, fish, day); } finally { busy.delete(`diary:${fish.id}`); }
      }
    },
  };
  return planner;
}
