/**
 * 闸门 + 信箱审批 + 足迹（M5b）。
 *
 *   gate.propose(fish, {kind, text, target})   她写了一条草稿（出门回来时）；先过规矩——
 *       默认「自己发」（F-51）：进发言队列，按发言间隔 + 每天上限自动发；「要我批准」：进信箱等爸妈批准
 *   gate.flush(fish)                           发言队列里到点的发一条（宿主 10 分钟定时器 + 写草稿时各调一次）
 *   GET  /api/dsh-yushe/drafts                 等批准的 + 最近处理过的 + 今天发了几条 + 成长解锁进度
 *   POST /api/dsh-yushe/drafts                 {id, action:'approve'|'reject', text?}：批准时可以改字；批准 = 再过一遍规矩和上限 → 真的发
 *   GET  /api/dsh-yushe/footprints             她在 B站留下的痕迹（每条带链接）
 *
 * 私信（任务 46）：只回别人先发来的。爸妈专线（target.parent）马上发、不占上限、不进足迹；陌生人的私信不等发言间隔
 * （那是给公开发言的），但占「每天最多回几条」，「要我批准」模式下照样进信箱等批准。
 *
 * 存储 <storage>/drafts.json、<storage>/footprints.json。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonBody } from './game-routes.js';
import { nowDate, nowMs } from './clock.js';
import { checkDraft, capCheck, trustOf, KINDS } from '../shared/gate.js';
import { createGates } from './gates.js';

export const DRAFTS_PATH = '/api/dsh-yushe/drafts';
export const FOOTPRINTS_PATH = '/api/dsh-yushe/footprints';
const MAX_PENDING = 5;
const QUEUE_TTL = 24 * 3600_000; // 排队超过一天的草稿就不发了（话题已经过时）

/**
 * 任务 50：说话工具表（tools/speak/*.js）声明的类型（kinds）、发法（senders）、每天上限字段（capKeys）并进来，
 * 加新的说话类型不用改这里；对同一个人每天上限（G4）用互动账本（usePerson(acts)）。
 */
