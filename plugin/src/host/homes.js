/**
 * 在家上网（F-87 一期-1，docs/设计/15-在家上网.md §3）：醒着在家她也定期自己刷一轮 B站。
 *
 * 照 dreams.js 的样子：宿主 10 分钟定时器调 homes.tick()，到点（homeDue 规则说了算）她自己拿工具刷，
 * 交一份「点开过的每条态度 + 最多一张便利贴」，宿主落账：清单卡一张（homeCards）、便利贴、见闻流水账、记忆（点开的每条都进）、
 * 今天一条事件、精力 −2。**不涨五维**，不产生明信片 / 照片 / 小东西 / 信 / 专题。
 *
 * 和出门的区别：这一期在家不说话——工具只要 read + act，去掉 bili_dms / bili_inbox（不读私信）；run() 里再筛一次，不靠 index.js。
 * 工具结果每条截 3000 字（出门 6000，runToolLoop 的 maxBody）。
 */
import { runToolLoop, homeSystem, collectCatalog, parseHome } from './trip-loop.js';
import { createLedger } from '../shared/evidence.js';
import { homeDue } from '../shared/home.js';
import { readList, acceptNotes, recentNoteUrls } from '../shared/notes.js';
import { entriesFrom } from '../shared/seen.js';
import { personaFor, dislikeList } from '../shared/growth.js';
// 在家刷也是对外场合（心情-一期-3 A）：口气只带对 B站 / 外面的情绪，家里的不进去
import { temperOf, feelSection } from '../shared/feel.js';
import { nowMs } from './clock.js';
import { dayOf, snapshot } from './life-engine.js';

export const HOME_LOOP_MS = 4 * 60_000; // 一轮最多四分钟：到点循环自己收（照样记账、照样留清单）。B站读取每分钟 6 次，一轮会排队一两分钟（F-87 实测 2 分多）
export const HOME_RUN_MS = HOME_LOOP_MS + 90_000; // 外层兜底（工具卡住时），比循环自己的超时长，不抢先打断
export const HOME_BODY_MAX = 3000;     // 工具结果每条截 3000 字（出门是 6000，省 token）

