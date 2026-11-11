/**
 * 两周模拟评测（一期-3，docs/任务书/记忆-一期-3-接口.md，docs/设计/10-记忆升级计划.md 一期-3）。
 * createSim：假时钟 + 假模型。档案（life / 足迹 / 信箱 / 私信）在内存里维护，喂给真的
 * createMemory（plugin/src/host/memory.js，now 传模拟时钟）；经历照真规则存进临时目录、慢慢忘。
 *
 * night() 表示「过完这一天」：写当天日记、按当天反思（reflect 的「今天想过了」按本机日子挡住）、再写周记 / 章节（三期 summarize），
 * 最后把时钟拨到第二天本机 08:00——所以每次 night() 都是一个新的日子。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/host/memory.js';
import { localDay } from '../src/shared/memory.js';

const TEMP_DIRS = [];
process.on('exit', () => { for (const d of TEMP_DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力而为 */ } } });

const DEFAULT_DIARY = '夜里睡前想了想，明天还是想再出门一次。';

export function createSim({ start = new Date(), model: userModel, parentMid = '', memoryDays = 30 } = {}) {
  const begin = start instanceof Date ? start.getTime() : Number(start);
  if (!Number.isFinite(begin)) throw new Error('start 要给一个 Date 或毫秒数');
  const st = { now: begin };
  const midnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const beginMidnight = midnight(begin);

  // 假模型：每次真的调用了都计数（返回还是 throw 都算）
  const counts = { diary: 0, reflect: 0, weekly: 0, chapter: 0 }; // 三期：周记 / 章节也计数
  const model = (kind, prompt) => {
    if (kind in counts) counts[kind] += 1;
    if (userModel) return userModel(kind, prompt);
    return kind === 'reflect' ? '{"add":[]}' : DEFAULT_DIARY;
  };
  const wallet = { say: async (kind, prompt) => ({ text: model(kind, prompt) }) };

  // 档案在内存里维护（形状和 archiveItems 读的一致）
  const life = { events: [], chat: [], diary: [], journal: [], album: [], homeCards: [] }; // 五期-1b：homeCards = 在家刷 B站的清单卡
  const footprints = [];
  const inbox = [];
  const dms = [];
  let seq = 0, lastTs = 0;
  const tick = () => { lastTs = Math.max(st.now, lastTs + 1); return lastTs; }; // 同一刻的多件事给不同的毫秒（游标 / key 去重都按 at 对比）
  const atIo = () => new Date(tick()).toISOString();

  const habits = { get: () => ({ memoryDays, memoryRecall: 5, parentMid }) };
  const fish = { id: 'sim', name: '模拟鱼', parentCall: '妈妈', personaText: '我是一条模拟鱼。' };
  const storage = mkdtempSync(join(tmpdir(), 'yushe-memsim-'));
  TEMP_DIRS.push(storage); // 进程退出时清掉（总指挥验收时加）
  const memory = createMemory({
    storage,
    life: { state: () => life },
    gate: { footprints: () => footprints },
    inbox: { all: () => inbox },
    dms: { view: () => ({ convs: dms }) },
    habits,
    now: () => st.now,
  });

  const dmConv = (mid, who) => {
    let c = dms.find((x) => String(x.mid) === String(mid));
    if (!c) { c = { mid: String(mid), who, history: [] }; dms.push(c); }
    if (who) c.who = who;
    return c;
  };

  const sim = {
    /** 当前模拟时间（毫秒）。 */
    now: () => st.now,
    /** 时钟往前拨 hours 小时。 */
    advance(hours) { st.now += hours * 3600e3; },
    /** 第几天：start 那天是第 1 天（按本机日子算）。 */
    day() { return Math.round((midnight(st.now) - beginMidnight) / 86400e3) + 1; },

    /* ---- 往档案里加事（时间都是当前模拟时间） ---- */
    chat(parentSays, fishSays) { const t = atIo(); life.chat.push({ role: 'user', text: parentSays, at: t }, { role: 'fish', text: fishSays, at: t }); },
    mood(text) { const t = atIo(); life.events.push({ kind: 'mood', text, at: t, day: localDay(t) }); },
    /** journal 里一条带 seen；没给 url 自动生成唯一的占位链接（archiveItems 会丢掉没有 url 的见闻）。 */
    seen({ title = '', url = '', tag = '' } = {}) { life.journal.push({ text: '', at: atIo(), seen: [{ title, url: url || `https://example.com/seen/${++seq}`, tag }] }); },
    comment({ text = '', title = '', bvid = '' } = {}) { footprints.push({ id: `c${++seq}`, kind: 'comment', text, at: atIo(), target: { title, bvid } }); },
    gotReply({ who = '', mid = '', text = '', mine } = {}) {
      const x = { id: `r${++seq}`, kind: 'reply', who, mid, text, at: atIo() };
      if (typeof mine === 'string') x.mine = mine; // mine 不是字符串就当没有
      inbox.push(x);
    },
    dm({ who = '', mid = '', text = '' } = {}) { dmConv(mid, who).history.push({ from: 'them', text, at: atIo() }); },
    tell(text) { return memory.tell(fish, text); },
    /** 五期-1b：在家刷了一轮 B站（清单卡）。read = [{ title, url?, tag?, depth: 'title'|'detail'|'comments'|'subtitle', acts?: [] }]；没给 url 自动生成。 */
    home(read = []) { life.homeCards.push({ at: atIo(), read: read.map((x) => ({ ...x, url: x.url || `https://www.bilibili.com/video/BV1${String(++seq).padStart(9, '0')}` })) }); },

    /** 调一次 memory.sync（minGapMs: 0，每次都真同步）。 */
    sync() { return memory.sync(fish, { minGapMs: 0 }); },

    /**
     * 睡前：model('diary', prompt) 写当天日记（写进 life.diary，ai: true）→ memory.reflect 当天反思
     * （wallet.say 转调 model，reflect 自己接住 throw）。模型 throw broke → 日记不写、不反思，正常返回。
     * 任何情况都不往外抛。最后把时钟拨到第二天本机 08:00（过完这一天）。
     */
    async night() {
      const day = localDay(st.now);
      const parts = [];
      for (const c of life.chat) if (c.at && localDay(c.at) === day) parts.push(c.role === 'user' ? `爸妈说：${c.text}` : `本鱼回：${c.text}`);
      for (const e of life.events) if (e.at && localDay(e.at) === day) parts.push(e.text);
      for (const j of life.journal) if (j.at && localDay(j.at) === day) for (const x of j.seen || []) parts.push(`看到《${x.title}》`);
      for (const f of footprints) if (f.at && localDay(f.at) === day) parts.push(`在 B站发言：${f.text}`);
      const prompt = `今天（${day}）家里和 B站上发生的事：${parts.join('；') || '没什么特别的事'}。睡前写日记。`;
      const nextMorning = () => { const d = new Date(st.now); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); st.now = d.getTime(); };
      try {
        const text = String(model('diary', prompt));
        life.diary.push({ day, text, ai: true, at: atIo() });
      } catch (e) { // throw broke：日记不写、不反思，正常返回
        nextMorning();
        return { diary: { ok: false }, reflect: { ok: false, why: e?.broke ? '零花钱花光了，先不想' : String(e?.message || e).slice(0, 60) } };
      }
      let reflect;
      try { reflect = await memory.reflect(fish, wallet, { day }); }
      catch (e) { reflect = { ok: false, why: String(e?.message || e).slice(0, 60) }; }
      let summarize; // 三期：反思之后写周记 / 章节（自己接住 throw）
      try { summarize = await memory.summarize(fish, wallet, { day }); }
      catch (e) { summarize = { ok: false, why: String(e?.message || e).slice(0, 60) }; }
      nextMorning();
      return { diary: { ok: true }, reflect, summarize };
    },

    /** 连着过 n 天：每天 perDay(sim, i)（i 从 1 起）→ sync() → night()（夜里把时钟拨到第二天 08:00）。 */
    async runDays(n, perDay) {
      for (let i = 1; i <= n; i++) {
        await perDay(sim, i);
        sim.sync();
        await sim.night();
      }
    },

    /* ---- 看结果 ---- */
    /** 给模型的那段记忆文字。main = 主会话（scope all、不带原话）；room = 鱼社聊天（可带 query）；public = 出门 / 写评论。 */
    section(where, query) {
      if (where === 'main') return memory.section(fish, { scope: 'all', quotes: false });
      if (where === 'public') return memory.section(fish, { scope: 'public' });
      return memory.section(fish, { scope: 'all', ...(query ? { query } : {}) });
    },
    recall(query, scope = 'all') { return memory.recall(fish, { query, scope }); },
    /** 当前存档（只读：别改它）。 */
    mem() { return memory.sync(fish, { minGapMs: 1e12 }); },
    /** 模型调用计数 { diary, reflect, weekly, chapter, total }。 */
    calls() { return { ...counts, total: counts.diary + counts.reflect + counts.weekly + counts.chapter }; },
  };
  return sim;
}
