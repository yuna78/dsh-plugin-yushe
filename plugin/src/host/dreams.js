/**
 * 梦游（F-79，docs/设计/11-梦游.md）：睡觉时段里，她自己在梦里刷一轮 B站。
 *
 *   dreams.tick()    宿主 10 分钟定时器调：到点、她还在睡、闸开着、今晚没梦过、零花钱够 → 梦一轮
 *   dreams.status()  现在会不会梦 / 为什么不会（日志、verify、调试用）
 *
 * 和出门的区别（这是这条功能的核心）：
 *   - 工具表只给 read（22 个读工具），一个动手的都没有；run() 里再筛一次，不靠调用方
 *   - 不产生明信片 / 照片 / 小东西 / 信 / 评论 / 动态 / 私信
 *   - 产物只有：见闻里一条 `dream: true` 的「梦」+ 今天一条 dream 事件 + 精力代价
 *   - 链接照样只认这趟工具真返回过的（和游记同一套 catalog 核实）
 *   - 一次没读成 / 模型没给 JSON → 不落账、不扣精力（失败不算梦，但有次数上限免得整夜重试）
 *   - 单次 token 有上限（dreamBudget），超了循环自己收尾
 */
import { runToolLoop, dreamSystem, collectCatalog, parseDream } from './trip-loop.js';
import { dreamDue, dreamWordsOk, dreamTemplate, DREAM_BUDGET_MIN } from '../shared/dream.js';
import { entriesFrom } from '../shared/seen.js';
import { personaFor } from '../shared/growth.js';
// 梦里刷 B站也是对外场合（心情-一期-3 A）：口气只带对 B站 / 外面的情绪，家里的不进去
import { temperOf, feelSection } from '../shared/feel.js';
import { nowMs } from './clock.js';
import { dayOf } from './life-engine.js';

export const DREAM_TOOL_CALLS = 6;   // 浅档：读六次就够做梦了
export const DREAM_MAX_TRIES = 2;    // 一晚最多试两次（第一次失败允许再试一次，别整夜重试）