export function createGate({ storage, life, habits, biliRead, biliWrite, log, gates = null, kinds: extraKinds = {}, senders = {}, capKeys = {} }) {
  const K = { ...KINDS, ...extraKinds };
  let person = null;
  const G = gates || createGates({ habits }); // 没传就自己建一个（verify 用）
  const fileOf = (n) => join(storage, n);
  const load = (n, d) => { try { return JSON.parse(readFileSync(fileOf(n), 'utf8')); } catch { return d; } };
  const save = (n, v) => { mkdirSync(storage, { recursive: true }); const tmp = `${fileOf(n)}.tmp`; writeFileSync(tmp, JSON.stringify(v, null, 2)); renameSync(tmp, fileOf(n)); };
  const day = () => nowDate().toISOString().slice(0, 10);
  const all = () => load('drafts.json', []);
  const sentToday = (kind) => all().filter((d) => d.kind === kind && !d.target?.parent && d.status === 'sent' && (d.sentAt || '').slice(0, 10) === day()).length;
  const limitOf = (kind, parent = false) => { const h = habits.get(); if (kind === 'dm' && parent) return Infinity; if (capKeys[kind]) return Number(h[capKeys[kind]] ?? 0); return kind === 'comment' ? h.commentsPerDay : kind === 'post' ? h.postsPerDay : kind === 'dm' ? h.dmsPerDay : 0; };
  const lastSpokeAt = () => Math.max(0, ...all().filter((d) => d.kind !== 'dm' && ['sent', 'uncertain'].includes(d.status)).map((d) => Date.parse(d.sentAt) || 0));
  const everyMs = () => Number(habits.get().speakEvery || 60) * 60_000;

  /** 真的发一条（批准或自动都走这里）：再过一遍规矩和上限 → 发 → 足迹。改的是 list 里的 d，调用方负责传最新 list。 */
  async function sendDraft(list, d, text, fish) {
    const parent = Boolean(d.target?.parent);
    const chk = checkDraft(d.kind, text, { parent, kinds: K });
    if (!chk.ok) return { ok: false, error: `还不能发：${chk.problems.join('、')}` };
    const cap = capCheck(d.kind, { sentToday: sentToday(d.kind), limit: limitOf(d.kind, parent), kinds: K });
    if (!cap.ok) return { ok: false, error: cap.why, capped: true };
    d.edited = text !== d.text; d.text = text; d.status = 'sending'; save('drafts.json', list);
    let r;
    if (d.kind === 'comment') {
      let aid = d.target?.aid;
      if (!aid && d.target?.bvid) { try { aid = (await biliRead.videoInfo(d.target.bvid)).aid; } catch (e) { r = { status: 'rejected', reason: `找不到这个视频：${e.message}` }; } }
      if (!r) r = await biliWrite.comment({ aid, bvid: d.target?.bvid, text });
    } else if (d.kind === 'dm') r = await biliWrite.dm({ mid: d.target?.mid, text });
    else if (senders[d.kind]) { try { r = await senders[d.kind]({ ...d, text }, { biliRead, biliWrite }); } catch (e) { r = { status: 'uncertain', reason: `发的时候出错（${String(e?.message || e).slice(0, 60)}），不重试` }; } }
    else r = await biliWrite.post({ text, pics: d.image ? [d.image] : null });
    d.status = r.status === 'sent' ? 'sent' : r.status === 'uncertain' ? 'uncertain' : 'failed';
    if ((d.status === 'sent' || d.status === 'uncertain') && d.target?.mid && !parent) person?.notePerson(d.target.mid); // G4：对这个人又互动了一次
    d.result = { reason: r.reason || null, url: r.url || null }; d.sentAt = nowDate().toISOString();
    save('drafts.json', list);
    if ((d.status === 'sent' || d.status === 'uncertain') && !parent) save('footprints.json', [...load('footprints.json', []), { id: d.id, kind: d.kind, text, at: d.sentAt, url: r.url || null, target: d.target || null, uncertain: d.status === 'uncertain' }].slice(-500));
    if (fish && d.status === 'sent') {
      // 回爸妈的私信记成 dm-sent-parent（对爸妈的被爱），回网友的还是 dm-sent（心情-一期-2 I，docs/设计/16-心情.md）
      if (d.kind === 'dm') life.record(fish, parent ? 'dm-sent-parent' : 'dm-sent', parent ? `回了${fish.parentCall}的 B站私信：「${text.slice(0, 30)}」` : `在 B站回了 ${d.target?.who || '网友'} 的私信`, { mood: parent ? 4 : 2 });
      else life.record(fish, 'posted', `在 B站发了一条${K[d.kind]?.name || '话'}：「${text.slice(0, 30)}」`, { mood: 5 });
    }
    return { ok: d.status === 'sent', status: d.status, url: r.url || null, error: d.status === 'sent' ? null : r.reason };
  }
  let flushing = false;

  const gate = {
    /** 对同一个人每天上限（G4）用互动账本：宿主建好 acts 后接上（acts 也要用闸门记足迹，所以后接）。 */
    usePerson(p) { person = p; },
    kinds: () => K,
    /** 她申请发一条：过规矩 → 进信箱。返回 { ok, id? , problems? }。 */
    propose(fish, { kind, text, target = null, image = null }) {
      if (!K[kind]) return { ok: false, problems: ['不认识的类型'] };
      if (!biliWrite.ready()) return { ok: false, problems: ['她还没登录 B站'] };
      const parent = kind === 'dm' && Boolean(target?.parent);
      if (!limitOf(kind, parent)) return { ok: false, problems: ['上网习惯里这一项是 0'] };
      const chk = checkDraft(kind, text, { parent, kinds: K });
      if (chk.ok && target?.mid && !parent && person) { const pa = person.personAllows(target.mid); if (!pa.ok) return { ok: false, problems: [pa.why] }; } // G4
      const list = all();
      if (!chk.ok) { log?.info?.(`[dsh-yushe] 草稿被闸门拦下（${chk.problems.join('、')}）`); return { ok: false, problems: chk.problems }; }
      const auto = parent || habits.get().speakMode !== 'approve';
      if (!(auto && kind === 'dm') && list.filter((d) => d.status === (auto ? 'queued' : 'pending') && d.kind !== 'dm').length >= MAX_PENDING) return { ok: false, problems: [auto ? '想说的话排太多了' : '信箱里等批准的太多了'] }; // 私信不排队（马上发），不占公开发言的队
      if (kind === 'dm' && !parent) { // 还在路上的也算进今天的上限，免得一下子回超了
        const inFlight = list.filter((d) => d.kind === 'dm' && !d.target?.parent && ['pending', 'queued', 'sending'].includes(d.status) && (d.createdAt || '').slice(0, 10) === day()).length;
        const cap = capCheck('dm', { sentToday: sentToday('dm') + inFlight, limit: limitOf('dm'), kinds: K });
        if (!cap.ok) return { ok: false, problems: [cap.why] };
      }
      if (target?.key && list.some((d) => d.kind === kind && d.target?.key === target.key && ['pending', 'queued', 'sending', 'sent'].includes(d.status))) return { ok: false, problems: ['这条已经回过 / 在排队'] };
      if (kind === 'comment' && list.some((d) => d.kind === 'comment' && d.target?.bvid === target?.bvid && ['pending', 'queued', 'sending', 'sent'].includes(d.status))) return { ok: false, problems: ['这个视频已经评论过 / 在排队'] };
      const d = { id: `D${Date.now().toString(36)}${randomUUID().slice(0, 4)}`, kind, text: String(text).trim(), target, image: image || null, fishId: fish?.id || null, status: auto ? 'queued' : 'pending', createdAt: nowDate().toISOString() };
      save('drafts.json', [...list, d].slice(-200));
      if (fish && !auto) life.record(fish, 'draft', `想发一条${K[kind].name}，寄到信箱等${fish.parentCall}批准`, {});
      if (auto && kind === 'dm') { const l2 = all(); const d2 = l2.find((x) => x.id === d.id); sendDraft(l2, d2, d2.text, fish).catch(() => {}); return { ok: true, id: d.id, sending: true }; } // 私信不等发言间隔
      if (auto) gate.flush(fish).catch(() => {}); // 到点了就马上发，不然排队等发言间隔
      return { ok: true, id: d.id, queued: auto };
    },
    /** 自己发模式：发言队列里最早那条，到了发言间隔、没到上限、她醒着，就发。返回发了什么（或为什么没发）。 */
    async flush(fish) {
      if (flushing || habits.get().speakMode === 'approve') return { sent: false, why: flushing ? '正在发' : '要批准模式' };
      flushing = true;
      try {
        const list = all();
        for (const d of list) if (d.status === 'queued' && nowMs() - Date.parse(d.createdAt) > QUEUE_TTL) { d.status = 'expired'; }
        save('drafts.json', list);
        const speak = G.open('speak');
        if (!speak.ok) return { sent: false, why: speak.why }; // 出口闸（F-79）
        const wait = lastSpokeAt() + everyMs() - nowMs();
        if (wait > 0) return { sent: false, why: `还要等 ${Math.ceil(wait / 60_000)} 分钟` };
        for (const d of list.filter((x) => x.status === 'queued' && x.kind !== 'dm')) {
          if (!capCheck(d.kind, { sentToday: sentToday(d.kind), limit: limitOf(d.kind), kinds: K }).ok) continue; // 这一类今天满了，看看另一类
          const r = await sendDraft(list, d, d.text, fish);
          return { sent: r.ok, status: r.status || null, error: r.error || null };
        }
        return { sent: false, why: '没有要发的 / 今天都到上限了' };
      } finally { flushing = false; }
    },
    view() {
      const list = all();
      const h = habits.get();
      return { mode: h.speakMode, every: Number(h.speakEvery), nextAt: lastSpokeAt() ? new Date(lastSpokeAt() + everyMs()).toISOString() : null, queued: list.filter((d) => d.status === 'queued').reverse(), pending: list.filter((d) => d.status === 'pending').reverse(), recent: list.filter((d) => d.status !== 'pending').slice(-20).reverse(), today: { comment: sentToday('comment'), post: sentToday('post'), dm: sentToday('dm') }, limits: { comment: limitOf('comment'), post: limitOf('post'), dm: limitOf('dm') }, trust: trustOf(list) };
    },
    /** 爸妈的决定。批准 = 再过一遍规矩（改过的字也要过）和今天的上限 → 发。 */
    async decide(id, action, newText, fish) {
      const list = all();
      const d = list.find((x) => x.id === id);
      if (!d || !(d.status === 'pending' || (d.status === 'queued' && action === 'reject'))) return { ok: false, error: '这条已经处理过了' };
      if (action === 'reject') {
        d.status = 'rejected'; d.decidedAt = nowDate().toISOString(); save('drafts.json', list);
        if (fish) life.record(fish, 'draft-no', `${fish.parentCall}说那条${K[d.kind]?.name || '话'}先别发，本鱼记住了`, { mood: -2 });
        return { ok: true, status: 'rejected' };
      }
      if (action !== 'approve') return { ok: false, error: '只能批准或不行' };
      const text = newText !== undefined && String(newText).trim() ? String(newText).trim() : d.text;
      return sendDraft(list, d, text, fish);
    },
    footprints: () => load('footprints.json', []).slice().reverse(),
    /** 互动类（点赞 / 收藏 / 关注…，任务 49）成功后也进足迹，每条点得开。 */
    addFootprint({ kind, text, url = null, target = null, uncertain = false }) {
      save('footprints.json', [...load('footprints.json', []), { id: `F${Date.now().toString(36)}${randomUUID().slice(0, 4)}`, kind, text: String(text || '').slice(0, 120), at: nowDate().toISOString(), url, target, uncertain: Boolean(uncertain) }].slice(-200));
    },
  };
  return gate;
}

export function registerGateRoutes({ scope, pond, gate, isLoopbackRequest, writeJson }) {
  const homeFish = () => pond.current() || pond.list().fish.at(-1) || null;
  const reg = (path, handler, label) => scope.effect(() => scope.webServer.register({ kind: 'exact', path, handler: async (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
    await handler(req, res);
  } }), `dsh-yushe: ${label}`);
  reg(DRAFTS_PATH, async (req, res) => {
    if (req.method === 'GET') return writeJson(res, 200, { ok: true, ...gate.view() });
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    const b = await readJsonBody(req);
    if (!b?.id) return writeJson(res, 400, { ok: false, error: '请求格式不对' });
    writeJson(res, 200, await gate.decide(String(b.id), b.action, b.text, homeFish()));
  }, 'drafts route');
  reg(FOOTPRINTS_PATH, async (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    writeJson(res, 200, { ok: true, items: gate.footprints() });
  }, 'footprints route');
}
