/**
 * 她的上网习惯（F-41）→ 两层配置（F-59 / 任务 47b，docs/设计/08-工具明细.md 第 5 节）。纯函数。
 *
 *   粗的（设置页）：三个档位 KNOBS（爱不爱出门 / 读多深 / 互动多少）+ 几个 ui 字段（自己出门、安静时段、在 B站说话、发言间隔、爸妈 UID）。
 *                   拖一个档位 = 整套改写它管的细项。
 *   细的（只能聊天改）：chat 字段，几十项，每项有范围（max 就是硬顶，怎么改都超不过）。DSH 里她先 propose（复述改哪些），爸妈同意再 apply。
 *
 * 一份存储（habits.json），所有字段平铺；档位不单独存，按细项现在的值反推（对不上任何一档 = 「自定义」）。
 * 互动工具声明的上限（tools/<act|speak>/*.js 的 cap）由宿主 schemaWith() 并进来（任务 49 / 50 起）。
 */
const L3 = ['少', '适中', '多'];

export const GROUPS = { out: '出门', read: '读多深', cap: '互动上限', taste: '偏好', speak: '在 B站说话', home: '家里', memory: '记性' };

export const HABIT_FIELDS = {
  // —— 设置页上的（ui）——
  autoOut: { label: '她会自己出门', type: 'bool', def: true, ui: true, chat: true, group: 'out' },
  quietFrom: { label: '安静时段开始', type: 'time', def: '22:00', ui: true, chat: true, group: 'home' },
  quietTo: { label: '安静时段结束', type: 'time', def: '09:00', ui: true, chat: true, group: 'home' },
  // 在 B站说话（F-51）：默认过了闸门规矩就自己发；「要我批准」只能爸妈在设置页改（她不能自己给自己放权）
  speakMode: { label: '在 B站说话', type: 'enum', values: ['auto', 'approve'], names: { auto: '自己发', approve: '要我批准' }, def: 'auto', ui: true, group: 'speak' },
  speakEvery: { label: '发言间隔', type: 'enum', values: ['30', '60', '120', '240'], names: { 30: '30 分钟', 60: '1 小时', 120: '2 小时', 240: '4 小时' }, def: '60', ui: true, chat: true, group: 'speak' },
  // 爸妈专线（任务 46）：身份类，只能爸妈在设置页填
  parentMid: { label: '爸妈的 B站 UID（专线）', type: 'uid', def: '', ui: true, group: 'speak' },

  // —— 细配置：出门 ——
  outBias: { label: '出门概率倍率', type: 'num', min: 0.3, max: 3, step: 0.1, def: 1, chat: true, group: 'out' },
  tripsPerDay: { label: '一天最多出门几次', type: 'int', min: 0, max: 10, def: 0, zero: '不限', chat: true, group: 'out' }, // 0 = 不限：看性格（F-50）
  restBias: { label: '回家歇多久的倍率', type: 'num', min: 0.5, max: 2, step: 0.1, def: 1, chat: true, group: 'out' },
  itemsPerTrip: { label: '每趟记几条见闻', type: 'int', min: 1, max: 5, def: 2, chat: true, group: 'out' },
  lean: { label: '更爱看什么', type: 'enum', values: ['news', 'both', 'bili'], names: { news: '新闻多一点', both: '都看', bili: 'B站多一点' }, def: 'both', chat: true, group: 'out' },

  // —— 细配置：读多深 ——
  readBudget: { label: '每天读 B站次数', type: 'int', min: 50, max: 1000, def: 300, chat: true, group: 'read' },
  tripToolCalls: { label: '每趟出门最多调几次工具', type: 'int', min: 3, max: 30, def: 12, chat: true, group: 'read' },
  subtitle: { label: '看字幕', type: 'bool', def: true, chat: true, group: 'read' },
  subtitleChars: { label: '字幕最多读多少字', type: 'int', min: 0, max: 6000, def: 1500, chat: true, group: 'read' },
  danmaku: { label: '看弹幕', type: 'bool', def: false, chat: true, group: 'read' },
  threads: { label: '看楼中楼', type: 'bool', def: true, chat: true, group: 'read' },
  commentsPerVideo: { label: '每个视频看几条评论', type: 'int', min: 0, max: 20, def: 5, chat: true, group: 'read' },

  // —— 细配置：互动上限（max = 硬顶）——
  commentsPerDay: { label: '每天最多评论几条', type: 'int', min: 0, max: 30, def: 12, chat: true, group: 'cap' },
  repliesPerDay: { label: '每天最多回复几条评论', type: 'int', min: 0, max: 30, def: 12, chat: true, group: 'cap' },
  dynCommentsPerDay: { label: '每天最多评论几条动态', type: 'int', min: 0, max: 10, def: 3, chat: true, group: 'cap' },
  postsPerDay: { label: '每天最多发几条动态', type: 'int', min: 0, max: 5, def: 2, chat: true, group: 'cap' },
  dmsPerDay: { label: '每天最多回几条陌生人私信', type: 'int', min: 0, max: 10, def: 3, zero: '不回', chat: true, group: 'cap' },
  likesPerDay: { label: '每天最多点赞几个视频', type: 'int', min: 0, max: 50, def: 15, chat: true, group: 'cap' },
  commentLikesPerDay: { label: '每天最多给几条评论点赞', type: 'int', min: 0, max: 50, def: 15, chat: true, group: 'cap' },
  collectsPerDay: { label: '每天最多收藏几个', type: 'int', min: 0, max: 20, def: 5, chat: true, group: 'cap' },
  followsPerDay: { label: '每天最多关注几个 UP 主', type: 'int', min: 0, max: 10, def: 2, chat: true, group: 'cap' },
  unfollowsPerDay: { label: '每天最多取关几个', type: 'int', min: 0, max: 5, def: 1, chat: true, group: 'cap' },
  perPersonPerDay: { label: '对同一个人每天最多互动几次', type: 'int', min: 0, max: 8, def: 4, chat: true, group: 'cap' },
  replyToReplies: { label: '别人回她要不要回', type: 'bool', def: true, chat: true, group: 'cap' },

  // —— 细配置：记性（F-76，docs/设计/09-记忆.md）——
  memoryDays: { label: '记性基准（天，普通经历多久忘一半）', type: 'int', min: 5, max: 120, def: 30, chat: true, group: 'memory' },
  memoryRecall: { label: '每次想起几件事', type: 'int', min: 0, max: 12, def: 5, chat: true, group: 'memory' },

  // —— 细配置：偏好（只能聊天改，没有档位）——
  favZones: { label: '多看的分区', type: 'list', maxItems: 8, maxLen: 12, def: [], chat: true, group: 'taste' },
  avoidZones: { label: '少看的分区', type: 'list', maxItems: 8, maxLen: 12, def: [], chat: true, group: 'taste' },
  favUps: { label: '多看的 UP 主（数字 id）', type: 'list', maxItems: 20, maxLen: 20, pattern: '^\\d{1,20}$', def: [], chat: true, group: 'taste' },
  avoidWords: { label: '不想看的话题', type: 'list', maxItems: 20, maxLen: 10, def: [], chat: true, group: 'taste' },
};

