/**
 * 梦游的规则（F-79，docs/设计/11-梦游.md）。纯函数：宿主和 verify 共用。
 *
 * 一晚一次，时刻由 `hashOf(fishId, 'dream', day)` 掷出来（01:30–05:30 之间），可复现、不固定；
 * 到点之后、她还在睡、这道闸开着、今晚还没梦过、零花钱够，才梦。
 */
import { hashOf } from './core.js';

export const DREAM_FROM_HOUR = 1.5; // 01:30
export const DREAM_TO_HOUR = 5.5;   // 05:30
export const DREAM_COST = { energy: -14 }; // 半睡一小时少回 6 + 熬夜账 8，一次扣完
export const DREAM_LATE_MAX = 90 * 60_000; // 到点后 90 分钟内还可以梦，再晚就这一晚算了
export const DREAM_BUDGET_MIN = 30_000;

/** 这一晚她梦游的时刻（本地时间 ms）。同一个 fishId + 同一天永远一样。 */
export function dreamMomentAt(fishId, day, fromHour = DREAM_FROM_HOUR, toHour = DREAM_TO_HOUR) {
  const frac = (hashOf(String(fishId || ''), 'dream', String(day || '')) % 1000) / 1000;
  const d = new Date(`${day}T00:00:00`); // 本地零点
  d.setMinutes(Math.round((fromHour + frac * (toHour - fromHour)) * 60));
  return d.getTime();
}

/**
 * 现在该不该梦游。返回 { ok, why }（ok=true 才去跑）。
 *   asleep      她现在睡着吗
 *   enabled     细配置「睡觉时让她梦游」
 *   perNight    一晚最多几次
 *   doneTonight 今晚已经梦过几次
 *   left        零花钱还剩多少（unlimited=true 时不算）
 */
export function dreamDue({ fishId = '', day = '', now = Date.now(), asleep = false, enabled = true, perNight = 1, doneTonight = 0, left = 0, unlimited = false, budget = DREAM_BUDGET_MIN, loggedIn = true, out = false } = {}) {
  if (!enabled) return { ok: false, why: '梦游关着' };
  if (!loggedIn) return { ok: false, why: '她还没登录 B站' };
  if (!asleep) return { ok: false, why: '她醒着（不需要梦游）' };
  if (out) return { ok: false, why: '她出门了，回来再做梦' }; // 出门途中哪怕到点也不梦，免得和「在逛」打架
  if (!(Number(perNight) > 0)) return { ok: false, why: '一晚最多梦 0 次' };
  if (doneTonight >= Number(perNight)) return { ok: false, why: `今晚已经梦过 ${doneTonight} 次` };
  if (!unlimited) {
    const v = Number(left);
    if (!Number.isFinite(v) || v < DREAM_BUDGET_MIN) return { ok: false, why: '零花钱不够做梦' };
  }
  const at = dreamMomentAt(fishId, day);
  if (!Number.isFinite(at)) return { ok: false, why: '日期不对' };
  if (now < at) return { ok: false, why: '还没到她做梦的点儿', at };
  if (now > at + DREAM_LATE_MAX) return { ok: false, why: '太晚了，这一晚就算了', at }; // 只有下界的话，07:29 也会补一场
  return { ok: true, at };
}

/** 梦话必须带「这是梦」的口气（规则检查，不满足就换模板）。 */
export const DREAM_FUZZY = /(好像|记不太清|记不清|梦见|梦到|梦里|模糊|想不起来|隐约)/;

export function dreamWordsOk(text) {
  const t = String(text || '').trim();
  return t.length >= 4 && DREAM_FUZZY.test(t);
}

/** 她没写出合格的梦话时的模板（规则兜底，不交给模型）。 */
export function dreamTemplate(seen = []) {
  const first = (seen || [])[0];
  return first ? `好像梦见在刷 B站，看到《${String(first.title || '').slice(0, 30)}》，具体记不太清了…` : '好像梦见在刷 B站，看了些什么，记不太清了…';
}