export function createHomes({ life, wallet, pond, habits, biliRead, memory = null, gates = null, log, tools = null, model = null, seenLog = null }) {
  let busy = false;
  const fishNow = () => pond.current() || pond.list().fish.at(-1) || null;
  const noteAct = (acts, name, args, r) => { // 互动成功照 trips 的记法记 acts（清单卡里要标）
    const ACT_TOOLS = new Set(['bili_like', 'bili_collect', 'bili_comment', 'bili_reply']);
    const bv = String(args?.bvid || '').match(/^BV[0-9A-Za-z]{10}$/)?.[0];
    if (bv && ACT_TOOLS.has(name) && r && r.ok !== false && !args?.undo) (acts[bv] ||= []).push(name);
  };

  const homes = {
    /** 现在会不会在家刷；不会就说为什么（status / 调试用）。参数全按 shared/home.js 的 homeDue 凑。 */
    status(fish = fishNow()) {
      if (!fish) return { ok: false, why: '还没有鱼' };
      const s = life.state(fish);
      const hb = habits?.get?.() || {};
      const n = nowMs();
      const lastChatAt = (() => { try { const t = (s.chat || []).filter((c) => c.role === 'user').at(-1)?.at; return t ? Date.parse(t) || 0 : 0; } catch { return 0; } })();
      return homeDue({
        fishId: fish.id,
        now: n,
        enabled: hb.autoHome !== false,
        loggedIn: Boolean(biliRead?.loggedIn?.()),
        asleep: gates ? Boolean(gates.asleep()) : false,
        out: Boolean(life.isOut?.(fish)),
        napping: Boolean(s.napUntil && s.napUntil > n),
        dreaming: Boolean(s.dream?.until && s.dream.until > n),
        energy: snapshot(s).energy,
        broke: Boolean(wallet.view?.()?.broke),
        blocked: Boolean(biliRead?.blocked?.()),
        roundsToday: (s.events || []).filter((e) => e.day === dayOf(new Date(n)) && e.kind === 'home').length,
        perDay: hb.homePerDay ?? 14,
        lastAt: Number(s.lastHomeAt) || 0,
        everyMin: hb.homeEvery ?? 45,
        lastChatAt,
      });
    },

    /** 宿主定时器调。真跑起来是异步的（不阻塞其它出口）。 */
    tick() {
      const f = fishNow();
      if (!f || busy) return false;
      const st = homes.status(f);
      if (!st.ok) return false;
      busy = true;
      log?.info?.(`[dsh-yushe] ${f.name} 在家刷 B站去了`);
      homes.run(f)
        .catch((e) => log?.warn?.(`[dsh-yushe] 在家刷出错：${String(e?.message || e).slice(0, 160)}`))
        .finally(() => { busy = false; });
      return true;
    },

    /** 跑一轮。返回这一轮的清单卡（或 null = 没刷成）。 */
    async run(f) {
      const hb = habits?.get?.() || {};
      const m = model?.();
      const ledger = createLedger(), catalog = new Map(), acts = {};
      const toolList = (tools?.(ledger) || [])
        .filter((t) => t && (t.kind === 'read' || t.kind === 'act') && !['bili_dms', 'bili_inbox'].includes(t.name)) // 这一期在家不说话、不读私信；run 里再筛一次，不靠 index.js
        .map((t) => ({ ...t, execute: async (args) => { const r = await t.execute(args); collectCatalog(catalog, r); noteAct(acts, t.name, args, r); return r; } }));
      const giveUp = (why) => { log?.warn?.(`[dsh-yushe] 在家刷没成：${why}`); try { life.homeEnd(f); } catch { /* 不影响 */ } return null; };
      if (!m?.llm || !m.provider || !m.model) { try { life.homeTry(f); } catch { /* 记账失败不影响 */ } return giveUp('宿主模型拿不到'); }
      if (!toolList.length) { try { life.homeTry(f); } catch { /* 同上 */ } return giveUp('没有能用的读工具'); }

      // 先记「试过」+ 把「在刷 B站」亮出来（失败也算试过，别每 10 分钟重试）
      try { life.homeTry(f); } catch { /* 记账失败不影响 */ }
      try { life.homeStart(f, 5); } catch { /* 显示失败不影响刷 */ }
      const s = life.state(f);
      const g = s.growth || {};
      const system = homeSystem({
        persona: (() => { try { return personaFor(f, g) || f.personaText; } catch { return f.personaText; } })(),
        moodText: feelSection(s.feel, { call: f.parentCall, temper: temperOf(s.growth), scene: 'public' }),
        interests: Object.entries(g.interests || {}).sort((x, y) => y[1].heat - x[1].heat).slice(0, 5).map(([t]) => t),
        ups: Object.entries(g.ups || {}).filter(([, u]) => u.mid).sort((x, y) => y[1].n - x[1].n).slice(0, 3).map(([n]) => n),
        dislikes: (() => { try { return dislikeList(g); } catch { return []; } })(),
        maxCalls: Number(hb.homeCalls) || 8,
        // 今天已经点开过的标题，最多 15 个：让她别又点开着看一遍
        todayTitles: (() => {
          const day = dayOf(new Date(nowMs()));
          return (s.homeCards || []).filter((c) => c.at && dayOf(new Date(Date.parse(c.at) || 0)) === day)
            .flatMap((c) => (c.read || []).map((x) => x.title).filter(Boolean));
        })(),
        memoryText: (() => { try { return memory?.section?.(f, { scope: 'public', query: Object.keys(g.interests || {}).join(' '), limit: 3, title: '【你在 B站上的记忆】', tail: '模糊的就别说得很肯定；记不清的人当新认识。' }) || ''; } catch { return ''; } })(),
      });
      let r;
      const meter = { totalTokens: 0 }; // 边跑边记花了多少：外层超时 / 模型出错也照样记账
      try {
        r = await Promise.race([
          runToolLoop({
            llm: m.llm, provider: m.provider, model: m.model, system,
            prompt: '闲着也是闲着，自己刷会儿 B站。看到感兴趣的点开看看，刷完按说好的交一段 JSON 就行。',
            tools: toolList, maxCalls: Number(hb.homeCalls) || 8, maxBody: 3000, meter, timeoutMs: HOME_LOOP_MS, overNote: '在家刷的工具额度用完了，就交卷吧（只输出 JSON）',
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('在家刷超时')), HOME_RUN_MS).unref?.()),
        ]);
      } catch (e) {
        try { if (meter.totalTokens) wallet.chargeTokens('home', meter.totalTokens); } // 没刷成也是花了钱的，照记（F-87 实测）
        catch (e2) { log?.warn?.(`[dsh-yushe] 在家刷的钱没记上：${String(e2?.message || e2).slice(0, 80)}`); }
        if (seenLog && catalog.size) { try { seenLog.add(f, entriesFrom({ catalog, ledger: ledger.dump(), acts, noted: [], at: new Date(nowMs()).toISOString() })); } catch { /* 只记流水账 */ } }
        try { life.homeEnd(f); } catch { /* 忽略 */ }
        log?.warn?.(`[dsh-yushe] 在家刷没成：${String(e?.message || e).slice(0, 140)}（花了 ${meter.totalTokens} tokens，已记账）`);
        return null;
      }
      try { if (r.usage.totalTokens) wallet.chargeTokens('home', r.usage.totalTokens); }
      catch (e) { log?.warn?.(`[dsh-yushe] 在家刷的钱没记上：${String(e?.message || e).slice(0, 80)}`); } // 花了就是花了，留日志
      if (!r.calls.some((c) => c.ok)) { // 一次成功的工具都没有：不写清单、不记事件
        try { life.homeEnd(f); } catch { /* 忽略 */ }
        log?.info?.(`[dsh-yushe] 在家刷：一次工具都没成（${r.stoppedBy}），这局就当没刷过`);
        return null;
      }
      const rep = parseHome(r.text, catalog);
      const dump = ledger.dump();
      const read = readList({ catalog, ledger: dump, acts, verdict: rep.verdict }); // 没交 JSON 也照记清单（verdict 空）
      let notes = [];
      if (rep.parsed && rep.note) {
        try { notes = acceptNotes({ seen: [rep.note], ledger: dump, catalog, cap: 1, recent: recentNoteUrls(life.state(f).journal, nowMs()) }); }
        catch { notes = []; } // 验收没过就不贴便利贴，清单照记
      }
      if (!read.read.length && !notes.length) { // 只刷了列表、一条都没点开：不写空清单、不占今天的次数
        try { life.homeEnd(f); } catch { /* 忽略 */ }
        if (seenLog && catalog.size) { try { seenLog.add(f, entriesFrom({ catalog, ledger: dump, acts, noted: [], at: new Date(nowMs()).toISOString() })); } catch { /* 只记流水账，失败不影响 */ } }
        log?.info?.(`[dsh-yushe] 在家刷：刷了 ${catalog.size} 个标题，一条都没点开`);
        return null;
      }
      const card = life.homeRound(f, { read: read.read, scanned: read.scanned, note: notes[0] || null, cap: hb.homeCards ?? 100 });
      if (seenLog && catalog.size) { // F-86：这轮刷到的每条都进流水账（写失败只记日志）
        try { seenLog.add(f, entriesFrom({ catalog, ledger: dump, acts, noted: notes, at: new Date(nowMs()).toISOString() })); }
        catch (e) { log?.warn?.(`[dsh-yushe] 见闻流水账没写上（在家刷）：${String(e?.message || e).slice(0, 120)}`); }
      }
      try { life.homeEnd(f); } catch { /* 忽略 */ }
      log?.info?.(`[dsh-yushe] 在家刷：调了 ${r.calls.length} 次工具（${[...new Set(r.calls.map((c) => c.name))].join('、')}），点开 ${read.read.length} 条，${notes.length ? `记了一张便利贴（${rep.dropped.length ? `编的 ${rep.dropped.length} 条丢掉` : '链接都真'}）` : '没写便利贴'}，${r.usage.totalTokens} tokens（${r.stoppedBy}）`);
      return card;
    },
  };
  return homes;
}
