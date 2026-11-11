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
import { writeDraft } from './tools/writer.js';
import { videoMaterial } from './tools/speak/comment.js';
import { createLedger } from '../shared/evidence.js';
import { personaFor, dislikeList } from '../shared/growth.js';
import { acceptNotes, readList, dislikedFrom, recentNoteUrls } from '../shared/notes.js';
import { entriesFrom } from '../shared/seen.js';
// 出门是对外场合（心情-一期-3 A）：给模型的口气只带对 B站 / 外面的情绪（feelSection scene:'public'），家里的不进去
// 二期-1b：她自己想不想出门看 behaviorOf 的出门倾向（outBias）
import { temperOf, feelSection, behaviorOf } from '../shared/feel.js';
import { nowMs, nowDate } from './clock.js';
import { dayOf, snapshot, asleepAt, lifeSection, TRIP_OUT_ENERGY } from './life-engine.js';
import { NEWS_SOURCES } from './sources.js';
import { readJsonBody } from './game-routes.js';
import { leanOnce } from '../shared/growth.js';
import { wantsToLeave, tripPlan, souvenirsFor, gearEffects, STAY_SCALE, SOUVENIRS, souvenirById, equip, outgoingness } from '../shared/trip.js';
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

/**
 * 兜底补评论时挑哪几个视频（规则管结果，模型只管写正文）：
 * 只挑这趟**真点开看过**（detail，或读过评论 / 字幕 / 弹幕）、还没评过的；点开过的排前面，最多 4 个。
 * want = 这趟还差几条。
 */
export function commentTargets({ catalog, ledger, acts = {}, recently = [], want = 2 } = {}) {
  const skip = new Set(Object.keys(acts || {}).filter((bv) => (acts[bv] || []).includes('bili_comment')));
  for (const bv of recently || []) skip.add(String(bv));
  const deep = (bv) => ['comments', 'subtitle', 'danmaku'].some((l) => ledger?.has?.(bv, l));
  const entries = [...(catalog?.entries?.() || [])].filter(([bv, v]) => /^BV[0-9A-Za-z]{10}$/.test(bv) && v && !skip.has(bv) && (v.via === 'detail' || deep(bv)));
  const ordered = [...entries.filter(([, v]) => v.via === 'detail'), ...entries.filter(([, v]) => v.via !== 'detail')];
  return ordered.slice(0, Math.max(0, Math.min(Number(want) || 0, 4))).map(([bvid, v]) => ({ bvid, title: String(v.title || '') }));
}

