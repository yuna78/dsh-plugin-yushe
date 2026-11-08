/**
 * 她每天的打算（F-52）：早上醒来自己想今天干什么（模型写），规则校验；睡觉 00:00–07:30 固定。
 * 打算只是「她想做的」，不是命令：出不出门照样由性格掷骰子，真发生了什么在「今天」页。纯函数。
 */
export const PLAN_ICONS = ['sunrise', 'work', 'book', 'rice', 'broom', 'surf', 'speech', 'diary', 'news', 'cookie', 'pillow', 'tv', 'pencil', 'heart', 'door', 'think', 'sparkle', 'gift', 'fish'];
export const WAKE = '07:30', BED = '24:00';
const SLEEP_ROW = { from: '00:00', to: '07:30', what: '睡觉', icon: 'moon', fixed: true };
const mins = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const okTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(String(s));

/** 给模型的提示词。facts：性格、爱好、精力、上工没、昨天的日记、上网习惯。 */
export function planPrompt({ fish, lifeText, facts }) {
  return [
    fish.personaText, '', lifeText, '',
    '【关于你】', ...facts.map((f) => `- ${f}`), '',
    `【现在】早上 ${WAKE} 你醒了。想想今天打算干什么（这只是你的打算，后面会不会变看心情）。`,
    `只输出一个 JSON 数组，5–9 段，从 ${WAKE} 排到 ${BED}，时间连续不重叠，每段：{"from":"HH:MM","to":"HH:MM","what":"不超过 16 个字，用你自己的口吻","icon":"从这些里选一个：${PLAN_ICONS.join(' / ')}"}。`,
    '要符合你的性格和爱好：爱出门的可以多安排出去逛，宅的多待在家；在上工的话白天要留出帮爸妈干活的时间；23 点以后要写日记。不要写具体的新闻、视频、数字或链接。只输出 JSON。',
  ].join('\n');
}

/** 校验模型写的打算；不合格返回 null（用模板兜底）。合格的补上固定的睡觉时段。 */
export function validatePlan(rows) {
  if (!Array.isArray(rows) || rows.length < 3 || rows.length > 12) return null;
  const out = [];
  for (const r of rows) {
    if (!r || !okTime(r.from) || !okTime(r.to)) return null;
    const a = mins(r.from), b = mins(r.to);
    if (b <= a || a < mins(WAKE) || b > mins(BED)) return null;
    const what = String(r.what || '').replace(/[\u0000-\u001f<>]/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim().slice(0, 18);
    if (!what) return null;
    out.push({ from: r.from, to: r.to, what, icon: PLAN_ICONS.includes(r.icon) ? r.icon : 'sparkle' });
  }
  out.sort((x, y) => mins(x.from) - mins(y.from));
  for (let i = 1; i < out.length; i++) if (mins(out[i].from) < mins(out[i - 1].to)) return null; // 重叠
  return [...out, SLEEP_ROW];
}

/** 模板（模型没写出来 / 零花钱花光时用）。 */
export function templatePlan({ call = '妈妈', working = true } = {}) {
  return [
    { from: '07:30', to: '09:00', what: '起床、吃早饭、发呆', icon: 'sunrise' },
    { from: '09:00', to: '12:00', what: working ? `帮${call}干活` : '在家看书', icon: working ? 'work' : 'book' },
    { from: '12:00', to: '13:30', what: '午饭 + 午睡', icon: 'rice' },
    { from: '13:30', to: '18:00', what: working ? `继续帮${call}干活` : '在家整理东西', icon: working ? 'work' : 'broom' },
    { from: '18:00', to: '20:00', what: '想出去逛逛', icon: 'surf' },
    { from: '20:00', to: '23:30', what: `陪${call}聊天、发呆`, icon: 'speech' },
    { from: '23:30', to: '24:00', what: '写日记', icon: 'diary' },
    SLEEP_ROW,
  ];
}

/** 标出「现在」那一段。 */
export function markNow(rows, d) {
  const x = d.getHours() * 60 + d.getMinutes();
  return rows.map((r) => ({ ...r, now: x >= mins(r.from) && x < mins(r.to) }));
}

/** 现在本来打算干嘛（给近况段落 / 状态工具用）。 */
export function planNow(rows, d) { return markNow(rows || [], d).find((r) => r.now) || null; }

/** 23:30 以后、今天有事发生、还没写日记 → 该写日记了。 */
export function diaryDue({ d, hasEventsToday, hasDiaryToday }) {
  const x = d.getHours() * 60 + d.getMinutes();
  return x >= mins('23:30') && hasEventsToday && !hasDiaryToday;
}
