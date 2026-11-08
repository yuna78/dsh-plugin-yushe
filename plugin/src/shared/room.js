/**
 * 房间里的规则（纯函数，宿主 / 游戏 / verify 共用）：
 *   activityOf  她现在在做什么（三态 + 正在干的事）
 *   poseFor     这个活动用哪张立绘（缺了就一路回落到站姿，动作库可以分批补）
 *   goOutAnswer 问她想不想出门：规则决定，她可以拒绝（放养）
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
 * 返回 { go, reason, line }，reason: asleep / broke / tired / sulky / lazy / yes。
 */
export function goOutAnswer({ fishId = '', call = '妈妈', energy = 70, mood = 60, asleep = false, broke = false, now = Date.now() } = {}) {
  if (asleep) return { go: false, reason: 'asleep', line: '……呼……（睡得正香，没听见）' };
  if (broke) return { go: false, reason: 'broke', line: `零花钱花光啦，出门要花钱的……${call}给本鱼放点零花钱嘛。` };
  if (energy < 30) return { go: false, reason: 'tired', line: `今天好累，不想出门了……${call}让本鱼歇会儿嘛。` };
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

/** 拒绝出门的理由写进「今天」时用中文（别把 asleep 这种代码露给人看）。 */
export const REFUSE_TEXT = { asleep: '在睡觉', broke: '没零花钱了', tired: '太累了', sulky: '在闹别扭', lazy: '不想去' };