export function createTrips({ life, wallet, pond, storage, log, habits, biliRead, gate, memory = null, gates = null, seenLog = null, inbox = null }) {
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
      life.record(f, 'out', reason === 'self' ? '自己背上小书包出门闲逛了' : '背上小书包出门闲逛了', { energy: TRIP_OUT_ENERGY });
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
          // 二期-1b：逛多久她自己说（游记 JSON 的 stay 换算时长倍数，没说就照常 ×1）
          const plan = tripPlan({ tripId: id, startedAt: cur.startedAt, seen: notes ? notes : seen, energy: energyAtStart, gear, items: hb.itemsPerTrip || 2, scale: STAY_SCALE[result.stay] ?? 1 });
          let pick = { shots: [], missed: [] };
          try { pick = pickPhotos(result, seen); } catch (e) { log?.warn?.(`[dsh-yushe] 照片出错：${e?.message || e}`); }
          const postcards = planPostcards({ tripId: id, startedAt: cur.startedAt, durationMs: plan.durationMs, shots: pick.shots, missed: pick.missed, notes: notes || [], seen, text: String(result.postcard || ''), say: result.postcardSay, home: f.home }); // F-85：背面的哪种 + 她住的那间寄不出去（家里景挑别的）
          life.setTrip(f, { wantComment: result.wantComment || null, wantPost: result.wantPost || null, state: 'planned', seen: seen.slice(0, 12), cards: plan.cards, returnAt: plan.returnAt, postcard: String(result.postcard || '').slice(0, 300), postcards, souvenirs: souvenirsFor({ tripId: id, seen, gear }), tokens: result.tokens || 0, ...(notes ? { notes } : {}), ...(result.read ? { read: result.read.read, scanned: result.read.scanned } : {}), ...(result.dislikes?.length ? { dislikes: result.dislikes } : {}) });
          try { shootPhotos(pick, seen, postcards); } catch (e) { log?.warn?.(`[dsh-yushe] 照片出错：${e?.message || e}`); }
      };
      /**
       * 兜底（妈妈定的「这趟至少留两条」）：工具路逛完，评论不到两条就从**这趟点开看过、还没评过**的视频里补。
       * 正文她自己写（走 writeDraft，过 G2 证据检查），发不发仍由闸门和每天上限管；安静时段不补（不打扰）。
       */
      const COMMENT_TARGET = 2;
      const topUpComments = async (f, id, { catalog, ledger, acts }) => {
        if (!gate || !wallet?.say || !biliRead || !catalog?.size || !ledger) return;
        const hb = habits?.get() || {};
        if (inQuiet(hb, nowDate())) return;
        const view = gate.view();
        const left = Number(view.limits?.comment ?? 0) - (Number(view.today?.comment ?? 0) + (view.queued || []).filter((d) => d.kind === 'comment').length);
        const done = Object.entries(acts || {}).filter(([, a]) => (a || []).includes('bili_comment')).length;
        const want = Math.min(COMMENT_TARGET - done, left);
        if (want <= 0) return;
        const recently = (() => { try { return (memory?.recentlyCommented?.(f, 24) || []).map(String); } catch { return []; } })();
        const cand = commentTargets({ catalog, ledger, acts, recently, want });
        if (!cand.length) return;
        let added = 0;
        for (const { bvid } of cand) {
          if (added >= want) break;
          const cur = life.state(f).trip;
          if (cur?.id !== id) break; // 已经换了趟次，不补了
          try {
            const { v, material } = await videoMaterial(biliRead, bvid, ledger);
            const w = await writeDraft({ wallet, pond, life }, { what: `给视频《${String(v.title || '').slice(0, 40)}》写一条评论`, material, intent: null, max: 80, evidence: { ledger, bvid } });
            if (!w.ok) continue;
            const r = gate.propose(f, { kind: 'comment', text: w.text, target: { bvid: v.bvid, aid: v.aid, title: String(v.title || '').slice(0, 60) } });
            if (r.ok) { added += 1; log?.info?.(`[dsh-yushe] 兜底补评论：《${String(v.title || '').slice(0, 30)}》${r.queued ? '进发言队列' : '等爸妈批准'}`); }
          } catch (e) { log?.warn?.(`[dsh-yushe] 兜底补评论没成：${String(e?.message || e).slice(0, 80)}`); }
        }
        if (added < want) log?.info?.(`[dsh-yushe] 这趟评论还差 ${want - added} 条（没有合适的可以补）`);
      };
      const roamOld = () => {
        const jobId = startRoam(storage, 4 * 60_000, {
        who: { name: f.name, call: f.parentCall }, prefer, k, gatherBili,
        onDone: (job) => {
          try { if (job.usage?.totalTokens) wallet.chargeTokens('roam', job.usage.totalTokens); } catch { /* 记账失败不影响 */ }
          finish(job.state === 'done' && job.result ? { seen: (job.result.seen || []).filter((x) => x.verified), postcard: job.result.postcard, postcardSay: job.result.postcardSay, wantComment: job.result.wantComment, wantPost: job.result.wantPost, tokens: job.usage?.totalTokens || 0 } : null);
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
      // F-86：这趟看过的每一条都进流水账（写失败只记日志，不影响回家）
      const logSeen = (entries, why) => {
        if (!seenLog) return;
        try { seenLog.add(f, entriesFrom({ catalog, ledger: ledger.dump(), acts, ...entries })); }
        catch (e) { log?.warn?.(`[dsh-yushe] 见闻流水账没写上（${why}）：${String(e?.message || e).slice(0, 120)}`); }
      };
      const ACT_TOOLS = new Set(['bili_like', 'bili_collect', 'bili_comment', 'bili_reply']);
      const noteAct = (name, args, r) => { const bv = String(args?.bvid || '').match(/^BV[0-9A-Za-z]{10}$/)?.[0]; if (bv && ACT_TOOLS.has(name) && r && r.ok !== false && !args?.undo) (acts[bv] ||= []).push(name); };
      const tools = loop.tools(ledger).map((t) => ({ ...t, execute: async (args) => { const r = await t.execute(args); collectCatalog(catalog, r); noteAct(t.name, args, r); return r; } }));
      const g = s.growth || {};
      const system = tripSystem({
        persona: (() => { try { return personaFor(f, g) || f.personaText; } catch { return f.personaText; } })(),
        moodText: feelSection(s.feel, { call: f.parentCall, temper: temperOf(s.growth), scene: 'public' }),
        interests: Object.entries(g.interests || {}).sort((x, y) => y[1].heat - x[1].heat).slice(0, 5).map(([t]) => t),
        ups: Object.entries(g.ups || {}).filter(([, u]) => u.mid).sort((x, y) => y[1].n - x[1].n).slice(0, 3).map(([n, u]) => `${n}（mid ${u.mid}）`),
        favZones: hb.favZones || [], avoidWords: hb.avoidWords || [], maxCalls: hb.tripToolCalls || 12, caps: hb,
        dislikes: dislikeList(g), maxNotes: hb.notesPerTrip || 6, // F-82
        recentSays: (s.album || []).filter((x) => x.say).slice(-3).map((x) => x.say), // F-85：最近几张明信片是哪种，让她自己换着写
        // F-76：出门是对外的场合，只带 B站上的记忆（家里的事不带）；最近评论过的视频提醒别重复
        memoryText: (() => { try { return memory?.section?.(f, { scope: 'public', query: Object.keys(g.interests || {}).join(' '), limit: 4, title: '【你在 B站上的记忆】', tail: '模糊的就别说得很肯定；记不清的人当新认识。' }) || ''; } catch { return ''; } })(),
        commented: (() => { try { return memory?.recentlyCommented?.(f) || []; } catch { return []; } })(),
        // F-81：有人回了她 / @ 她，这趟先去回一句（留言优先）
        replies: (() => { try { return inbox?.pendingReplies?.(3) || []; } catch { return []; } })(),
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
          logSeen({ noted: [...rep.seen, ...(notes || [])], at: new Date(nowMs()).toISOString() }, '回家'); // F-86：游记 seen + 便利贴算 noted
          log?.info?.(`[dsh-yushe] 工具出门：调了 ${r.calls.length} 次工具（${[...new Set(r.calls.map((c) => c.name))].join('、')}），看过 ${catalog.size} 条，游记 ${rep.seen.length} 条${rep.dropped.length ? `，丢掉编的 ${rep.dropped.length} 条` : ''}，${r.usage.totalTokens} tokens`);
          endJob(jobId, { result: { tools: r.calls, seen } });
          life.setTrip(f, { toolCalls: r.calls.map((c) => c.name).slice(0, 40) });
          finish({ seen, postcard: rep.postcard, postcardSay: rep.postcardSay, stay: rep.stay, tokens: r.usage.totalTokens, photo: rep.seen.length ? rep.photo : null, ledger: dump, acts, notes, read, dislikes });
          // F-93（妈妈定的「每趟至少留两条」）：够了两条就什么也不做，不够就补
          topUpComments(f, id, { catalog, ledger, acts }).catch((e) => log?.warn?.(`[dsh-yushe] 兜底补评论出错：${String(e?.message || e).slice(0, 80)}`));
        })
        .catch((e) => {
          log?.warn?.(`[dsh-yushe] 工具出门出错：${String(e?.message || e).slice(0, 120)}${calls ? '' : '，退回老路'}`);
          endJob(jobId, { state: 'error', error: String(e?.message || e).slice(0, 200) });
          if (!calls) { const old = roamOld(); life.setOut(f, old); } else { logSeen({ noted: [], at: new Date(nowMs()).toISOString() }, '出错回家'); finish({ seen: [...catalog.values()].slice(0, 4).map((c) => ({ ...c, verified: true, why: '' })), postcard: '', notes: null, read: readList({ catalog, ledger: ledger.dump(), acts }) }); }
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
      if (life.isBrowsing?.(f)) return false; // 在家正刷着 B站（F-87）：这一轮先不出门，等她刷完
      const s = life.state(f), snap = snapshot(s), day = dayOf();
      const tripsToday = (s.events || []).filter((e) => e.day === day && e.kind === 'out').length;
      const go = wantsToLeave({ fishId: f.id, now: nowMs(), asleep: asleepAt() || snap.where === 'sleep', out: life.isOut(f), broke: wallet.view().broke, energy: snap.energy, mood: snap.mood, outBias: behaviorOf(s.feel).outBias, outgoing: outgoingness(s.growth?.pts || f.pts, s.growth?.lean).score, tripsToday, maxPerDay: hb?.tripsPerDay ? hb.tripsPerDay : Infinity, lastBackAt: s.lastBackAt || 0, bias: hb?.outBias ?? 1, restBias: hb?.restBias ?? 1 });
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