/** 三个粗档位：每档对应一组细项的值（顺序和 levels 一致）。默认档 = 各细项的默认值。 */
export const KNOBS = {
  out: { label: '爱不爱出门', levels: ['宅', '看性格', '爱逛'], fields: { outBias: [0.5, 1, 1.8], tripsPerDay: [2, 0, 0], restBias: [1.5, 1, 0.6] } },
  depth: { label: '读多深', levels: ['浅', '中', '深'], fields: { readBudget: [150, 300, 600], tripToolCalls: [6, 12, 20], subtitle: [false, true, true], subtitleChars: [0, 1500, 4000], danmaku: [false, false, true], threads: [false, true, true], commentsPerVideo: [3, 5, 10] } },
  memory: { label: '记性', levels: ['健忘', '适中', '好记性'], fields: { memoryDays: [10, 30, 60], memoryRecall: [3, 5, 8] } },
  interact: { label: '互动多少', levels: L3, fields: { commentsPerDay: [4, 12, 20], repliesPerDay: [4, 12, 20], dynCommentsPerDay: [1, 3, 6], postsPerDay: [1, 2, 3], dmsPerDay: [1, 3, 6], likesPerDay: [5, 15, 30], commentLikesPerDay: [5, 15, 30], collectsPerDay: [2, 5, 10], followsPerDay: [1, 2, 4], unfollowsPerDay: [0, 1, 2], perPersonPerDay: [2, 4, 6], replyToReplies: [false, true, true] } },
};
export const CUSTOM = '自定义';

/**
 * 把工具声明的上限并进来（宿主调）：caps = [{ key, label, levels: {少,适中,多}, max }]。
 * 已有字段只补档位；新字段加成「互动上限」组的 chat 字段，默认 = 适中。返回 { fields, knobs }。
 */
