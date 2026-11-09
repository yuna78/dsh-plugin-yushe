/**
 * 在家上网的规则（F-87，docs/设计/15-在家上网.md §3.1 / §3.4，拍板 5）。纯函数：宿主和 verify 共用。
 *
 * 出门是大事件、一天几次；学东西要高频。醒着在家她按固定的间隔自己刷一轮（±20% 由 hashOf(fishId,'home',lastAt) 抖出来，
 * 可复现、不固定），一天最多几次、精力够、零花钱没花光才刷。
 *
 * 读是静音的：安静时段她醒着照样刷（homeDue 不看安静时段）。爸妈最近 10 分钟在房间里跟她说过话 → 当面说话，不低头刷手机；
 * DSH 主会话里干活不算（上下文本彼此独立）。
 */
import { hashOf } from './core.js';

const MIN = 60_000;
export const SPREAD = 0.2; // 间隔抖动 ±20%
export const HOME_MIN_ENERGY = 25;   // 精力低于这条不刷
export const HOME_CHAT_QUIET_MS = 10 * MIN; // 爸妈刚在房间里说过话的安静时长

/**
 * 这一轮的间隔：everyMin 分钟的 80%–120%，由 hashOf(fishId, 'home', lastAt) 掷出来。
 * 同一条鱼同一刻永远一样（可复现），不同鱼 / 不同时刻不一样。
 */
export function homeGapMs(fishId, lastAt, everyMin) {
  const every = Math.max(1, Number(everyMin) || 45);
  const frac = (hashOf(String(fishId || ''), 'home', String(Math.round(Number(lastAt) || 0))) % 1000) / 1000;
  return Math.round(every * (1 - SPREAD + frac * 2 * SPREAD) * MIN);
}

/**
 * 现在该不该在家刷一轮。返回 { ok, why }（不刷的 why 是给人看的话，不出现 token / 风控 / 轮）。
 * 收不到 quiet：读不打扰，安静时段醒着照刷。
 *   lastAt      上一轮开始的时间（0 = 还没刷过）
 *   lastChatAt  爸妈在房间里最后说话的时间（0 = 很久没说）
 */
export function homeDue({ fishId = '', now = Date.now(), enabled = true, loggedIn = true, asleep = false, out = false, napping = false, dreaming = false, energy = 100, broke = false, blocked = false, roundsToday = 0, perDay = 14, lastAt = 0, everyMin = 45, lastChatAt = 0 } = {}) {
  if (!enabled) return { ok: false, why: '在家刷 B站关着了' };
  if (!loggedIn) return { ok: false, why: '她还没登录 B站' };
  if (asleep) return { ok: false, why: '她睡着了' };
  if (out) return { ok: false, why: '她出门了，回来再刷' };
  if (napping) return { ok: false, why: '在午睡呢' };
  if (dreaming) return { ok: false, why: '她在梦游呢' };
  if (Number(energy) < HOME_MIN_ENERGY) return { ok: false, why: '累了歇一会儿，攒攒精神' };
  if (broke) return { ok: false, why: '零花钱花光了' };
  if (blocked) return { ok: false, why: 'B站让我歇会儿' };
  const max = Number(perDay) || 0;
  if (max === 0) return { ok: false, why: '爸妈暂时让今天别刷' };
  if (Number(roundsToday) >= max) return { ok: false, why: `今天已经刷了 ${roundsToday} 次，剩下的时间歇一歇` };
  if (now - Number(lastChatAt || 0) < HOME_CHAT_QUIET_MS) return { ok: false, why: '你在跟前陪她说话呢，她不低头刷手机' };
  if (now - Number(lastAt || 0) < homeGapMs(fishId, lastAt, everyMin)) return { ok: false, why: '刚刷过没多久，歇一歇再看' };
  return { ok: true };
}

/**
 * 点开一条读到了哪层 → 记忆里记多重（拍板 5：点开过的每条都进记忆，imp 按读多深）。
 *   只扫标题 → null（不进记忆，流水账里查得到）；点开详情 → glance（imp 1）；
 *   看了评论 → seen（imp 2）；读了字幕 → seen-deep（imp 3）；互动过（点赞 / 收藏 / 评论）再高一档，封顶 seen-deep。
 */
export function homeMemKind(depth, acts = []) {
  const orders = ['title', 'detail', 'comments', 'subtitle'];
  const kinds = [null, 'glance', 'seen', 'seen-deep'];
  let kind = kinds[Math.max(0, orders.indexOf(depth))];
  if (!kind) return null;
  if ((acts || []).length) kind = kinds[Math.min(kinds.length - 1, kinds.indexOf(kind) + 1)];
  return kind;
}
