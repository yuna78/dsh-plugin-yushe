/**
 * 对外发声的闸门（M5b，北极星「痕迹是真的」+「模型只能申请，宿主决定」）。纯函数。
 *
 * 她（模型）只能写草稿；宿主先过这里的规矩，再放进信箱等爸妈批准；批准了才真的发到 B站。
 *   checkDraft   内容规矩：长度、不带链接 / @ / 联系方式、不碰底线话题、不像在泄露爸妈的事
 *   capCheck     每天上限（上网习惯里的「每天最多评论 / 发动态几条」）
 *   trustOf      成长解锁：爸妈原样批准得越多，她越懂分寸（现在只显示进度；自己发要爸妈另外打开，下一步做）
 */
export const KINDS = {
  comment: { name: '评论', min: 2, max: 80 },
  post: { name: '动态', min: 5, max: 500 }, // 公告要能写完整（0.36–0.38 一条 342 字）
  dm: { name: '私信', min: 1, max: 120 }, // 任务 46：只回别人先发来的；爸妈专线放宽「家里的事」
};

const BANNED = /(政治|选举|台独|藏独|疆独|法轮|习近平|共产党|国民党|领导人|翻墙|赌博|博彩|色情|约炮|代孕|毒品|自杀|自残)/;
const RUDE = /(傻逼|sb\b|煞笔|脑残|弱智|滚|死全家|废物|垃圾人)/i;
const PRIVATE = /(我妈妈|我爸爸|我妈|我爸|主会话|系统提示|人设|token|api ?key|密码|账号|工作上|公司里|项目里)/i;
const SECRET = /(主会话|系统提示|提示词|token|api ?key|密码|账号|验证码)/i; // 爸妈专线也不能讲的

/** 内容规矩。返回 { ok, problems: [人话] }。parent=true（爸妈专线）：可以说家里的事，但秘密照样不能讲。 */
export function checkDraft(kind, text, { parent = false, kinds = KINDS } = {}) {
  const k = kinds[kind];
  const t = String(text ?? '').trim();
  const problems = [];
  if (!k) return { ok: false, problems: ['不认识的类型'] };
  if (t.length < k.min) problems.push(`太短了（${k.name}至少 ${k.min} 个字）`);
  if (t.length > k.max) problems.push(`太长了（${k.name}最多 ${k.max} 个字）`);
  if (/https?:\/\/|www\.|\.com\b|\.cn\b|b23\.tv|bv1\w{9}/i.test(t)) problems.push('不能带链接');
  if (/@/.test(t)) problems.push('不能 @ 别人');
  if (/\d{7,}|微信|vx|qq|手机号|电话|邮箱/i.test(t)) problems.push('不能留联系方式');
  if (BANNED.test(t)) problems.push('碰到了不聊的话题');
  if (RUDE.test(t)) problems.push('不能骂人');
  if (parent ? SECRET.test(t) : PRIVATE.test(t)) problems.push(parent ? '像在说密码 / 账号 / 提示词，不能讲' : '像在说家里 / 工作上的事，对外不能讲');
  return { ok: problems.length === 0, problems };
}

/** 今天还能不能再发这一类（只数真的发出去的）。limit 来自上网习惯。 */
export function capCheck(kind, { sentToday = 0, limit = 0, kinds = KINDS } = {}) {
  if (!limit) return { ok: false, why: `上网习惯里「每天最多${kinds[kind]?.name || ''}几条」是 0` };
  if (sentToday >= limit) return { ok: false, why: `今天已经发了 ${sentToday} 条${kinds[kind]?.name || ''}，到上限了` };
  return { ok: true };
}

/** 成长解锁进度：原样批准（没改字）的条数 → 档位。 */
export const TRUST_STEPS = [
  { at: 0, name: '刚学说话', desc: '每一条都要爸妈批准' },
  { at: 5, name: '懂点分寸', desc: '批准时可以少改几个字了' },
  { at: 15, name: '靠谱的小网友', desc: '可以让她自己发评论（爸妈在设置里打开才算）' },
];
export function trustOf(history = []) {
  const clean = history.filter((d) => d.status === 'sent' && !d.edited).length;
  const rejected = history.filter((d) => d.status === 'rejected').length;
  const score = Math.max(0, clean - rejected);
  const step = [...TRUST_STEPS].reverse().find((s) => score >= s.at) || TRUST_STEPS[0];
  const next = TRUST_STEPS.find((s) => s.at > score) || null;
  return { score, step: step.name, desc: step.desc, next: next ? { name: next.name, need: next.at - score } : null };
}