export function createDreams({ life, wallet, pond, habits, biliRead, memory = null, gates = null, log, tools = null, model = null, seenLog = null }) {
  let busy = false;
  const fishNow = () => pond.current() || pond.list().fish.at(-1) || null;
  // F-86：梦里刷到的每一条也进流水账（写失败只记日志，不影响梦本身）
  const logSeen = (f, catalog, noted) => {
    if (!seenLog || !catalog?.size) return;
    try { seenLog.add(f, entriesFrom({ catalog, ledger: {}, acts: {}, noted, at: new Date(nowMs()).toISOString() })); }
    catch (e) { log?.warn?.(`[dsh-yushe] 见闻流水账没写上（梦）：${String(e?.message || e).slice(0, 120)}`); }
  };
  // 一晚一次：events 会被 MAX_EVENTS 裁掉，所以同时看 lastDreamDay（写梦时落的那一格）
  const dreamsOn = (s, day) => Math.max((s.events || []).filter((e) => e.day === day && e.kind === 'dream').length, s.lastDreamDay === day ? 1 : 0);
  const triesOn = (s, day) => (s.dreamTries?.day === day ? Number(s.dreamTries.n) || 0 : 0);

  const dreams = {
    /** 现在会不会梦；不会就说为什么（不出错、不写半条记录）。 */
    status(fish = fishNow()) {
      if (!fish) return { ok: false, why: '还没有鱼' };
      const day = dayOf();
      const s = life.state(fish);
      const hb = habits.get();
      const w = wallet.view();
      if (biliRead?.blocked?.()) return { ok: false, why: 'B站风控中，先不梦游', at: null, done: dreamsOn(s, day) };
      const u = biliRead?.usage?.();
      if (u && Number(u.today) >= Number(u.budget)) return { ok: false, why: '今天的读次数用完了', at: null, done: dreamsOn(s, day) };
      if (triesOn(s, day) >= DREAM_MAX_TRIES) return { ok: false, why: '今晚试过了，别再试', at: null, done: dreamsOn(s, day) };
      const d = dreamDue({
        fishId: fish.id,
        day,
        now: nowMs(),
        asleep: gates ? gates.asleep() : false,
        enabled: hb.dreamEnabled !== false,
        perNight: hb.dreamPerNight ?? 1,
        doneTonight: dreamsOn(s, day),
        left: w.left,
        unlimited: Boolean(w.unlimited),
        budget: DREAM_BUDGET_MIN, // 门槛用固定线；「一次最多花多少」由 maxTokens 真截断
        loggedIn: Boolean(biliRead?.loggedIn?.()),
        out: Boolean(life.isOut?.(fish)),
      });
      return { ...d, at: d.at ? new Date(d.at).toISOString() : null, done: dreamsOn(s, day), tries: triesOn(s, day) };
    },

    /** 宿主定时器调。真跑起来是异步的（不阻塞其它出口）。 */
    tick() {
      const f = fishNow();
      if (!f || busy) return false;
      const st = dreams.status(f);
      if (!st.ok) return false;
      busy = true;
      log?.info?.(`[dsh-yushe] ${f.name} 做梦去了`);
      dreams.run(f)
        .catch((e) => log?.warn?.(`[dsh-yushe] 梦游出错：${String(e?.message || e).slice(0, 160)}`))
        .finally(() => { busy = false; });
      return true;
    },

    /** 跑一轮。返回这一场梦（或 null）。 */
    async run(f) {
      const hb = habits.get();
      const m = model?.();
      // 只读：调用方传什么都在这里再筛一次，别指望 index.js 那一行
      const toolList = (tools?.() || []).filter((t) => t && t.kind === 'read');
      const giveUp = (why) => { log?.warn?.(`[dsh-yushe] 梦游没成：${why}`); try { life.dreamTry(f); } catch { /* 记账失败不影响 */ } return null; };
      if (!m?.llm || !m.provider || !m.model) return giveUp('宿主模型拿不到');
      if (!toolList.length) return giveUp('没有只读工具');
      // 一晚一次的保护在 status() 里，run() 自己也守一道：直接调 run 也不能梦第二次
      if (dreamsOn(life.state(f), dayOf()) >= Number(hb.dreamPerNight ?? 1)) { log?.info?.('[dsh-yushe] 梦游：今晚已经梦过了'); return null; }

      let s = life.state(f);
      try { life.dreamTry(f); } catch { /* 记账失败不影响 */ }
      try { life.dreamStart(f, 20); } catch { /* 显示失败不影响做梦 */ }
      const g = s.growth || {};
      const catalog = new Map();
      const list = toolList.map((t) => ({
        ...t,
        execute: async (args) => { const r = await t.execute(args); collectCatalog(catalog, r); return r; },
      }));
      const system = dreamSystem({
        persona: (() => { try { return personaFor(f, g) || f.personaText; } catch { return f.personaText; } })(),
        moodText: feelSection(s.feel, { call: f.parentCall, temper: temperOf(s.growth), scene: 'public' }),
        interests: Object.entries(g.interests || {}).sort((x, y) => y[1].heat - x[1].heat).slice(0, 5).map(([t]) => t),
        maxCalls: DREAM_TOOL_CALLS,
        // 梦里也是对外场合（看的是 B站的东西），只带 B站上的记忆，不带家里的事
        memoryText: (() => { try { return memory?.section?.(f, { scope: 'public', query: Object.keys(g.interests || {}).join(' '), limit: 3, title: '【你在 B站上的记忆】', tail: '模糊的就别说得很肯定；记不清的人当新认识。' }) || ''; } catch { return ''; } })(),
      });
      let r;
      const meter = { totalTokens: 0 }; // 边跑边记花了多少：外层超时 / 模型出错也照样记账（F-87 实测发现的漏账）
      try {
        r = await Promise.race([
          runToolLoop({
          llm: m.llm, provider: m.provider, model: m.model, system,
          prompt: '闭上眼，梦里接着刷 B站。随便逛逛，看到有意思的多看两眼。',
            tools: list, maxCalls: DREAM_TOOL_CALLS, maxTokens: Number(hb.dreamBudget) || DREAM_BUDGET_MIN, meter, timeoutMs: 180_000,
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('梦游超时')), 270_000).unref?.()),
        ]);
      } catch (e) {
        try { if (meter.totalTokens) wallet.chargeTokens('dream', meter.totalTokens); } // 没梦成也是花了钱的，照记
        catch (e2) { log?.warn?.(`[dsh-yushe] 梦游的钱没记上：${String(e2?.message || e2).slice(0, 80)}`); }
        try { life.dreamEnd(f); } catch { /* 忽略 */ }
        logSeen(f, catalog, []); // 循环中断也把刷到的留下（F-86：拿到 catalog 就记）
        log?.warn?.(`[dsh-yushe] 梦游没成：${String(e?.message || e).slice(0, 140)}`);
        return null;
      }
      try { if (r.usage.totalTokens) wallet.chargeTokens('dream', r.usage.totalTokens); }
      catch (e) { log?.warn?.(`[dsh-yushe] 梦游的钱没记上：${String(e?.message || e).slice(0, 80)}`); } // 花了就是花了，至少留一条日志
      const okReads = r.calls.filter((c) => c.ok).length;
      const rep = parseDream(r.text, catalog);
      logSeen(f, catalog, rep.seen); // F-86：不管写不写梦，这趟刷到的都在流水账里
      if (!okReads) { try { life.dreamEnd(f); } catch { /* 忽略 */ } log?.info?.(`[dsh-yushe] 梦游：一次也没读成（${r.stoppedBy}），不写梦`); return null; }
      if (!rep.parsed) { try { life.dreamEnd(f); } catch { /* 忽略 */ } log?.info?.(`[dsh-yushe] 梦游：模型没交 JSON（${r.stoppedBy}），不写梦`); return null; }
      const pool = rep.seen.length ? rep.seen : [...catalog.values()];
      const text = dreamWordsOk(rep.dream) ? rep.dream : dreamTemplate(pool);
      const record = life.dream(f, { text, seen: rep.seen });
      log?.info?.(`[dsh-yushe] 梦游：调了 ${r.calls.length} 次工具（${[...new Set(r.calls.map((c) => c.name))].join('、')}），看过 ${catalog.size} 条，留下 ${rep.seen.length} 条${rep.dropped.length ? `，丢掉编的 ${rep.dropped.length} 条` : ''}，${r.usage.totalTokens} tokens（${r.stoppedBy}）`);
      return record;
    },
  };
  return dreams;
}
