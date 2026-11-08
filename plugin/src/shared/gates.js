/**
 * 出口闸（F-79，docs/设计/11-梦游.md）。纯函数，宿主端和 verify 共用。
 *
 * 以前是「一个全局 `asleepAt()` 被 6 个自动出口各问一遍」——一个决定问了六遍。
 * 现在拆成 6 个出口各自的判断，条件不只有时间：以后要改成按精力 / 心情 / 零花钱，
 * 只改这里，出口不用动。
 *
 *   out     出门（含拍照、明信片、小东西、图鉴）：必须醒着，且不安静
 *   read    读 B站：**什么时候都行**（睡觉也行，这就是梦游）。读是静音的，安静时段也不拦——
 *           安静时段管的是「打扰爸妈」的出口（出门 / 写信 / 说话）；读的频率由梦游的开关和额度管
 *   act     互动（点赞 / 收藏 / 关注 / 收件箱 / 私信轮询）：必须醒着（安静时段也照看，只是不主动打扰）
 *   speak   对外说话（评论 / 动态 / 私信）：必须醒着，且不安静
 *   letter  写信：必须醒着，且不安静
 *   plan    每天的打算 / 日记：必须醒着
 *
 * 安静时段（habits.quietFrom–quietTo）压过一切**打扰爸妈**的出口（出门 / 写信 / 说话 / 互动）；
 * 读是静音的，不在此列——否则默认安静时段（22:00–09:00）正好盖住睡眠窗口，梦游永远触发不了。
 */
export const EXITS = ['out', 'read', 'act', 'speak', 'letter', 'plan'];

export const EXIT_TEXT = {
  out: '出门',
  read: '刷 B站',
  act: '看别人理她没',
  speak: '在 B站说话',
  letter: '写信',
  plan: '想今天的打算',
};

const deny = (why) => ({ ok: false, why });

/**
 * 这道出口现在开不开。ctx = { asleep, quiet }（都已是布尔）。
 * 返回 { ok, why }；why 是给人话（日志 / 工具返回用）。
 */
export function gateFor(exit, { asleep = false, quiet = false } = {}) {
  if (!EXITS.includes(exit)) return deny(`不认识的出口：${exit}`);
  // 读是静音的，不打扰爸妈：睡觉、安静时段都开着。频率 / 额度 / 晚上梦几次由 dreamDue 那套规则管
  if (exit === 'read') return { ok: true };
  if (asleep) return deny('她在睡觉');
  if (exit === 'plan' || exit === 'act') return { ok: true }; // 互动只要求醒着：安静时段只是不「打扰」，看别人的回复不算打扰
  if (quiet) return deny('安静时段');
  return { ok: true };
}

/** 一句话描述六个出口现在开没开（设置页 / 日志用）。 */
export function gatesView(ctx = {}) {
  return Object.fromEntries(EXITS.map((e) => [e, gateFor(e, ctx)]));
}