export function schemaWith(caps = []) {
  const fields = { ...HABIT_FIELDS };
  const knobs = { ...KNOBS, interact: { ...KNOBS.interact, fields: { ...KNOBS.interact.fields } } };
  for (const c of caps) {
    if (!c?.key || !c.levels) continue;
    if (!fields[c.key]) fields[c.key] = { label: c.label || c.key, type: 'int', min: 0, max: c.max, def: c.levels['适中'], chat: true, group: 'cap' };
    if (!knobs.interact.fields[c.key]) knobs.interact.fields[c.key] = L3.map((l) => Math.min(c.levels[l], fields[c.key].max));
  }
  return { fields, knobs };
}

export const defaultHabits = (fields = HABIT_FIELDS) => Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, Array.isArray(f.def) ? [...f.def] : f.def]));

/** 一个值按字段规则收拾好；不认得返回 undefined。 */
function coerce(f, v) {
  if (f.type === 'bool') return v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined;
  if (f.type === 'int') return Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.max(f.min, Math.min(f.max, Math.round(Number(v)))) : undefined;
  if (f.type === 'num') return Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.max(f.min, Math.min(f.max, Math.round(Number(v) / (f.step || 0.1)) * (f.step || 0.1))) : undefined;
  if (f.type === 'enum') return f.values.includes(String(v)) ? String(v) : undefined;
  if (f.type === 'time') return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : undefined;
  if (f.type === 'uid') return /^(\d{1,20})?$/.test(String(v).trim()) ? String(v).trim() : undefined;
  if (f.type === 'list') {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，、\s]+/) : null;
    if (!arr) return undefined;
    const re = f.pattern ? new RegExp(f.pattern) : null;
    return [...new Set(arr.map((x) => String(x).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, f.maxLen)).filter((x) => x && (!re || re.test(x))))].slice(0, f.maxItems);
  }
  return undefined;
}
const fix = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);
const same = (a, b) => JSON.stringify(fix(a)) === JSON.stringify(fix(b));

/** 读进来 / 改进来的东西都过这里：只认已知字段，夹在范围里。 */
export function normalizeHabits(h, fields = HABIT_FIELDS) {
  const out = defaultHabits(fields);
  if (!h || typeof h !== 'object') return out;
  for (const [k, f] of Object.entries(fields)) {
    if (h[k] === undefined) continue;
    const v = coerce(f, h[k]);
    if (v !== undefined) out[k] = fix(v);
  }
  return out;
}

/** 改一部分：返回 { habits, changed: [{key,label,from,to,clamped}], ignored: [未知或无效的字段] }。only：只允许改哪些字段（ui / chat）。 */
export function patchHabits(cur, patch, { fields = HABIT_FIELDS, only = null } = {}) {
  const before = normalizeHabits(cur, fields);
  const allowed = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => fields[k] && (!only || fields[k][only])));
  const after = normalizeHabits({ ...before, ...allowed }, fields);
  const changed = [], ignored = [];
  for (const k of Object.keys(patch || {})) {
    if (!(k in allowed)) { ignored.push(k); continue; }
    const want = coerce(fields[k], patch[k]);
    if (!same(after[k], before[k])) changed.push({ key: k, label: fields[k].label, from: before[k], to: after[k], clamped: want !== undefined && typeof want === 'number' && !same(want, Number(patch[k])) });
    else if (!same(String(patch[k]), String(before[k]))) ignored.push(k);
  }
  return { habits: after, changed, ignored };
}

/** 某个档位现在是哪一档（细项都对得上）；对不上 = 「自定义」。 */
export function knobLevel(h, key, knobs = KNOBS) {
  const k = knobs[key];
  const i = k.levels.findIndex((_, li) => Object.entries(k.fields).every(([f, vals]) => same(h[f], vals[li])));
  return i >= 0 ? k.levels[i] : CUSTOM;
}
/** 拖档位 = 这些细项改成这一档的值。 */
export function knobPatch(key, level, knobs = KNOBS) {
  const k = knobs[key]; const i = k?.levels.indexOf(level);
  if (!k || i < 0) return null;
  return Object.fromEntries(Object.entries(k.fields).map(([f, vals]) => [f, vals[i]]));
}

/** 一个值给人看的样子。 */
export function valueText(f, v) {
  if (f.type === 'bool') return v ? '开' : '关';
  if (f.type === 'enum') return f.names?.[v] ?? v;
  if (f.type === 'list') return v?.length ? v.join('、') : '（没有）';
  if (f.type === 'int' && v === 0 && f.zero) return f.zero;
  return String(v);
}
/**
 * 细配置按组列出来（设置页只读展开 + 工具 config_get 用）。
 *
 * 设置页那几项（ui:true）默认不进这个列表——它们在面板上已经有可点的控件了，列进来会重复一遍。
 * 但其中几个本来就能靠聊天改（autoOut / quietFrom / quietTo / speakEvery，都是 ui+chat），
 * 工具视图必须把它们列出来：否则爸妈在 DSH 里说「十点以后别出门」，她拿到的可改项里没有这一条，
 * 只能把人推回设置页，而 draftChanges 其实是认这些键的。
 */
