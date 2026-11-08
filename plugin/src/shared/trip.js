/**
 * 闲逛正式版（F-29、F-11）：旅行青蛙那套循环的鱼社版。纯函数，宿主 / 游戏 / verify 共用。
 *
 *   她自己决定出门（wantsToLeave）→ 留字条 → headless 真去逛一趟（几十秒就跑完，结果先藏着）
 *   → 这一趟在游戏里持续 1–3 小时（tripPlan），明信片按时间一张张寄回来（cardsDue）
 *   → 回家时带回小东西（souvenirsFor），进背包；装备放进背包会影响下一趟（gearEffects）
 *
 * 规则管结果：什么时候走、走多久、寄几张、带回什么都由规则（可复现）决定；
 * AI 管表达：字条、明信片背面的话、回家后的信都由模型写。
 */
import { hashOf } from './core.js';

/** 小东西图鉴：tag 决定从哪个池子掉；gear 是装备（放进背包会影响下一趟）。icon 对应 assets/icons/<icon>.webp。 */
export const SOUVENIRS = [
  { id: 'catpaw', name: '猫爪贴纸', icon: 'catpaw', rarity: 'N', tags: ['萌宠', '动物', '生活', '猫'], desc: '在萌宠视频底下捡到的，软乎乎的。' },
  { id: 'chip', name: '迷你芯片', icon: 'chip', rarity: 'R', tags: ['科技', 'AI', '数码', '知识'], desc: '据说是某块显卡掉下来的边角料。' },
  { id: 'console', name: '掌上游戏机', icon: 'console', rarity: 'SR', tags: ['游戏', '数码', '动画'], desc: '只能玩一个关卡，但永远玩不腻。' },
  { id: 'starstone', name: '星光石', icon: 'starstone', rarity: 'SR', tags: [], desc: '夜里会发一点点光。哪里都可能捡到，就是很难捡到。' },
  { id: 'shell', name: '小海螺', icon: 'shell', rarity: 'N', tags: ['旅行', '纪录片', '生活'], desc: '贴在耳朵上能听见远方。' },
  { id: 'chime', name: '玻璃风铃', icon: 'chime', rarity: 'R', tags: ['音乐', '生活', 'ASMR'], desc: '风一吹就叮叮当当。' },
  { id: 'bookmark', name: '金书签', icon: 'bookmark', rarity: 'R', tags: ['效率生活', '知识', '历史', '科技'], desc: '夹在一篇很长的好文章里。' },
  { id: 'trophy', name: '迷你奖杯', icon: 'trophy', rarity: 'SR', tags: ['游戏', '体育', '运动'], desc: '谁赢了不重要，她觉得是自己。' },
  { id: 'washi', name: '彩色胶带', icon: 'washi', rarity: 'N', tags: ['手工', '生活', '效率生活', '时尚'], desc: '用来把明信片贴进相册。' },
  { id: 'donut', name: '甜甜圈', icon: 'donut', rarity: 'N', tags: ['美食', '生活'], desc: '吃不到，但闻着很香。' },
  { id: 'clover', name: '四叶草', icon: 'clover', rarity: 'SSR', tags: [], desc: '据说带着它出门，运气会好一点点。' },
  { id: 'lantern', name: '红灯笼', icon: 'lantern', rarity: 'R', tags: ['历史', '旅行', '影视'], desc: '挂在床头，夜里不怕黑。' },
  // 装备：放进背包（一次只能带一件）会影响下一趟
  { id: 'camera', name: '小相机', icon: 'camera', rarity: 'R', gear: '多拍一张照片', tags: ['数码', '旅行', '科技'], desc: '带着它出门，更容易拍下照片、还能多拍一张寄回来，照片里也会拿着它。' },
  { id: 'compass', name: '指南针', icon: 'compass', rarity: 'R', gear: '多逛一个地方', tags: ['旅行', '知识'], desc: '带着它出门，会多去一个新闻站。' },
  { id: 'headphones', name: '大耳机', icon: 'headphones', rarity: 'R', gear: '更爱刷 B站', tags: ['音乐', '游戏', '动画'], desc: '带着它出门，她更想去 B站逛。' },
  { id: 'goggles', name: '潜水镜', icon: 'goggles', rarity: 'N', gear: '回来得早一点', tags: ['纪录片', '旅行', '运动'], desc: '带着它出门，游得快，回来得早。' },
  { id: 'umbrella', name: '小雨伞', icon: 'umbrella', rarity: 'N', tags: ['生活', '旅行'], desc: '下雨天也能出门。' },
  { id: 'telescope', name: '小望远镜', icon: 'telescope', rarity: 'SR', tags: ['科技', '知识', '纪录片'], desc: '能看见很远的东西，比如明天。' },
];
const BY_ID = Object.fromEntries(SOUVENIRS.map((s) => [s.id, s]));
export const souvenirById = (id) => BY_ID[id] || null;
const RARITY_W = { N: 60, R: 28, SR: 10, SSR: 2 };

