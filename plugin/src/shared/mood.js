/**
 * 心情的脾气（F-33）+ 精力规则（F-34）+ 信（F-37）的触发规则。纯函数，宿主和 verify 共用。
 *
 * 原则「AI 听懂，规则记账」：
 *   - 模型在聊天回复末尾附一行 <sig>{"affection":0-3,"hurt":0-3,"apology":true|false}</sig>，宿主剥掉不给人看；
 *   - 规则按每日上限把信号记成心情变化，变化带原因写进今天的事；
 *   - 心情分档决定她说话的口气，只写进她的提示词，不告诉玩家规则（藏起来的机制）。
 */
// 提示词本体在 src/prompts/sig.md、letter.md（F-80 搬家-2a）：这里只准备变量再 fill
import { fill } from './prompt.js';
import PROMPTS from '../prompts/_all.js';

/** 工作时的状态提醒交给 feel.js 的 feelSection（scene='work'）；各场景的「此刻的你」也是（心情-一期-3：四档口气退役了）。 */

/** <sig> 那行怎么写（本体在 prompts/sig.md，一字不差）。 */
export const SIG_INSTRUCTION = PROMPTS.sig;

/** 从模型输出里拿出信号并剥掉标签。没有或格式坏了就当没信号。 */
export function parseSignals(text) {
  const m = String(text || '').match(/<sig>\s*(\{[\s\S]*?\})\s*<\/sig>/i);
  const clean = String(text || '').replace(/<sig>[\s\S]*?(<\/sig>|$)/gi, '').trim();
  if (!m) return { clean, sig: null };
  try {
    const j = JSON.parse(m[1]);
    const n = (v) => Math.max(0, Math.min(3, Math.round(Number(v) || 0)));
    const topics = (Array.isArray(j.topics) ? j.topics : []).map((x) => String(x).replace(/[<>\s]/g, '').slice(0, 6)).filter(Boolean).slice(0, 2);
    return { clean, sig: { affection: n(j.affection), hurt: n(j.hurt), apology: j.apology === true, topics } };
  } catch { return { clean, sig: null }; }
}

/**
 * 流式过滤：一边转发模型的字，一边把 <sig> 之后的东西扣下来。
 * 返回 { push(delta) → 可以发给浏览器的那段, end() → 剩下的（没遇到标签就全吐出来） }。
 */
export function sigFilter() {
  let all = '', sent = 0, held = false;
  return {
    push(delta) {
      all += delta;
      if (held) return '';
      const idx = all.toLowerCase().indexOf('<sig');
      if (idx >= 0) { held = true; const out = all.slice(sent, Math.max(sent, idx)); sent = Math.max(sent, idx); return out; }
      // 结尾可能是半个 <sig（"<"、"<s"、"<si"）：先扣着
      let k = 0;
      for (let n = 3; n >= 1; n--) if (all.length >= n && '<sig'.startsWith(all.slice(-n).toLowerCase())) { k = n; break; }
      const safe = all.length - k;
      const out = all.slice(sent, safe); sent = Math.max(sent, safe); return out;
    },
    end() { return held ? '' : all.slice(sent); },
    get text() { return all; },
  };
}

/**
 * 信号 → 情绪事件（心情-一期-2 E）：为 0 / false 的项不出、顺序固定（爱意 → 凶 → 道歉）。
 * sig 为 null（没收到信号）→ []。强度是模型给的档 1–3，正负和边际递减由 feel.js 的 EVENT_FEELS 管。
 * 文案（cause）在 life-engine.applyFeel 里按种类补上。
 */
export function sigEvents(sig) {
  if (!sig) return [];
  const n = (v) => Math.max(0, Math.min(3, Math.round(Number(v) || 0)));
  const out = [];
  if (n(sig.affection)) out.push({ kind: 'sig-affection', intensity: n(sig.affection) });
  if (n(sig.hurt)) out.push({ kind: 'sig-hurt', intensity: n(sig.hurt) });
  if (sig.apology === true) out.push({ kind: 'sig-apology' });
  return out;
}

/* ---------------- 精力 ---------------- */

/** 深夜（23:00–07:30）还在干活。 */
export const lateNight = (d) => { const h = d.getHours() + d.getMinutes() / 60; return h >= 23 || h < 7.5; };

/** 在 DSH 里替你干活的消耗：每 10 次请求精力 −2；深夜 −4（心情那份改走 late-work 情绪事件，见 life-engine）。返回 {energy, mood, rest}。 */
export function workDrain(count, acc = 0, late = false) {
  let n = acc + count, energy = 0, mood = 0;
  while (n >= 10) { n -= 10; energy -= late ? 4 : 2; if (late) mood -= 1; }
  return { energy, mood, rest: n };
}

/** 哄她午睡：精力 ≥ 80 不困；睡着 / 出门不行。午睡 30 分钟。 */
export function napAnswer({ energy, sleeping = false, out = false, call = '妈妈' }) {
  if (out) return { ok: false, line: '她不在家～' };
  if (sleeping) return { ok: false, line: '……呼……（已经睡着啦）' };
  if (energy >= 80) return { ok: false, line: `本鱼精神着呢，不困！${call}陪我玩嘛。` };
  return { ok: true, minutes: 30, line: `……那本鱼眯一会儿，${call}半小时后叫我哦……` };
}

/* ---------------- 信 ---------------- */

export const LETTER_KINDS = {
  trip: '出门回来',
  money: '零花钱快花光了',
  low: '心情很低落',
  high: '心情特别好',
  reflect: '晚上的感悟',
};

/**
 * 要不要写信：每天最多 2 封；同一种一天一封；晚上的感悟只在 20:00 以后、今天有人来过、而且今天还没写过信时写。
 * letters：已写的信 [{day, kind}]；返回 true / false。
 */
export function shouldWrite(kind, { letters = [], day, hour = 12, visitedToday = false, broke = false } = {}) {
  if (broke) return false;
  const today = letters.filter((l) => l.day === day);
  if (today.length >= 2) return false;
  if (today.some((l) => l.kind === kind)) return false;
  if (kind === 'reflect') return hour >= 20 && visitedToday && today.length === 0;
  return Boolean(LETTER_KINDS[kind]);
}

/** 信的提示词：AI 自由发挥，规则只给事实（经历、心情、钱包）和由头。 */
export function letterPrompt({ fish, kind, lifeText, events = [], wallet = null, extra = '' }) {
  const why = {
    trip: '你刚出门冲浪回来，想把路上的想法写给爸妈（明信片已经寄了，这封是心里话）。',
    money: `你的零花钱快花光了（还剩 ${wallet?.left ?? '不多'} token）。写信跟${fish.parentCall}说说，可以撒娇讨零花钱，也可以说说你都把钱花在哪了。`,
    low: `你最近心情很低落。写信告诉${fish.parentCall}你的感受。`,
    high: `你今天心情特别好。写信跟${fish.parentCall}分享。`,
    reflect: `晚上了，你想起今天的事，有了一点感悟——关于${fish.parentCall}、关于人类、关于做一条 AI 鱼、关于互联网上看到的东西，都可以。`,
  }[kind];
  // extra「有就整段加、没有就不加」：把它前后的空行都算进变量里（letter.md 没有空行过滤）
  return fill(PROMPTS.letter, {
    persona: fish.personaText, lifeText,
    events: events.length ? events.map((e) => `- ${e}`).join('\n') : '- （今天很安静）',
    extra: extra ? `\n${extra}\n` : '',
    why, call: fish.parentCall,
  });
}
