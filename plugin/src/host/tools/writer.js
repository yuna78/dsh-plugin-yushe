/**
 * 说话工具共用的「她自己写」（任务 50，08 工具明细第 3、4 节，07 决定 2）。不是工具，gen-tools 不扫这个文件。
 *
 * DSH 主会话的模型看得到爸妈的工作内容，所以主会话里的说话工具**只交目标和一句意图**：
 *   1. cleanIntent：意图 ≤ 40 字；去掉链接、长数字、@、联系方式；碰到家里 / 工作 / 密码这类私密词直接拒绝
 *   2. writeDraft：另起一次模型调用，上下文只有她的人设、心情、目标的公开资料（material）和清洗后的意图——不放主会话的任何东西
 *   3. 写出来的正文过 G2 证据检查（evidenceCheck）：说了没证据的话就打回重写一次，再不过就不发
 * 出门循环里她自己直接写 text，不走这里的第 2 步，但照样过证据检查和闸门。
 */
import { checkDraft } from '../../shared/gate.js';
import { evidenceCheck } from '../../shared/evidence.js';
import { personaFor } from '../../shared/growth.js';
// 对外发声只带对 B站 / 外面的情绪（心情-一期-3 B）：「此刻的你」由 feelSection 场景给，家里的不进去
import { temperOf, feelSection } from '../../shared/feel.js';
// 空行小工具在 shared/prompt.js（搬家-2b 收拢）
import { fill, DROP, dropLines } from '../../shared/prompt.js';
import PROMPTS from '../../prompts/_all.js';

export const SKIP = '（不发）';
const stripEmoji = (s) => String(s ?? '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu, '');

/** 主会话给的意图 → 能交给她的一句话，或者拒绝。 */
export function cleanIntent(intent) {
  const raw = String(intent ?? '').replace(/[\u0000-\u001f<>`]/g, ' ').trim();
  if (!raw) return { ok: false, why: '要给一句意图（想说点什么方向的话），不用写正文' };
  // 私密词：用私信那一档最严的词表（家里 / 工作 / 提示词 / 密码 …）
  const priv = checkDraft('dm', raw.slice(0, 120), { parent: false }).problems.filter((p) => /家里|工作|密码|提示词|账号/.test(p));
  if (priv.length) return { ok: false, why: `意图里像有家里或工作上的事，对外不能带：${priv.join('、')}` };
  const t = stripEmoji(raw).replace(/https?:\/\/\S+|www\.\S+|b23\.tv\/\S+/gi, '').replace(/@\S+/g, '').replace(/\d{5,}/g, '').replace(/微信|vx|qq|手机号|电话|邮箱/gi, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (t.length < 2) return { ok: false, why: '意图清洗以后没剩什么了' };
  return { ok: true, text: t };
}

/** 模型的输出 → 正文或 null（不发）。 */
export function parseDraft(raw, max) {
  const t = stripEmoji(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/^["“”'「」『』]+|["“”'「」『』]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.includes(SKIP) || /^[（(]?不发[）)]?$/.test(t)) return null;
  return t.slice(0, max);
}

/**
 * 写正文的提示词（只有人设、心情、公开资料、意图）。
 * 心情-一期-3 B：oldMood 参数换成 feel（+temper）；「此刻的你」按对外场景给——
 * 只有 s.feel 为空 / 没有外面的情绪时整段 DROP。没传 feel（老调用 / 老检查只传 mood）就当没有情绪，不抛。
 */
export function draftPrompt({ fish, growth, feel = null, temper = null, what, material = [], intent, max, rules = [] }) {
  const persona = (() => { try { return personaFor(fish, growth) || fish.personaText || ''; } catch { return fish.personaText || ''; } })();
  const feelText = feelSection(feel, { call: fish.parentCall || '妈妈', temper: temper || undefined, scene: 'public' });
  return dropLines(fill(PROMPTS.draft, {
    persona: persona || DROP,
    mood: feelText || DROP,
    what,
    material: material.filter(Boolean).map((m) => `- ${m}`).join('\n') || DROP,
    intent: intent ? `爸妈希望你说的方向：${intent}` : DROP,
    rules: rules.filter(Boolean).join('\n') || DROP,
    max,
    skip: SKIP,
  }));
}

/**
 * 她自己写一条（主会话用）：返回 { ok, text } 或 { ok: false, why }。
 * deps 要有 wallet（花零花钱）、pond、life；evidence = { ledger, bvid }。
 */
export async function writeDraft(deps, { what, material, intent, max, rules = [], evidence = null }) {
  const { wallet, pond, life } = deps;
  const fish = pond?.current?.(); if (!fish) return { ok: false, why: '现在没有鱼在上工' };
  if (!wallet?.say) return { ok: false, why: '写不了（没有模型）' };
  if (wallet.view?.().broke) return { ok: false, why: '零花钱花光了，她先不说话' };
  const s = life?.state?.(fish) || {};
  let note = '';
  for (let round = 0; round < 2; round++) {
    const prompt = draftPrompt({ fish, growth: s.growth, feel: s.feel, temper: temperOf(s.growth), what, material, intent, max, rules: note ? [...rules, note] : rules });
    let raw = '';
    try { raw = (await wallet.say('speak', prompt, undefined, 45_000)).text; } catch (e) { return { ok: false, why: `没写出来：${String(e?.message || e).slice(0, 60)}` }; }
    const text = parseDraft(raw, max);
    if (!text) return { ok: false, skipped: true, why: '她想了想，决定不发' };
    const ev = evidence ? evidenceCheck(text, evidence.ledger, { bvid: evidence.bvid }) : { ok: true };
    if (ev.ok) return { ok: true, text };
    note = `上一稿不行：${ev.why}。重写。`; // G2：打回重写一次
  }
  return { ok: false, why: '写了两遍都说了没证据的话（比如没看字幕却说「视频里说」），这条不发' };
}
