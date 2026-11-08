/**
 * 鱼塘：领养过的鱼存在 <storage>/pond.json；「当前上工的鱼」由 current 指向。
 *
 * 领养时宿主端不信客户端给的数：
 *   - 稀有度 / 原始五维由 seed + 鱼种 + cast 重新推一遍（可复现规则，AI 管表达、规则管结果）；
 *   - 首颗卵的 SR 保底只在鱼塘为空时承认；
 *   - 200 点必须总和 200、每维 10–80；
 *   - 名字 / 自称 / 称呼过注入检查，身世改写清洗截断；
 * 然后由宿主渲染人设正文，注入时直接用。
 */
import { isHome, DEFAULT_HOME } from '../shared/homes.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROTOS, TALENTS, BANS, ATTR_KEYS, roll, checkName } from '../shared/core.js';
import { TOTAL, MIN, MAX, backstory, renderPersonaV2, personality, STORY_FIELDS } from '../shared/life.js';

const RARITIES = ['N', 'R', 'SR', 'SSR', 'UR'];
const cleanLine = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f`#*>\[\]<]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function createPond(dir) {
  const file = join(dir, 'pond.json');
  const read = () => {
    try { const j = JSON.parse(readFileSync(file, 'utf8')); if (j && Array.isArray(j.fish)) return j; } catch { /* 没有或坏了 */ }
    return { version: 1, current: null, fish: [] };
  };
  const write = (data) => {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  };
  let cache = read();

  return {
    list: () => cache,
    current: () => cache.fish.find((f) => f.id === cache.current) || null,
    setCurrent(id) {
      if (id !== null && !cache.fish.some((f) => f.id === id)) throw new Error('没有这条鱼');
      cache = { ...cache, current: id };
      write(cache);
      return this.current();
    },
    /** 换她的家（F-49）。 */
    setHome(id, home) {
      if (!isHome(home)) throw new Error('没有这间房');
      if (!cache.fish.some((f) => f.id === id)) throw new Error('没有这条鱼');
      cache = { ...cache, fish: cache.fish.map((f) => (f.id === id ? { ...f, home } : f)) };
      write(cache);
      return cache.fish.find((f) => f.id === id);
    },
    /** 她在哪个工作区上工（F-62）：{id,title,path} 或 null（所有工作区）。 */
    setWorkspace(id, ws) {
      if (!cache.fish.some((f) => f.id === id)) throw new Error('没有这条鱼');
      const v = ws && ws.id && ws.path ? { id: String(ws.id), title: String(ws.title || '').slice(0, 40), path: String(ws.path) } : null;
      cache = { ...cache, fish: cache.fish.map((f) => (f.id === id ? { ...f, workspace: v } : f)) };
      write(cache);
      return cache.fish.find((f) => f.id === id);
    },
    /** 校验 + 渲染 + 落盘；返回存好的鱼。 */
    adopt(spec) {
      const fish = buildFish(spec, { firstEgg: cache.fish.length === 0 });
      cache = { ...cache, current: fish.id, fish: [...cache.fish, fish] };
      write(cache);
      return fish;
    },
  };
}

export function buildFish(spec, { firstEgg = false } = {}) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const seed = String(s.seed || '');
  if (!/^[0-9a-f]{16}$/.test(seed)) throw new Error('鱼卵码不对');
  if (!PROTOS[s.proto]) throw new Error('没有这个鱼种');
  const cast = Number.isInteger(s.cast) && s.cast >= 0 && s.cast < 3 ? s.cast : 0;
  const minRarity = firstEgg && cast === 0 && s.minRarity === 'SR' ? 'SR' : null;
  const base = roll(seed, s.proto, cast, minRarity);

  const pts = {};
  for (const k of ATTR_KEYS) pts[k] = Number(s.pts?.[k]);
  const vals = Object.values(pts);
  if (vals.some((v) => !Number.isInteger(v) || v < MIN || v > MAX) || vals.reduce((a, b) => a + b, 0) !== TOTAL) throw new Error(`五维必须是整数、每项 ${MIN}–${MAX}、合计 ${TOTAL}`);

  const name = cleanLine(s.name, 16) || PROTOS[s.proto].defaultName;
  const self = cleanLine(s.self, 6) || PROTOS[s.proto].selfDefault;
  const parentCall = cleanLine(s.parentCall, 6) || '妈妈';
  for (const [label, v] of [['名字', name], ['自称', self], ['称呼', parentCall]]) {
    const err = checkName(v);
    if (err) throw new Error(`${label}：${err}`);
  }
  const tics = (Array.isArray(s.tics) ? s.tics : []).map((t) => cleanLine(t, 12)).filter(Boolean).slice(0, 2);
  const ban = [...new Set(['politics', 'flame', ...(Array.isArray(s.ban) ? s.ban : [])])].filter((id) => BANS.some((b) => b.id === id));
  const talentIds = (Array.isArray(s.talentIds) ? s.talentIds : []).filter((id) => TALENTS[id]).slice(0, 2);
  if (talentIds.length < 2) throw new Error('天赋不对');

  const salts = {};
  for (const [f] of STORY_FIELDS) if (Number.isInteger(s.salts?.[f]) && s.salts[f] >= 0 && s.salts[f] < 1000) salts[f] = s.salts[f];
  const overrides = {};
  for (const [f] of STORY_FIELDS) if (s.overrides?.[f]) overrides[f] = cleanLine(s.overrides[f], 60);
  const story = backstory(seed, s.proto, base.rarity, pts, salts, overrides);
  const date = new Date().toISOString().slice(0, 10);
  const talents = talentIds.map((id) => TALENTS[id]);
  const personaText = renderPersonaV2({ proto: s.proto, pts, story, parentCall, name, self, tics, ban, talents, date });

  return {
    id: `fish-${randomUUID().slice(0, 8)}`,
    seed, proto: s.proto, cast, rarity: RARITIES.includes(base.rarity) ? base.rarity : 'N',
    name, self, parentCall, tics, ban, talentIds, pts, salts, overrides, story,
    personality: personality(pts).tag,
    home: isHome(s.home) ? s.home : DEFAULT_HOME,
    personaText,
    firstWords: cleanLine(s.firstWords, 120) || '',
    createdAt: new Date().toISOString(),
  };
}