/** 装备的效果（一次只能带一件）。 */
export function gearEffects(gearId) {
  return {
    extraCard: gearId === 'camera' ? 1 : 0,
    extraSource: gearId === 'compass' ? 1 : 0,
    preferBili: gearId === 'headphones',
    shorter: gearId === 'goggles',
  };
}

/**
 * 她爱不爱出门（F-50）：由现在的五维和性格倾向决定，性格变了出门习惯跟着变。
 *   灵（爱主动）最要紧，智力（好奇）、嘴（爱交际）加一点，心（谨慎）让她更宅；活泼 / 独立的更爱出去，黏人的更想待在家。
 * 返回 { score: 0–1, label, why }。
 */
export function outgoingness(pts = {}, lean = {}) {
  const n = (v) => Math.max(0, Math.min(1, ((Number(v) || 40) - 10) / 85));
  const raw = 0.15 + 0.45 * n(pts.spark) + 0.15 * n(pts.brain) + 0.15 * n(pts.tongue) - 0.20 * n(pts.heart) + 0.03 * (lean.lively || 0) - 0.03 * (lean.cling || 0);
  const score = Math.max(0.05, Math.min(0.95, Math.round(raw * 100) / 100));
  const label = score >= 0.7 ? '小冒险家' : score >= 0.5 ? '爱出门' : score >= 0.3 ? '看心情' : score >= 0.15 ? '有点宅' : '超级宅';
  const why = [];
  if (n(pts.spark) >= 0.55) why.push('爱主动'); else if (n(pts.spark) <= 0.25) why.push('不太主动');
  if (n(pts.brain) >= 0.55) why.push('好奇');
  if (n(pts.heart) >= 0.6) why.push('谨慎恋家');
  if ((lean.cling || 0) >= 3) why.push('黏人'); else if ((lean.cling || 0) <= -3) why.push('独立');
  if ((lean.lively || 0) >= 3) why.push('活泼');
  return { score, label, why };
}

/** 回家后至少歇多久才会再走：越爱出门歇得越短（1–4 小时）。 */
export const restAfterTrip = (score, bias = 1) => Math.round((1 + (1 - score) * 3) * 3600_000 * bias); // bias：细配置 restBias（F-59）

/**
 * 她想不想自己出门（宿主每 10 分钟问一次）。不设次数上限（除非爸妈在设置里限了），出不出门按性格掷骰子：
 * 睡着 / 已在外面 / 没钱 / 太累 / 回家还没歇够 → 不走；否则 概率 = 性格（爱出门程度）× 精力 × 心情。
 * 同一个 10 分钟段结果固定（可复现）。
 */
