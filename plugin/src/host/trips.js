/**
 * 闲逛正式版的宿主端：出门（被问到答应了 / 自己决定）→ 字条 → headless 真去逛 → 按规则排好这一趟（多久、几张明信片、带回什么）。
 * 寄明信片和回家在 life.state() 里按时间推进（tickTrip），DSH 关着时错过的会在下次打开时一起补上。
 *
 *   trips.start(fish, reason)   reason: 'asked'（问她出门吗）/ 'self'（她自己决定）
 *   trips.autoTick()            每 10 分钟：她想不想自己出门（shared/trip.js wantsToLeave）
 *   trips.useLoop({ tools, model })  任务 51：接上「她自己调工具」的出门（宿主模型能用、零花钱够就走这条；不行退回 headless 老路）
 *   GET/POST /api/dsh-yushe/bag 背包：小东西 + 图鉴进度 + 装备
 */
import { startRoam, trackJob, endJob } from './probe.js';
import { runToolLoop, tripSystem, collectCatalog, parseReport } from './trip-loop.js';
import { createLedger } from '../shared/evidence.js';
import { personaFor, dislikeList } from '../shared/growth.js';
import { acceptNotes, readList, dislikedFrom, recentNoteUrls } from '../shared/notes.js';
import { moodTone } from '../shared/mood.js';
import { nowMs, nowDate } from './clock.js';
import { dayOf, snapshot, asleepAt, lifeSection } from './life-engine.js';
import { NEWS_SOURCES } from './sources.js';
import { readJsonBody } from './game-routes.js';
import { leanOnce } from '../shared/growth.js';
import { wantsToLeave, tripPlan, souvenirsFor, gearEffects, SOUVENIRS, souvenirById, equip, outgoingness } from '../shared/trip.js';
import { pickShots, photoPrompt, translatePrompt, cleanScene, bannedTerms } from '../shared/photo.js';
import { planPostcards } from '../shared/postcard.js';
import { imageApiReady, generatePhoto } from './photos.js';
import { newsSourcesFor } from '../shared/habits.js';
import { createGates } from './gates.js';
// 提示词本体在 src/prompts/note.md（F-80 搬家-2b）：这里只准备变量再 fill
import { fill } from '../shared/prompt.js';
import PROMPTS from '../prompts/_all.js';

export const BAG_PATH = '/api/dsh-yushe/bag';
// 出门次数默认不限（F-50）：出不出门由性格掷骰子；设置里还能手动限

export const LOOP_MIN_TOKENS = 60_000; // 零花钱剩得比这少就走老路（老路一趟约 1.5 万）

/** 出门前贴在门上的字条（本体在 prompts/note.md，搬家-2b）。gearName 空 = 没带装备。 */
export function notePrompt({ persona, lifeText, gearName = '', call }) {
  return fill(PROMPTS.note, {
    persona: persona || '', lifeText: lifeText || '', call,
    gear: gearName ? `，带着${gearName}` : '',
  });
}

