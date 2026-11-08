/**
 * 互动账本（任务 49，08 工具明细第 3 节 + 规矩 G1 / G4 / G5）：点赞、评论点赞、收藏、关注、取关。
 *
 *   act(kind, { cap, mid, key, run, footprint })   一次互动的完整流程：
 *       每天上限（细配置的 cap 字段）→ 对同一个人每天上限（G4，perPersonPerDay）→ 真的发（run）→
 *       认回执（G1：只有 B站明确成功才算；认不出 / 超时算「不确定」，不重试）→ 记账 + 足迹 + 今天的事
 *   follows()                                       她自己关注的名单（只有这里面的能取关）
 *   favFolder() / setFavFolder(id)                  「她喜欢的」收藏夹 id
 *
 * 账本按 B站号存（G5）：<storage>/bili/<mid>/acts.json。换号从零开始，旧号关注的人新号取关不了。
 * 说话类（任务 50）也会用这里的「对同一个人每天上限」。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { accountFile } from './account.js';
import { nowDate } from './clock.js';

export const ACT_NAMES = { like: '点赞', unlike: '取消点赞', comment_like: '给评论点赞', collect: '收藏', follow: '关注', unfollow: '取关' };
const empty = () => ({ days: {}, follows: {}, done: {}, favFolder: null });

export function createActs({ storage, habits, life, gate, pond, log }) {
  const file = () => accountFile(storage, 'acts.json');
  const load = () => { try { return { ...empty(), ...JSON.parse(readFileSync(file(), 'utf8')) }; } catch { return empty(); } };
  const save = (v) => { const f = file(); mkdirSync(dirname(f), { recursive: true }); writeFileSync(`${f}.tmp`, JSON.stringify(v)); renameSync(`${f}.tmp`, f); };
  const day = () => nowDate().toISOString().slice(0, 10);
  const today = (st) => st.days[day()] || { kinds: {}, people: {} };

  const acts = {
    /** 今天这一类做了几次、对这个人互动了几次。 */
    countToday: (kind) => today(load()).kinds[kind] || 0,
    peopleToday: (mid) => today(load()).people[String(mid)] || 0,
    /** 对同一个人每天上限（G4），说话类（任务 50）也调这个。 */
    personAllows(mid) {
      if (!mid) return { ok: true };
      const lim = habits.get().perPersonPerDay ?? 4;
      const n = acts.peopleToday(mid);
      return n >= lim ? { ok: false, why: `今天已经和这个人互动 ${n} 次了（对同一个人每天最多 ${lim} 次），别太热情` } : { ok: true };
    },
    /** 记一次对某人的互动（说话类发出去以后也调）。 */
    notePerson(mid) {
      if (!mid) return;
      const st = load(); const t = today(st);
      t.people[String(mid)] = (t.people[String(mid)] || 0) + 1;
      st.days = { ...Object.fromEntries(Object.entries(st.days).filter(([d]) => d >= day().slice(0, 8))), [day()]: t };
      save(st);
    },
    follows: () => load().follows,
    favFolder: () => load().favFolder,
    setFavFolder(id) { const st = load(); st.favFolder = String(id); save(st); },
    /** 这件事做过没（同一个视频不重复点赞 / 收藏）。 */
    done: (key) => Boolean(load().done[key]),

    /**
     * 一次互动。cap：{ key, label }（细配置里的每天上限字段）；mid：对哪个人（G4，不是对人的给 null）；
     * key：去重用（比如 like:BVxxx）；run：() => Promise<bili-write 的结果>；receipt：工具的回执判定；
     * footprint：{ text, url, target }；already：哪些 B站错误码表示「本来就是这样」（不算失败、不占上限）。
     */
    async act(kind, { cap, mid = null, key = null, run, receipt, footprint = null, already = [], undoKey = null }) {
      const h = habits.get();
      const limit = cap ? Number(h[cap.key] ?? 0) : Infinity;
      const used = acts.countToday(kind);
      if (cap && used >= limit) return { ok: false, capped: true, error: limit ? `今天${ACT_NAMES[kind]}已经 ${used} 次了（每天最多 ${limit}）` : `上网配置里「${cap.label}」是 0` };
      if (key && acts.done(key)) return { ok: true, already: true, hint: `之前已经${ACT_NAMES[kind]}过了` };
      const pa = acts.personAllows(mid); if (!pa.ok) return { ok: false, capped: true, error: pa.why };
      const r = await run();
      if (r?.status === 'rejected' && already.includes(r.code)) { if (key) { const st = load(); st.done[key] = new Date().toISOString(); save(st); } return { ok: true, already: true, hint: `本来就${ACT_NAMES[kind]}过了` }; }
      const rc = receipt(r);
      const status = rc?.ok ? 'sent' : r?.status === 'rejected' ? 'rejected' : 'uncertain'; // G1：认不出的成功 = 不确定
      if (status === 'rejected') return { ok: false, status, error: r.reason || 'B站拒绝了' };
      const st = load(); const t = today(st);
      t.kinds[kind] = (t.kinds[kind] || 0) + 1;
      if (mid) t.people[String(mid)] = (t.people[String(mid)] || 0) + 1;
      st.days = { ...Object.fromEntries(Object.entries(st.days).filter(([d]) => d >= day().slice(0, 8))), [day()]: t };
      if (key) st.done[key] = new Date().toISOString();
      if (undoKey) delete st.done[undoKey];
      const keys = Object.keys(st.done); if (keys.length > 800) for (const k of keys.slice(0, keys.length - 800)) delete st.done[k];
      if (kind === 'follow' && mid) st.follows[String(mid)] = { since: new Date().toISOString(), who: footprint?.target?.who || null };
      if (kind === 'unfollow' && mid) delete st.follows[String(mid)];
      save(st);
      if (footprint) gate?.addFootprint?.({ kind, text: footprint.text, url: footprint.url || null, target: footprint.target || null, uncertain: status === 'uncertain' });
      const f = pond?.current?.();
      if (f && life) life.record(f, `act-${kind}`, `在 B站${ACT_NAMES[kind]}了${footprint?.text ? `：${String(footprint.text).slice(0, 40)}` : ''}${status === 'uncertain' ? '（不确定有没有成功）' : ''}`, kind === 'follow' ? { mood: 2 } : {});
      log?.info?.(`[dsh-yushe] ${ACT_NAMES[kind]}：${status}`);
      return { ok: true, status, ...(status === 'uncertain' ? { hint: 'B站没给明确的回执，不重试；可能已经成功了，去 B站看看' } : {}), today: { used: used + 1, limit: cap ? limit : null } };
    },
  };
  return acts;
}
