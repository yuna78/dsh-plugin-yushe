/**
 * 零花钱（F-32）：她自己的 AI 调用花的 token。纯函数，宿主和 verify 共用。
 *
 * 三种模式：
 *   jar     存钱罐：一笔钱花完为止（默认 500 万），妈妈可以往里放
 *   daily   每天零花钱：每天一笔，当天花完就停，不攒到第二天
 *   free    不限：只记账
 *
 * 状态形状：{ version, mode, jar, daily, spent: { 'YYYY-MM-DD': { kind: tokens } }, total, topups: [{at, amount}] }
 * jar 是「罐里还剩多少」；daily 是「每天给多少」。spent 只留最近 31 天。
 */
export const DEFAULT_JAR = 5_000_000;
export const DEFAULT_DAILY = 300_000;
export const MODES = ['jar', 'daily', 'free'];
export const KIND_LABEL = { chat: '聊天', greet: '打招呼', news: '念新闻', diary: '日记', roam: '出门', first: '破壳第一句', probe: '探针', letter: '写信', note: '字条', plan: '日程', dm: '回私信', speak: '在 B站说话', reflect: '睡前反思', photo: '拍照', dream: '梦游' };

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function freshAllowance() {
  return { version: 1, mode: 'jar', jar: DEFAULT_JAR, daily: DEFAULT_DAILY, spent: {}, total: 0, topups: [] };
}

/** 读进来的东西不可信：补默认值、修类型。 */
export function normalizeAllowance(a) {
  const f = freshAllowance();
  if (!a || typeof a !== 'object') return f;
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);
  return {
    version: 1,
    mode: MODES.includes(a.mode) ? a.mode : f.mode,
    jar: num(a.jar, f.jar),
    daily: num(a.daily, f.daily),
    spent: a.spent && typeof a.spent === 'object' ? a.spent : {},
    total: num(a.total, 0),
    topups: Array.isArray(a.topups) ? a.topups.slice(-50) : [],
  };
}

export function spentOn(a, d) {
  const day = a.spent?.[dayKey(d)] || {};
  return Object.values(day).reduce((s, n) => s + (Number(n) || 0), 0);
}

/** 现在还能花多少（free 模式是 Infinity）。 */
export function leftOf(a, d) {
  if (a.mode === 'free') return Infinity;
  if (a.mode === 'daily') return Math.max(0, a.daily - spentOn(a, d));
  return Math.max(0, a.jar);
}

/** 钱包快照（UI / 路由 / 规则用）。 */
export function walletView(a, d) {
  const left = leftOf(a, d);
  const today = a.spent?.[dayKey(d)] || {};
  return {
    mode: a.mode,
    left: left === Infinity ? null : left,
    unlimited: left === Infinity,
    broke: left <= 0,
    jar: a.jar, daily: a.daily,
    spentToday: spentOn(a, d),
    byKind: Object.entries(today).map(([kind, tokens]) => ({ kind, label: KIND_LABEL[kind] || kind, tokens })).sort((x, y) => y.tokens - x.tokens),
    total: a.total,
    level: left === Infinity ? 'rich' : left <= 0 ? 'broke' : left < (a.mode === 'daily' ? a.daily * 0.2 : 100_000) ? 'low' : 'ok',
  };
}

/** 花一笔：记账、扣钱（罐里不会扣成负数）。返回新状态。 */
export function charge(a, tokens, kind, d) {
  const t = Math.max(0, Math.round(Number(tokens) || 0));
  if (!t) return a;
  const k = dayKey(d);
  const spent = { ...(a.spent || {}) };
  spent[k] = { ...(spent[k] || {}), [kind]: ((spent[k] || {})[kind] || 0) + t };
  const keep = Object.keys(spent).sort().slice(-31);
  const trimmed = Object.fromEntries(keep.map((x) => [x, spent[x]]));
  return { ...a, spent: trimmed, total: (a.total || 0) + t, jar: a.mode === 'jar' ? Math.max(0, a.jar - t) : a.jar };
}

/** 妈妈改设置：换模式、往罐里放钱、改每天的额度。 */
export function configure(a, { mode, topUp, daily, jar } = {}, d = new Date()) {
  let n = { ...a };
  if (MODES.includes(mode)) n.mode = mode;
  if (Number.isFinite(Number(daily)) && Number(daily) >= 0) n.daily = Math.min(Math.round(Number(daily)), 100_000_000);
  if (Number.isFinite(Number(jar)) && Number(jar) >= 0) n.jar = Math.min(Math.round(Number(jar)), 1_000_000_000);
  const add = Math.round(Number(topUp) || 0);
  if (add > 0) { n.jar = Math.min(n.jar + add, 1_000_000_000); n.topups = [...(n.topups || []), { at: d.toISOString(), amount: add }].slice(-50); }
  return n;
}

/** token 数写成人话：12345 → 1.2 万，5000000 → 500 万。 */
export function tokensText(n) {
  if (n === null || n === undefined || n === Infinity) return '不限';
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1).replace(/\.0$/, '')} 万`;
  return String(n);
}

/** 一次调用花了多少：优先 totalTokens，没有就输入 + 输出，再没有按字数粗估。 */
export function usageTokens(usage, fallbackChars = 0) {
  if (usage && Number(usage.totalTokens)) return Number(usage.totalTokens);
  const io = (Number(usage?.inputTokens) || 0) + (Number(usage?.outputTokens) || 0);
  return io || Math.ceil(fallbackChars * 1.5);
}
