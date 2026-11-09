/**
 * 房间里的规则（纯函数，宿主 / 游戏 / verify 共用）：
 *   activityOf  她现在在做什么（三态 + 正在干的事）
 *   poseFor     这个活动用哪张立绘（缺了就一路回落到站姿，动作库可以分批补）
 *   goOutAnswer 问她想不想出门：规则决定，她可以拒绝（放养）
 *   refusedRecently 30 分钟内是不是刚因同一个由头拒过（同一由头只拒一次，再问就松口）
 */
import { hashOf } from './core.js';

/** 活动优先级：出门 > 睡觉 > 正在干的事（念新闻 / 写日记 / 想事）> 在 DSH 干活 > 在家。 */
export function activityOf({ out = false, sleeping = false, dreaming = false, busy = null, workedAgoMs = Infinity } = {}) {
  if (out) return 'out';
  if (dreaming) return 'dream'; // F-79：睡觉但正在读，房间要说「在梦游」
  if (sleeping) return 'sleep';
  if (busy === 'news') return 'reading';
  if (busy === 'diary') return 'writing';
  if (busy === 'chat' || busy === 'greet') return 'thinking';
  if (workedAgoMs < 3 * 60_000) return 'working';
  return 'home';
}

export const ACTIVITY_TEXT = { out: '出门冲浪了', dream: '在梦游', sleep: '在睡觉', reading: '在看新闻', writing: '在写日记', thinking: '在想事', working: '在 DSH 帮忙干活', home: '在家' };

/** 动作库（F-67）：每位角色 16 个姿势。stand / sleep 是老的，其余 14 个按 美术/出图/poses.tsv 出图。 */
export const ALL_POSES = ['stand', 'sleep', 'wave', 'cheer', 'read', 'write', 'think', 'work', 'eat', 'phone', 'sulk', 'yawn', 'shy', 'sad', 'wow', 'love'];
/** 闲着在家时随机换的姿势（不放难过 / 闹别扭 / 打哈欠——那几个看心情和精力）。 */
export const IDLE_POSES = ['stand', 'wave', 'cheer', 'phone', 'wow', 'love', 'think'];

/** 每种活动想用的姿势，按顺序找；都没有就回落 stand。out 不画人；home 交给心情 / 闲着随机。 */
export const POSE_WANT = {
  out: [null],
  dream: ['sleep'], // 梦游用睡觉的姿势（闭眼），但文案说「在梦游」
  sleep: ['sleep'],
  reading: ['read', 'stand'],
  writing: ['write', 'stand'],
  thinking: ['think', 'stand'],
  working: ['work', 'stand'],
  home: ['stand'],
};

/** 心情 / 精力很低时在家的样子（没有就 null，交给闲着随机）。 */
export function moodPose({ mood = 60, energy = 70 } = {}) {
  if (energy < 25) return 'yawn';
  if (mood < 20) return 'sulk';
  if (mood < 35) return 'sad';
  return null;
}

/** 闲着随机换一个（不和上一个一样）。rnd ∈ [0,1)。 */
export function pickIdlePose(have, last = null, rnd = Math.random()) {
  const pool = IDLE_POSES.filter((p) => have.has(p) && p !== last);
  if (!pool.length) return have.has('stand') ? 'stand' : null;
  return pool[Math.floor(rnd * pool.length) % pool.length];
}

/** have：这位角色已有的姿势集合。返回姿势名（null = 不画人）。在家时：心情 / 精力优先，其次 idle（调用方随机好的），最后站姿。 */
export function poseFor(activity, have = new Set(['stand']), { mood, energy, idle = null } = {}) {
  if (activity === 'home') {
    const m = moodPose({ mood, energy });
    if (m && have.has(m)) return m;
    if (idle && have.has(idle)) return idle;
  }
  const want = POSE_WANT[activity] || ['stand'];
  for (const p of want) { if (p === null) return null; if (have.has(p)) return p; }
  return 'stand';
}

/**
 * 问她想不想出门。同一条鱼 10 分钟内问几次答案一样（「刚不是说了不去嘛」），防止狂点刷到同意。
 * 返回 { go, reason, line }，reason: asleep / broke / tired / sulky / lazy / yes；
 * 心情二期-1c：传 `behavior`（`behaviorOf` 的结果，feel.js）时她心里有事会拒绝并且说得出由头；`refusedRecently`（布尔）为真 = 30 分钟内刚因这个由头拒过，再问就松口；没传 `behavior` 完全走老路径。
 */