export function wantsToLeave({ fishId = '', now = Date.now(), asleep = false, out = false, broke = false, energy = 70, mood = 60, outgoing = 0.4, tripsToday = 0, maxPerDay = Infinity, lastBackAt = 0, bias = 1, restBias = 1 } = {}) {
  if (asleep || out || broke) return false;
  if (energy < 40 || tripsToday >= maxPerDay) return false;
  if (now - lastBackAt < restAfterTrip(outgoing, restBias)) return false;
  // bias：细配置 outBias（「爱不爱出门」档位：宅 0.5 / 看性格 1 / 爱逛 1.8），乘在性格算出的概率上
  const p = Math.max(0.003, Math.min(0.6, (0.005 + 0.25 * outgoing ** 1.5) * (0.6 + (energy - 40) / 100) * (0.8 + (mood - 50) / 250) * bias));
  return (hashOf(fishId, 'leave', Math.floor(now / 600_000)) % 1000) / 1000 < p;
}

/**
 * 这一趟的安排：走多久（1–3 小时，潜水镜 ×0.6）、明信片几张、什么时候寄到。
 * seen：她这趟真看了的（已核实）条目；energy：出门前的精力（≥ 80 多寄一张）。
 */
export function tripPlan({ tripId = '', startedAt = Date.now(), seen = [], energy = 70, gear = null, items = 2 } = {}) {
  const ge = gearEffects(gear);
  const hours = (1 + (hashOf(tripId, 'len') % 200) / 100) * (ge.shorter ? 0.6 : 1);
  const durationMs = Math.round(hours * 3600_000);
  const want = items + (energy >= 80 ? 1 : 0) + ge.extraCard; // items：上网习惯「每趟记几条见闻」
  const picks = seen.filter((x) => x.verified).slice(0, want);
  const cards = picks.map((x, i) => ({ deliverAt: startedAt + Math.round(durationMs * (i + 1) / (picks.length + 1)), title: x.title, url: x.url, source: x.source, why: x.why || '', tag: x.tag || '' }));
  return { returnAt: startedAt + durationMs, durationMs, cards };
}

/** 到时间了的明信片（还没寄出的）。 */
export const cardsDue = (cards, now) => (cards || []).filter((c) => !c.sent && c.deliverAt <= now);

/**
 * 回家带什么：1–2 件（四叶草 / 星光石哪儿都能掉但很稀有）；看过的东西的 tag 决定池子，稀有度按权重抽。
 */
export function souvenirsFor({ tripId = '', seen = [], gear = null } = {}) {
  const tags = new Set(seen.map((x) => x.tag).filter(Boolean));
  const n = 1 + (hashOf(tripId, 'n') % 100 < 35 ? 1 : 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    // 看过的东西对得上 tag 的那些；一件都对不上就从普通（N）里挑；「哪儿都能掉」的稀有货（星光石、四叶草）总在池子里，但权重低
    const fresh = (s) => !out.includes(s.id);
    let matched = SOUVENIRS.filter((s) => fresh(s) && s.tags.length && s.tags.some((t) => [...tags].some((x) => x.includes(t) || t.includes(x))));
    if (!matched.length) matched = SOUVENIRS.filter((s) => fresh(s) && s.tags.length && s.rarity === 'N');
    const usable = [...matched, ...SOUVENIRS.filter((s) => fresh(s) && !s.tags.length)];
    const total = usable.reduce((sum, s) => sum + RARITY_W[s.rarity], 0);
    let r = hashOf(tripId, 'pick', i) % total;
    for (const s of usable) { r -= RARITY_W[s.rarity]; if (r < 0) { out.push(s.id); break; } }
  }
  return out;
}

/** 背包：{id: 数量}；一次只能装备一件（gear）。 */
export function addToBag(bag, ids) {
  const items = { ...(bag?.items || {}) };
  for (const id of ids) if (BY_ID[id]) items[id] = (items[id] || 0) + 1;
  return { items, gear: bag?.gear && items[bag.gear] ? bag.gear : null };
}
export function equip(bag, id) {
  if (id === null) return { ...bag, gear: null };
  if (!BY_ID[id]?.gear || !(bag?.items || {})[id]) return bag;
  return { ...bag, gear: id };
}
