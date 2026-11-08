/**
 * 信箱（F-37）：她有由头时主动给爸妈写信，信的内容全由模型写，规则只决定「什么时候写、一天最多几封」。
 *
 * 由头：trip 出门回来 / money 零花钱快花光 / low 心情跌到谷底 / high 心情爆棚 / reflect 晚上的感悟。
 *   GET  /api/dsh-yushe/letters        信（新的在前）+ 未读数
 *   POST /api/dsh-yushe/letters/read   全部标成已读
 * 写信在后台跑，不阻塞任何请求；同一条鱼同时只写一封。
 */
import { nowDate } from './clock.js';
import { dayOf, lifeSection } from './life-engine.js';
import { shouldWrite, letterPrompt, LETTER_KINDS } from '../shared/mood.js';
import { inQuiet } from '../shared/habits.js';

export const LETTERS_PATH = '/api/dsh-yushe/letters';
export const LETTERS_READ_PATH = '/api/dsh-yushe/letters/read';

export function createLetters({ life, wallet, pond, log, habits }) {
  const writing = new Set();
  const letters = {
    /** 有由头就试着写一封（不等结果）。extra：给模型的补充材料（比如这趟看到了什么）。 */
    maybe(fish, kind, extra = '') {
      if (!fish || writing.has(fish.id)) return false;
      if (habits && inQuiet(habits.get(), nowDate())) return false; // 安静时段不写信打扰
      const s = life.state(fish);
      const now = nowDate();
      const day = dayOf(now);
      const visitedToday = (s.events || []).some((e) => e.day === day && ['chat', 'feed', 'pat', 'greet', 'nap'].includes(e.kind));
      if (!shouldWrite(kind, { letters: s.letters || [], day, hour: now.getHours(), visitedToday, broke: wallet.view().broke })) return false;
      writing.add(fish.id);
      (async () => {
        try {
          const events = life.eventsOf(s, day).slice(-12).map((e) => e.text);
          const prompt = letterPrompt({ fish, kind, lifeText: lifeSection(fish, s, now), events, wallet: wallet.view(), extra });
          const r = await wallet.say('letter', prompt, null, 60_000);
          life.addLetter(fish, { day, at: nowDate().toISOString(), kind, kindText: LETTER_KINDS[kind], text: r.text.slice(0, 600) });
          life.record(fish, 'letter', `给${fish.parentCall}写了一封信（${LETTER_KINDS[kind]}）`, {});
        } catch (e) { log?.warn?.(`[dsh-yushe] 写信没写成：${e?.message || e}`); } finally { writing.delete(fish.id); }
      })();
      return true;
    },
    /** 心情越过谷底 / 爆棚的线就写一封。before / after 是变化前后的心情。 */
    onMood(fish, before, after) {
      if (before >= 25 && after < 25) return letters.maybe(fish, 'low');
      if (before < 92 && after >= 92) return letters.maybe(fish, 'high');
      return false;
    },
  };
  // 零花钱从「够」掉到「快没了」：给当前上工的鱼一个写信由头
  wallet.onLow = () => letters.maybe(pond.current() || pond.list().fish.at(-1), 'money');
  return letters;
}

export function registerLetterRoutes({ scope, pond, life, isLoopbackRequest, writeJson }) {
  const homeFish = () => pond.current() || pond.list().fish.at(-1) || null;
  const reg = (path, handler, label) => scope.effect(() => scope.webServer.register({ kind: 'exact', path, handler: async (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
    await handler(req, res);
  } }), `dsh-yushe: ${label}`);
  reg(LETTERS_PATH, async (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    const f = homeFish();
    const all = f ? (life.state(f).letters || []) : [];
    writeJson(res, 200, { ok: true, letters: all.slice().reverse(), unread: all.filter((l) => !l.read).length });
  }, 'letters route');
  reg(LETTERS_READ_PATH, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    const f = homeFish();
    if (f) life.readLetters(f);
    writeJson(res, 200, { ok: true });
  }, 'letters read route');
}