export function goOutAnswer({ fishId = '', call = '妈妈', energy = 70, mood = 60, asleep = false, broke = false, now = Date.now(), behavior = null, refusedRecently = false } = {}) {
  if (asleep) return { go: false, reason: 'asleep', line: '……呼……（睡得正香，没听见）' };
  if (broke) return { go: false, reason: 'broke', line: `零花钱花光啦，出门要花钱的……${call}给本鱼放点零花钱嘛。` };
  if (energy < 30) return { go: false, reason: 'tired', line: `今天好累，不想出门了……${call}让本鱼歇会儿嘛。` };
  if (behavior) {
    const seg = Math.floor(now / 600_000); // 10 分钟段：同一口气的骰子在这段里不变
    // 心里有事（feel.js 的 REFUSE_AT 到线了）：说得由头地拒绝；刚因同一个由头拒过就松口（新手连着被拒两次就不点了）
    if (behavior.refuse) {
      if (!refusedRecently) {
        const lines = (REFUSE_LINES[behavior.refuse.reason] || []).map((l) => l.replace('{call}', call));
        return { go: false, reason: behavior.refuse.reason, why: behavior.refuse.cause || '', line: lines[hashOf(fishId, 'refline', seg) % Math.max(lines.length, 1)] || `……${call}，本鱼先不去了。` };
      }
      const lines = SOFTEN_LINES.map((l) => l.replace('{call}', call));
      return { go: true, reason: 'softened', line: lines[hashOf(fishId, 'softline', seg) % lines.length] };
    }
    // 没心事：愿不愿意交给出门倾向 outBias，心情分不再参与（默认 0.84 = 老心情 60 分的系数）
    const p = Math.max(0.2, Math.min(0.92, 0.5 + (energy - 50) / 100 + ((Number(behavior.outBias) || 0.84) - 0.84) * 0.6));
    const roll = (hashOf(fishId, 'goout', seg) % 1000) / 1000;
    if (roll < p) {
      const lines = [`好呀！${call}等我，看到好玩的贴进笔记本给你看～`, '正想出去逛逛！我收拾一下小书包～', `出发！${call}别太想本鱼哦～`];
      return { go: true, reason: 'yes', line: lines[hashOf(fishId, 'goline', seg) % lines.length] };
    }
    const lines = ['现在不想动……等会儿再说嘛。', '今天想在家待着，陪陪你不好吗？', '外面好像没什么好玩的，本鱼先不去了。'];
    return { go: false, reason: 'lazy', line: lines[hashOf(fishId, 'noline', seg) % lines.length] };
  }
  // 老路径（没传 behavior）：完全照旧
  if (mood < 20) return { go: false, reason: 'sulky', line: '不去。哼。' };
  const p = Math.max(0.2, Math.min(0.92, 0.5 + (energy - 50) / 100 + (mood - 50) / 200));
  const roll = (hashOf(fishId, 'goout', Math.floor(now / 600_000)) % 1000) / 1000;
  if (roll < p) {
    const lines = [`好呀！${call}等我，看到好玩的贴进笔记本给你看～`, '正想出去逛逛！我收拾一下小书包～', `出发！${call}别太想本鱼哦～`];
    return { go: true, reason: 'yes', line: lines[hashOf(fishId, 'goline', Math.floor(now / 600_000)) % lines.length] };
  }
  const lines = ['现在不想动……等会儿再说嘛。', '今天想在家待着，陪陪你不好吗？', '外面好像没什么好玩的，本鱼先不去了。'];
  return { go: false, reason: 'lazy', line: lines[hashOf(fishId, 'noline', Math.floor(now / 600_000)) % lines.length] };
}

/** 拒绝出门的话（心情二期-1c）：按由头各三条、骰子挑；{call} 是称呼。气 / 烦 / 提不起劲是给验收和「今天」看的暗记。 */
const REFUSE_LINES = {
  hurt: [
    '……不去，本鱼还在气头上呢。',
    '哼，本鱼还在生{call}的气，现在不想出门。',
    '不去，哼，{call}，本鱼的气还没消呢。',
  ],
  cranky: [
    '心里烦得很，不想动，{call}让本鱼先静静。',
    '好烦好烦……这会儿谁约本鱼都不出门，{call}也一样。',
    '本鱼心里正烦着，出去也没心情，先不去了，{call}。',
  ],
  down: [
    '今天提不起劲……本鱼哪儿也不想去，{call}别勉强我。',
    '没意思，提不起劲，{call}让本鱼在家窝一会儿好嘛。',
    '不想动，浑身都没劲……{call}本鱼今天就宅着吧。',
  ],
};

/** 松口的话（心情二期-1c）：刚拒过又来问，第二次就答应，但话和拒绝的口气不一样。 */
const SOFTEN_LINES = [
  '……好吧，那就出去走走。{call}等本鱼回来讲见闻给你听。',
  '唉，都问第二遍了，好吧好吧，本鱼陪{call}去走走。',
  '……好吧，看在{call}的面子上，本鱼这就出去转转好了。',
];

/** 拒绝出门的理由写进「今天」时用中文（别把 asleep 这种代码露给人看）；hurt / cranky / down 是心情二期-1c 的三个由头，softened 是松口。 */
export const REFUSE_TEXT = { asleep: '在睡觉', broke: '没零花钱了', tired: '太累了', sulky: '在闹别扭', lazy: '不想去', hurt: '还在生气', cranky: '心里烦', down: '提不起劲', softened: '松口了' };

/**
 * 心情二期-1c：30 分钟内是不是刚因为同一个由头拒过「出门」。
 * 纯函数：events 是她「今天」这类事件清单（ask-out 的文字里带着 REFUSE_TEXT[reason]，这就是由头的账本）。
 * reason 缺了（没心事）或认不出来都算没拒过，不拦第二次。
 */
export function refusedRecently(events, reason, now = Date.now()) {
  if (!reason || !REFUSE_TEXT[reason]) return false;
  const word = REFUSE_TEXT[reason];
  return (Array.isArray(events) ? events : []).some((e) => {
    if (!e || e.kind !== 'ask-out') return false;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || now - at < 0 || now - at >= 30 * 60_000) return false;
    return String(e.text || '').includes(word);
  });
}