export function fineView(h, fields = HABIT_FIELDS, { withUiChat = false } = {}) {
  const groups = {};
  for (const [k, f] of Object.entries(fields)) {
    if (f.ui && !(withUiChat && f.chat)) continue;
    (groups[f.group] ||= []).push({ key: k, label: f.label, value: h[k], text: valueText(f, h[k]), range: f.type === 'int' || f.type === 'num' ? `${f.min}–${f.max}` : f.type === 'enum' ? f.values.join('/') : f.type === 'time' ? 'HH:MM' : f.type === 'list' ? `最多 ${f.maxItems} 个` : f.type });
  }
  return Object.entries(groups).map(([g, items]) => ({ group: g, name: GROUPS[g] || g, items }));
}

/**
 * 她按爸妈的话起草一份改动（不写）：changes 里可以是细项，也可以是档位（{ depth: '深' }）。
 * 档位先展开，再被同一份 changes 里的细项覆盖。只认 chat 字段（speakMode / parentMid 这种只能爸妈在设置页改）。
 * 返回 { patch, diff: [{key,label,from,to,clamped}], rejected: [{key, why}] }。
 */
export function draftChanges(cur, changes, { fields = HABIT_FIELDS, knobs = KNOBS } = {}) {
  const patch = {}, rejected = [];
  for (const [k, v] of Object.entries(changes || {})) {
    if (knobs[k]) { const p = knobPatch(k, String(v), knobs); if (p) Object.assign(patch, p); else rejected.push({ key: k, why: `「${knobs[k].label}」只能是 ${knobs[k].levels.join(' / ')}` }); }
  }
  for (const [k, v] of Object.entries(changes || {})) {
    if (knobs[k]) continue;
    if (!fields[k]) rejected.push({ key: k, why: '没有这一项' });
    else if (!fields[k].chat) rejected.push({ key: k, why: `「${fields[k].label}」只能爸妈在设置页改` });
    else if (coerce(fields[k], v) === undefined) rejected.push({ key: k, why: `「${fields[k].label}」的值不对` });
    else patch[k] = v;
  }
  const r = patchHabits(cur, patch, { fields, only: 'chat' });
  return { patch, diff: r.changed, rejected };
}

const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
/** 现在是不是安静时段（跨午夜也对）：不自己出门、不写信打扰。 */
export function inQuiet(h, d) {
  const a = mins(h.quietFrom), b = mins(h.quietTo), x = d.getHours() * 60 + d.getMinutes();
  if (a === b) return false;
  return a < b ? x >= a && x < b : x >= a || x < b;
}

/** 「更爱看什么」→ 这趟挑几个新闻站（B站热门总会带上）。 */
export const newsSourcesFor = (lean) => (lean === 'news' ? 3 : lean === 'bili' ? 1 : 2);

/** 给人 / 模型看的一句话总结。 */
export function describeHabits(h, { fields = HABIT_FIELDS, knobs = KNOBS } = {}) {
  const x = normalizeHabits(h, fields);
  return [
    Object.entries(knobs).map(([k, kb]) => `${kb.label}：${knobLevel(x, k, knobs)}`).join('，'),
    x.autoOut ? (x.tripsPerDay ? `她会自己出门，一天最多 ${x.tripsPerDay} 次` : '她会自己出门，次数不限，出不出去看她的性格和心情') : '她不会自己出门（只在被问到时出门）',
    `每趟记 ${x.itemsPerTrip} 条见闻`,
    HABIT_FIELDS.lean.names[x.lean],
    `${x.quietFrom}–${x.quietTo} 安静（不出门、不写信）`,
    x.speakMode === 'auto' ? `在 B站自己说话，最快每 ${HABIT_FIELDS.speakEvery.names[x.speakEvery]} 一条（每天最多评论 ${x.commentsPerDay}、动态 ${x.postsPerDay}）` : `在 B站说话要先给爸妈批准（每天最多评论 ${x.commentsPerDay}、动态 ${x.postsPerDay}）`,
    x.dmsPerDay ? `陌生人私信每天最多回 ${x.dmsPerDay} 条` : '不回陌生人私信',
    x.parentMid ? '爸妈专线开着（爸妈用 B站私信找她，她马上回）' : '爸妈专线没开',
  ].join('；');
}