export function createTrips({ life, wallet, pond, storage, log, habits, biliRead, gate, memory = null, gates = null }) {
  let loop = null; // { tools(ledger) → 出门用的工具成品, model() → { llm, provider, model } }
  const G = gates || createGates({ habits }); // 没传就自己建一个：行为跟旧的 asleepAt + 安静时段一致
  const noteLine = (f, gear) => `${f.parentCall}，我出去逛逛${gear ? `，带上了${souvenirById(gear)?.name}` : ''}，看到有意思的贴进笔记本，路上给你寄明信片～别担心！`;

  const trips = {
    /** 接上工具出门（宿主建好工具表后调）。 */
    useLoop(l) { loop = l; },
    start(f, reason = 'asked') {
      const s = life.state(f);
      const id = `T${nowMs().toString(36)}`;
      const gear = s.bag?.gear || null;
      const ge = gearEffects(gear);
      // 爱好决定更想去哪逛；戴耳机更爱 B站（新闻站少挑一个）；指南针多逛一个站
      const prefer = {};
      for (const src of NEWS_SOURCES) { const heat = Object.entries(s.growth?.interests || {}).filter(([t]) => t.includes(src.kind) || src.kind.includes(t)).reduce((m, [, v]) => Math.max(m, v.heat), 0); if (heat) prefer[src.kind] = Math.min(1, heat / 100); }
      const hb = habits?.get() || {};
      const k = Math.max(1, newsSourcesFor(hb.lean) + ge.extraSource - (ge.preferBili ? 1 : 0)); // 上网习惯「更爱看什么」+ 装备
      const energyAtStart = snapshot(s).energy;
      life.record(f, 'out', reason === 'self' ? '自己背上小书包出门闲逛了' : '背上小书包出门闲逛了', { energy: -15 });
      if (reason === 'asked') life.grow(f, (g) => leanOnce(g, 'cling', -1, dayOf()));
      if (reason === 'self') life.grow(f, (g) => leanOnce(g, 'cling', -1, dayOf()));
      life.setTrip(f, { id, startedAt: nowMs(), state: 'roaming', reason, gear, note: noteLine(f, gear), cards: [], returnAt: nowMs() + 4 * 3600_000 });
      // 字条让她自己写（花一点零花钱）；写不出来就用上面那句
      wallet.say('note', notePrompt({ persona: f.personaText, lifeText: lifeSection(f, s), gearName: gear ? souvenirById(gear)?.name : '', call: f.parentCall }), null, 30_000)
        .then((r) => { const cur = life.state(f).trip; if (cur?.id === id) life.setTrip(f, { note: r.text.slice(0, 80) }); })
        .catch(() => { /* 用默认字条 */ });
      // 她自己的 B站（M5a）：首页推荐 + 记住的 UP 主的新视频 + 搜她最近最爱的东西；不够再拿热门
      const gatherBili = biliRead ? async () => {
        const items = [], seenBv = new Set();
        const add = (arr, via) => { for (const v of arr || []) if (!seenBv.has(v.bvid)) { seenBv.add(v.bvid); items.push({ ...v, via }); } };
        if (biliRead.loggedIn()) {
          try { add(await biliRead.homeFeed(ge.preferBili ? 10 : 6), '首页推荐'); } catch { /* 风控 / 预算用完就跳过 */ }
          const up = Object.entries(s.growth?.ups || {}).filter(([, u]) => u.n >= 3 && u.mid).sort((a, b) => b[1].n - a[1].n)[0];
          if (up) { try { add(await biliRead.upVideos(up[1].mid, 2), `常看的 ${up[0]}`); } catch { /* 跳过 */ } }
          const fav = Object.entries(s.growth?.interests || {}).sort((a, b) => b[1].heat - a[1].heat).map(([tg]) => tg).find((tg) => tg.length <= 8);
          if (fav) { try { add((await biliRead.search(fav, 3)).map((v) => ({ ...v, tname: v.tname || fav })), `搜「${fav}」`); } catch { /* 跳过 */ } }
        }
        if (items.length < 4) { try { add(await biliRead.popular(8), '热门'); } catch { /* 跳过 */ } }
        return { withCookie: biliRead.loggedIn(), items: items.slice(0, 12) };
      } : null;
      /** 照片（F-74）该不该拍、拍哪条：规则挑（她在游记里写了想拍的那一刻 + 读账打分 + 掷骰 + 今天拍了几张）。 */
      const pickPhotos = (result, seen) => {
        const st = life.state(f), today = dayOf();
        const todayCount = (st.album || []).filter((x) => x.photo && x.trip !== 'test' && x.at && dayOf(new Date(x.at)) === today).length;
        const interests = Object.entries(st.growth?.interests || {}).sort((a, b) => b[1].heat - a[1].heat).slice(0, 5).map(([t]) => t);
        const pick = pickShots({ tripId: id, seen, photo: result.photo || null, ledger: result.ledger || {}, acts: result.acts || {}, interests, gear, todayCount, ready: imageApiReady(storage) });
        log?.info?.(`[dsh-yushe] 照片：${{ 'not-moved': '她没想拍', 'none-qualified': '没有读得够深的', roll: '这趟不拍', 'no-api': '想拍，没配生图 API', cap: '想拍，今天拍够了', ok: `拍 ${pick.shots.length} 张` }[pick.reason] || pick.reason}`);
        return pick;
      };
      /**
       * 明信片（F-84）：途中从外面寄回家。拍中的那几张：她的中文画面 → 一次短调用翻成英文 → 规则清洗 → 生图，画好挂到那张明信片正面；
       * 画不成就还是文字卡（不补拍）。
       */
      const shootPhotos = (pick, seen, pcs) => {
        const banned = bannedTerms(seen);
        pick.shots.slice(0, 2).forEach((x, k) => {
          const pcId = pcs[k]?.id;
          (async () => {
            const scene = await wallet.say('photo', translatePrompt({ moment: x.moment, item: x.item, frame: x.frame, banned }), null, 30_000).then((r) => cleanScene(r.text, banned)).catch(() => '');
            const { id: photoId } = await generatePhoto(storage, photoPrompt({ proto: f.proto, scene, frame: x.frame, gear }));
            if (!life.postcardPhoto(f, pcId, { photo: photoId, frame: x.frame, moment: x.moment || null })) log?.warn?.(`[dsh-yushe] 照片画好了，但找不到那张明信片（${pcId}），没挂上`);
          })().catch((e) => { log?.warn?.(`[dsh-yushe] 照片没画成（明信片就是文字卡）：${e?.message || e}`); });
        });
      };
      /** 这一趟逛完：排便利贴、明信片、照片、想说的话（老路和工具出门共用）。result = { seen, postcard, wantComment?, wantPost?, photo?, ledger?, acts?, notes?, read?, dislikes? } 或 null（没逛成）。 */
      const finish = (result) => {
          const cur = life.state(f).trip;
          if (cur?.id !== id) return;
          if (!result) { life.setTrip(f, { state: 'planned', failed: true, cards: [], souvenirs: [], returnAt: nowMs() + 20 * 60_000 }); return; }
          const seen = result.seen || [];
          // F-82：有便利贴就让途中贴上的那几张正好是便利贴；没有（老路 / 没交游记）照旧用见闻
          const notes = Array.isArray(result.notes) ? result.notes : null;
          const plan = tripPlan({ tripId: id, startedAt: cur.startedAt, seen: notes ? notes : seen, energy: energyAtStart, gear, items: hb.itemsPerTrip || 2 });
          let pick = { shots: [], missed: [] };
          try { pick = pickPhotos(result, seen); } catch (e) { log?.warn?.(`[dsh-yushe] 照片出错：${e?.message || e}`); }
          const postcards = planPostcards({ tripId: id, startedAt: cur.startedAt, durationMs: plan.durationMs, shots: pick.shots, missed: pick.missed, notes: notes || [], seen, text: String(result.postcard || '') });
          life.setTrip(f, { wantComment: result.wantComment || null, wantPost: result.wantPost || null, state: 'planned', seen: seen.slice(0, 12), cards: plan.cards, returnAt: plan.returnAt, postcard: String(result.postcard || '').slice(0, 300), postcards, souvenirs: souvenirsFor({ tripId: id, seen, gear }), tokens: result.tokens || 0, ...(notes ? { notes } : {}), ...(result.read ? { read: result.read.read, scanned: result.read.scanned } : {}), ...(result.dislikes?.length ? { dislikes: result.dislikes } : {}) });
          try { shootPhotos(pick, seen, postcards); } catch (e) { log?.warn?.(`[dsh-yushe] 照片出错：${e?.message || e}`); }
      };
      const roamOld = () => {
        const jobId = startRoam(storage, 4 * 60_000, {
        who: { name: f.name, call: f.parentCall }, prefer, k, gatherBili,
        onDone: (job) => {
          try { if (job.usage?.totalTokens) wallet.chargeTokens('roam', job.usage.totalTokens); } catch { /* 记账失败不影响 */ }
          finish(job.state === 'done' && job.result ? { seen: (job.result.seen || []).filter((x) => x.verified), postcard: job.result.postcard, wantComment: job.result.wantComment, wantPost: job.result.wantPost, tokens: job.usage?.totalTokens || 0 } : null);
        },
      });
      return jobId;
    };
    // 任务 51：她自己调工具出门；宿主模型拿不到 / 零花钱不够 / 循环一开始就出错 → 退回老路
    const w = wallet.view();
    const m = loop?.model?.();
    const canLoop = Boolean(loop && m?.llm && m.provider && m.model && (w.unlimited || (w.left ?? 0) >= LOOP_MIN_TOKENS));
    const jobId = canLoop ? trackJob({ who: { name: f.name, call: f.parentCall }, mode: 'tools' }) : roamOld();
    if (canLoop) {
      const ledger = createLedger(), catalog = new Map(), acts = {}; // acts：她这趟对哪个视频真做了什么（照片打动分用）
      const ACT_TOOLS = new Set(['bili_like', 'bili_collect', 'bili_comment', 'bili_reply']);
      const noteAct = (name, args, r) => { const bv = String(args?.bvid || '').match(/^BV[0-9A-Za-z]{10}$/)?.[0]; if (bv && ACT_TOOLS.has(name) && r && r.ok !== false && !args?.undo) (acts[bv] ||= []).push(name); };
      const tools = loop.tools(ledger).map((t) => ({ ...t, execute: async (args) => { const r = await t.execute(args); collectCatalog(catalog, r); noteAct(t.name, args, r); return r; } }));
      const g = s.growth || {};
      const system = tripSystem({
        persona: (() => { try { return personaFor(f, g) || f.personaText; } catch { return f.personaText; } })(),
        moodText: moodTone(snapshot(s).mood, f.parentCall).text,
        interests: Object.entries(g.interests || {}).sort((x, y) => y[1].heat - x[1].heat).slice(0, 5).map(([t]) => t),
        ups: Object.entries(g.ups || {}).filter(([, u]) => u.mid).sort((x, y) => y[1].n - x[1].n).slice(0, 3).map(([n, u]) => `${n}（mid ${u.mid}）`),
        favZones: hb.favZones || [], avoidWords: hb.avoidWords || [], maxCalls: hb.tripToolCalls || 12, caps: hb,
        dislikes: dislikeList(g), maxNotes: hb.notesPerTrip || 6, // F-82
        // F-76：出门是对外的场合，只带 B站上的记忆（家里的事不带）；最近评论过的视频提醒别重复
        memoryText: (() => { try { return memory?.section?.(f, { scope: 'public', query: Object.keys(g.interests || {}).join(' '), limit: 4, title: '【你在 B站上的记忆】', tail: '模糊的就别说得很肯定；记不清的人当新认识。' }) || ''; } catch { return ''; } })(),
        commented: (() => { try { return memory?.recentlyCommented?.(f) || []; } catch { return []; } })(),
      });
      const prompt = `${gear ? `你带着${souvenirById(gear)?.name}。` : ''}出发吧。先随便逛逛（比如刷首页推荐、看热门、看看关注的人发了什么），遇到喜欢的再看深一点。`;
      let calls = 0;
      runToolLoop({ llm: m.llm, provider: m.provider, model: m.model, system, prompt, tools, maxCalls: hb.tripToolCalls || 12, onCall: () => { calls += 1; } })
        .then((r) => {
          try { if (r.usage.totalTokens) wallet.chargeTokens('roam', r.usage.totalTokens); } catch { /* 记账失败不影响 */ }
          const rep = parseReport(r.text, catalog);
          // 她没交游记（额度 / 时间用完）：用这趟真看过的前几条，明信片让老路的规则补
          const seen = rep.seen.length ? rep.seen : [...catalog.values()].slice(0, 4).map((c) => ({ ...c, verified: true, why: '' }));
          // F-82：便利贴验收（读账封顶、标签、张数、7 天重复）+ 读过清单 + 这趟不喜欢的
          const dump = ledger.dump();
          const notes = rep.parsed ? acceptNotes({ seen: rep.seen, ledger: dump, catalog, cap: hb.notesPerTrip || 6, recent: recentNoteUrls(life.state(f).journal, nowMs()) }) : null; // 没交游记 → null：不贴便利贴，照旧用看过的前几条（设计 5.2）；交了但一张没贴 → []
          const read = readList({ catalog, ledger: dump, acts, verdict: rep.verdict });
          const dislikes = dislikedFrom({ read: read.read, notes: notes || [] });
          log?.info?.(`[dsh-yushe] 工具出门：调了 ${r.calls.length} 次工具（${[...new Set(r.calls.map((c) => c.name))].join('、')}），看过 ${catalog.size} 条，游记 ${rep.seen.length} 条${rep.dropped.length ? `，丢掉编的 ${rep.dropped.length} 条` : ''}，${r.usage.totalTokens} tokens`);
          endJob(jobId, { result: { tools: r.calls, seen } });
          life.setTrip(f, { toolCalls: r.calls.map((c) => c.name).slice(0, 40) });
          finish({ seen, postcard: rep.postcard, tokens: r.usage.totalTokens, photo: rep.seen.length ? rep.photo : null, ledger: dump, acts, notes, read, dislikes });
        })
        .catch((e) => {
          log?.warn?.(`[dsh-yushe] 工具出门出错：${String(e?.message || e).slice(0, 120)}${calls ? '' : '，退回老路'}`);
          endJob(jobId, { state: 'error', error: String(e?.message || e).slice(0, 200) });
          if (!calls) { const old = roamOld(); life.setOut(f, old); } else finish({ seen: [...catalog.values()].slice(0, 4).map((c) => ({ ...c, verified: true, why: '' })), postcard: '', notes: null, read: readList({ catalog, ledger: ledger.dump(), acts }) });
        });
    }
      life.setOut(f, jobId);
      return { id, jobId };
    },
    /** 她自己决定要不要出门（宿主定时器调）。 */
    autoTick() {
      const f = pond.current() || pond.list().fish.at(-1);
      if (!f) return false;
      const hb = habits?.get();
      if (hb && !hb.autoOut) return false; // 上网习惯：不让她自己出门
      if (G.closed('out')) return false; // 出口闸（F-79）：出门要醒着 + 不安静
      const s = life.state(f), snap = snapshot(s), day = dayOf();
      const tripsToday = (s.events || []).filter((e) => e.day === day && e.kind === 'out').length;
      const go = wantsToLeave({ fishId: f.id, now: nowMs(), asleep: asleepAt() || snap.where === 'sleep', out: life.isOut(f), broke: wallet.view().broke, energy: snap.energy, mood: snap.mood, outgoing: outgoingness(s.growth?.pts || f.pts, s.growth?.lean).score, tripsToday, maxPerDay: hb?.tripsPerDay ? hb.tripsPerDay : Infinity, lastBackAt: s.lastBackAt || 0, bias: hb?.outBias ?? 1, restBias: hb?.restBias ?? 1 });
      if (!go) return false;
      log?.info?.(`[dsh-yushe] ${f.name} 自己决定出门闲逛`);
      trips.start(f, 'self');
      return true;
    },
  };
  return trips;
}

