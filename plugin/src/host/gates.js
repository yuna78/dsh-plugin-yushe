/**
 * 出口闸的宿主端包装（F-79）：把「现在几点、她睡没睡、是不是安静时段」查好，交给 shared/gates.js 判。
 *
 *   gates.open('read')        { ok, why }
 *   gates.closed('out')       true / false
 *   gates.asleep()            她是不是在睡觉（00:00–07:30）
 *   gates.quiet()             现在是不是安静时段
 *   gates.snapshot()          六个出口一次看全（status / 调试用）
 */
import { nowDate } from './clock.js';
import { asleepAt } from './life-engine.js';
import { inQuiet } from '../shared/habits.js';
import { gateFor, gatesView, EXITS } from '../shared/gates.js';

export function createGates({ habits = null } = {}) {
  const quiet = (d = nowDate()) => Boolean(habits && inQuiet(habits.get(), d));
  const ctx = () => ({ asleep: asleepAt(), quiet: quiet() });
  const gates = {
    asleep: () => asleepAt(),
    quiet,
    open: (exit) => gateFor(exit, ctx()),
    closed: (exit) => !gateFor(exit, ctx()).ok,
    snapshot: () => gatesView(ctx()),
    exits: EXITS,
  };
  return gates;
}
