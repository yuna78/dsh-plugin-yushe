// 说话工具共用（不是工具，gen-tools 不扫这个文件）：主会话走「意图 → 她自己写」，出门直接给 text；都过 G2 证据检查和闸门。
import { createLedger, evidenceCheck } from '../../shared/evidence.js';
import { cleanIntent, writeDraft } from './writer.js';
import { NO_FISH } from './define.js';
import { NOT_LOGGED_IN } from './bili-common.js';

/** 说话前的检查。 */
export function speakReady({ biliRead, biliWrite, gate, pond }) {
  if (!gate || !biliWrite) return { ok: false, error: 'B站说话没开' };
  if (!biliWrite.ready() || !biliRead?.loggedIn()) return NOT_LOGGED_IN;
  if (biliRead.blocked?.()) return { ok: false, error: 'B站正在风控，先不说话' };
  if (!pond?.current?.()) return NO_FISH;
  return null;
}

/**
 * 说一条：from='main' 用 intent 让她自己写；from='trip' 用 text。
 * material：给她写的公开资料；ledger：读账（主会话里由工具自己读资料时记，出门用 deps.ledger）；bvid：这条话针对的视频。
 */
export async function speak(deps, from, { kind, what, max, target, args, material = [], ledger = null, bvid = null, rules = [], image = null }) {
  const led = ledger || deps.ledger || createLedger();
  let text;
  if (from === 'trip') {
    text = String(args.text ?? '').trim();
    if (!text) return { ok: false, error: '要给 text（你想发的那句话）' };
    const ev = evidenceCheck(text, led, { bvid });
    if (!ev.ok) return { ok: false, error: `${ev.why}。改一下再发` };
  } else {
    const ci = cleanIntent(args.intent);
    if (!ci.ok) return { ok: false, error: ci.why };
    // F-76：认不认识对方（只有 B站上的记忆，不带家里的事）
    let knows = ''; try { if (target?.mid || target?.who) knows = deps.memory?.aboutPerson?.(deps.pond.current(), { mid: target.mid, who: target.who }) || ''; } catch { knows = ''; }
    const w = await writeDraft(deps, { what, material, intent: ci.text, max, rules: knows ? [...rules, knows] : rules, evidence: { ledger: led, bvid } });
    if (!w.ok) return { ok: false, skipped: w.skipped || undefined, error: w.why };
    text = w.text;
  }
  const r = deps.gate.propose(deps.pond.current(), { kind, text, target, image });
  if (!r.ok) return { ok: false, error: `闸门没让过：${(r.problems || []).join('、')}`, text };
  return { ok: true, status: r.sending ? 'sending' : r.queued ? 'queued' : 'pending', text, hint: r.queued ? '过了规矩，排队按发言间隔自己发（发出去会进足迹）' : r.sending ? '在发了' : '寄到信箱等爸妈批准' };
}