export function registerBagRoutes({ scope, pond, life, isLoopbackRequest, writeJson }) {
  const homeFish = () => pond.current() || pond.list().fish.at(-1) || null;
  scope.effect(() => scope.webServer.register({
    kind: 'exact', path: BAG_PATH,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
      const f = homeFish();
      if (!f) return writeJson(res, 200, { ok: true, items: [], gear: null, book: { got: 0, total: SOUVENIRS.length } });
      if (req.method === 'POST') {
        const b = await readJsonBody(req);
        if (!b) return writeJson(res, 400, { ok: false, error: '请求格式不对' });
        if (life.isOut(f)) return writeJson(res, 200, { ok: false, error: '她出门了，回来再换装备吧' });
        life.setBag(f, equip(life.bag(f), b.equip ?? null));
      } else if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
      const bag = life.bag(f);
      const items = Object.entries(bag.items || {}).map(([id, count]) => ({ ...souvenirById(id), count })).filter((x) => x.id);
      writeJson(res, 200, { ok: true, items, gear: bag.gear, book: { got: items.length, total: SOUVENIRS.length, all: SOUVENIRS.map((s) => ({ id: s.id, name: s.name, icon: s.icon, rarity: s.rarity, got: Boolean((bag.items || {})[s.id]) })) } });
    },
  }), 'dsh-yushe: bag route');
}
