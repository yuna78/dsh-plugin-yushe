// T4 · 发动态（只用她自己的小生活和看过的公开内容，不放主会话的东西）
import { dayOf } from '../../life-engine.js';
import { defineTool } from '../define.js';
import { sentReceipt } from '../bili-common.js';
import { speak, speakReady } from '../speak-common.js';

const CAP = { key: 'postsPerDay', label: '每天最多发几条动态', levels: { 少: 1, 适中: 2, 多: 3 }, max: 5 };
const OK_EVENTS = new Set(['out', 'back', 'nap', 'home', 'act-like', 'act-collect', 'act-follow', 'posted']); // 聊天、干活这些带着爸妈的话，不拿来发动态

export default defineTool({
  name: 'bili_post',
  kind: 'speak',
  description: '用你自己的 B站号发一条纯文字动态（分享你今天的小生活、看到的有意思的东西）。DSH 里爸妈让你发：给一句 intent（想发什么方向），正文你自己在鱼社里写——只会用你自己的经历和看过的公开内容，不会带上爸妈在 DSH 里说的话。再过规矩，每天有上限。',
  params: { intent: { type: 'string', description: '想发的方向（一句话，≤ 40 字）', required: true } },
  tripParams: { text: { type: 'string', description: '你要发的动态（5–200 字）', required: true } },
  cap: CAP,
  draft: { kind: 'post', name: '动态', min: 5, max: 200 },
  receipt: sentReceipt,
  async run(a, deps, { from }) {
    const no = speakReady(deps); if (no) return no;
    const f = deps.pond.current();
    const s = deps.life?.state?.(f) || {};
    const today = (s.events || []).filter((e) => e.day === dayOf() && OK_EVENTS.has(e.kind)).slice(-6).map((e) => `今天：${e.text}`);
    const seen = (s.journal || []).filter((j) => !j.dream).slice(-4).flatMap((j) => (j.seen || []).slice(0, 1).map((x) => `最近看到：《${String(x.title || '').slice(0, 40)}》`)); // F-79：梦里的东西不进对外素材
    return speak(deps, from, { kind: 'post', what: '发一条纯文字动态', max: 120, args: a, material: [...today, ...seen], target: null });
  },
});
