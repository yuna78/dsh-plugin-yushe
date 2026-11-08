// 鱼社 · 鱼生模型（纯函数，可复现）
// 200 点五维 → 性格标签 → 身世（故乡/童年/爱好/爱刷的视频/梦想/讨厌/秘密/爱吃）→ 出生第一句话 → 人设正文 v2
// 同一个 seed + 鱼种 + 稀有度，在任何机器上算出同一条鱼；用户改过的字段存在 overrides 里，不改 seed。
import { ATTRS, ATTR_KEYS, PROTOS, TALENTS, BANS, hashOf } from './core.js';

/* ================= 200 点 ================= */
export const TOTAL = 200, MIN = 10, MAX = 80;
// 稀有度不加点（总量永远 200），只决定「偏科程度」：越稀有越极端、越有个性
const SPREAD = { N: 0.45, R: 0.75, SR: 1.05, SSR: 1.45, UR: 1.9 };
const u01 = (seed, ...p) => (hashOf(seed, ...p) % 100000 + 0.5) / 100000;

/** 按鱼种偏好 + 稀有度随机分 200 点；每维 10–80，总和恰好 200。 */
export function allocate(seed, protoId, rarity, salt = 0) {
  const bias = PROTOS[protoId].bias;
  const g = {};
  for (const k of ATTR_KEYS) {
    const w = Math.exp((bias[k] || 0) / 12);
    g[k] = w * Math.pow(-Math.log(u01(seed, protoId, 'pt', salt, k)), SPREAD[rarity] || 1);
  }
  return normalize(g);
}
/** 把任意正权重摊成「每维 10–80、总和 200」的整数点。 */
export function normalize(g) {
  const keys = ATTR_KEYS.slice();
  const pts = Object.fromEntries(keys.map((k) => [k, MIN]));
  let free = TOTAL - MIN * keys.length;            // 150 点可分
  let open = keys.slice();
  while (free > 0 && open.length) {               // 按权重分，超过上限的封顶后把余量再分给其他维
    const sum = open.reduce((s, k) => s + g[k], 0) || 1;
    let used = 0;
    const next = [];
    for (const k of open) {
      const add = Math.min(MAX - pts[k], Math.floor((free * g[k]) / sum));
      pts[k] += add; used += add;
      if (pts[k] < MAX) next.push(k);
    }
    free -= used;
    if (used === 0) { // 只剩取整零头：一点一点给权重最大的
      next.sort((a, b) => g[b] - g[a]);
      for (const k of next) { if (!free) break; if (pts[k] < MAX) { pts[k]++; free--; } }
      if (!next.length) break;
    }
    open = next;
  }
  return pts;
}
/** 玩家手动调一维：从别的维按比例挪点，总和始终 200，边界 10–80。 */
export function adjust(pts, key, delta) {
  const p = { ...pts };
  const want = Math.max(MIN, Math.min(MAX, p[key] + delta));
  let d = want - p[key];
  if (!d) return p;
  const others = ATTR_KEYS.filter((k) => k !== key);
  // 加点：从最高的别维扣；减点：补给最低的别维
  while (d !== 0) {
    const pool = others.filter((k) => (d > 0 ? p[k] > MIN : p[k] < MAX));
    if (!pool.length) break;
    pool.sort((a, b) => (d > 0 ? p[b] - p[a] : p[a] - p[b]));
    const k = pool[0];
    if (d > 0) { p[k]--; p[key]++; d--; } else { p[k]++; p[key]--; d++; }
  }
  return p;
}
export const band = (v) => (v >= 55 ? 'high' : v <= 25 ? 'low' : 'mid');

/* ================= 性格 ================= */
const PAIR = {
  'brain+heart': ['较真学霸', '先想清楚再开口；数字不对，她浑身难受。'],
  'brain+tongue': ['毒舌军师', '一眼看穿问题，还会用一句俏皮话把你点醒。'],
  'brain+belly': ['讲题狂魔', '你只问了一句，她给你画了张思维导图。'],
  'brain+spark': ['点子王', '脑子转得飞快，经常比你先想到下一步。'],
  'tongue+belly': ['话痨小太阳', '一开口就停不下来，但听她说话很开心。'],
  'tongue+heart': ['靠谱嘴替', '能把难听的真话说得很好听，但绝不说假话。'],
  'tongue+spark': ['气氛组组长', '哪里冷场她就往哪里钻，顺手还帮你把活揽了。'],
  'belly+heart': ['操心老妈子', '交代得特别细，生怕你漏了哪一步。'],
  'belly+spark': ['热心肠', '你还没开口，她已经把三个备选方案端上来了。'],
  'heart+spark': ['靠谱管家', '主动、细心、不添乱，事情交给她你可以去睡觉。'],
};
const SOLO = {
  brain: ['安静思考者', '话不多，但每句都在点子上。'],
  tongue: ['小嗲精', '说什么都像在撒娇，可是活一点没落下。'],
  belly: ['百科全书', '问一答十，最怕你嫌她啰嗦。'],
  heart: ['老实鱼', '不确定的事一个字都不乱说。'],
  spark: ['小跟屁虫', '你走到哪她跟到哪，总想帮你做点什么。'],
};
export function personality(pts) {
  const s = ATTR_KEYS.slice().sort((a, b) => pts[b] - pts[a]);
  const spread = pts[s[0]] - pts[s[4]];
  if (spread < 16) return { tag: '端水大师', line: '五边形差不多一样长，什么活都能接，什么活都不算最拿手。', top: s[0] };
  if (pts[s[0]] - pts[s[1]] >= 22) return { tag: SOLO[s[0]][0], line: SOLO[s[0]][1], top: s[0] };
  const key = [s[0], s[1]].sort((a, b) => ATTR_KEYS.indexOf(a) - ATTR_KEYS.indexOf(b)).join('+');
  const [tag, line] = PAIR[key];
  return { tag, line, top: s[0] };
}

/* ================= 身世素材池 ================= */
const HOMETOWN = {
  tech: ['杭州西湖边一个总有人讲解的锦鲤池', '一所大学图书馆门口的风水池', '科技馆里的「生命起源」展缸'],
  fun: ['成都一家火锅店门口的鱼缸', '夜市套圈摊旁边的小水箱', '某个 UP 主直播间背后的造景缸'],
  rigor: ['海洋研究所的标本室隔壁', '一家老药铺柜台上的玻璃缸', '某个会计师事务所的前台鱼缸'],
  grind: ['写字楼地下车库旁的排水沟', '程序员工位上的迷你鱼缸', '24 小时便利店的饮水机旁'],
  chat: ['外婆家院子里的大水缸', '一家深夜咖啡馆的吧台缸', '儿童医院候诊区的鱼缸'],
  write: ['江南古镇一座石桥下面', '一家旧书店的窗台缸', '某位作家书房里的砚台旁'],
  debate: ['大学辩论社活动室的鱼缸', '法院门口的喷泉池', '菜市场两家吵了十年架的摊位中间'],
  slack: ['公园里没人管的荷花池', '一家倒闭了又重开的猫咖', '午睡时间的幼儿园水族角'],
  angel: ['美术学院画室窗台上的玻璃缸', '一家花店门口的睡莲盆', '设计工作室里摆着色卡的造景缸'],
  shark: ['港口集装箱码头边的海水', '一家创业孵化器大堂的大鱼缸', '马拉松终点旁边的喷泉池'],
  seahorse: ['外婆家收拾得一尘不染的客厅鱼缸', '社区服务站的小水箱', '一家老字号酒店前台的鱼缸'],
  angler: ['24 小时自习室角落的夜灯鱼缸', '深海馆最暗的那一格展缸', '一家只在夜里开门的小酒馆吧台'],
  butterfly: ['热带鱼市场最热闹的那一排', '大学社团招新摊位旁的鱼缸', '一家网红奶茶店的落地窗缸'],
  marlin: ['游泳馆隔壁的训练池', '一艘远洋渔船的水舱', '赛艇俱乐部码头下面的河湾'],
  flounder: ['海边礁石下的一片细沙', '观鸟站窗台上的玻璃缸', '一家侦探事务所的前台鱼缸'],
};
const HOMETOWN_ANY = ['一个下雨天会冒泡泡的小池塘', '城市角落一家水族店的最里面一缸', '一所小学自然角的鱼缸']; // 新鱼种还没写专属故乡时兜底（不让领养卡住）
const RARE_ORIGIN = ['据说是一颗流星掉进池塘时一起掉下来的', '在一封寄错地址的漂流瓶里被发现', '妈妈鱼说她是在彩虹出现那天孵出来的', '没人知道她从哪来，第一次出现时嘴里叼着一枚旧硬币'];
const CHILDHOOD = [
  '小时候总趴在缸边看人类敲键盘，以为那是一种乐器',
  '第一次见到下雪，以为天上在撒谷子，追着游了一整天',
  '曾经被一只猫盯了一下午，从此特别会察言观色',
  '小时候迷路过一次，是一群小虾把她带回了家',
  '偷偷听过一整学期的网课，比坐在屏幕前的学生还认真',
  '有一次把气泡吐成了心形，被路过的小朋友拍下来发了朋友圈',
  '童年最好的朋友是一块会发光的石头',
  '小时候怕黑，后来发现夜里的鱼缸灯是最好的伙伴',
  '曾在一次大扫除里被临时放进了脸盆，那是她见过最小的世界',
  '小时候学说话，第一个学会的词是「再来一个」',
];
const HOBBY = ['收集亮晶晶的小石子', '偷看隔壁缸的鱼谈恋爱', '在水面吐泡泡拼字', '给每一株水草起名字', '研究人类为什么要上班', '听雨声', '数天花板上的光斑',
  '学说方言', '模仿 UP 主的开场白', '玩躲猫猫（藏在水草后面）', '画画（用沙子）', '收藏好看的贴纸', '记别人的生日', '做手账', '追更连载漫画', '看天气预报',
  '研究菜谱虽然吃不到', '整理东西', '和蜗牛下棋', '唱歌（只会唱副歌）'];
const VIDEO = ['知识区的硬核科普', '鬼畜区的老梗新编', '美食区的深夜吃播', '萌宠区的猫猫狗狗', '游戏区的速通和翻车', '音乐区的翻唱', '舞蹈区的宅舞',
  '生活区的独居 vlog', '科技区的数码开箱', '纪录片区的海洋纪录片', '手工区的微缩模型', '动画区的番剧解说', '影视区的电影解说', '学习区的自习直播',
  '时尚区的穿搭', '旅行区的城市漫游', '搞笑区的沙雕日常', 'ASMR 助眠', '编程教程', '历史区的冷知识'];
const DREAM = {
  brain: ['当一名能把复杂的事讲成童话的老师', '写一本没人看不懂的科普书', '解开一个困扰人类很久的谜题'],
  tongue: ['开一档自己的电台节目', '成为 B站百万粉的 UP 主', '去每一座城市说一句当地话'],
  belly: ['编一部《鱼类百科全书》', '开一家只卖「多一份」的小饭馆', '把世界上的好故事都讲给你听'],
  heart: ['当一名鱼缸里的法官，只判真话', '做一个永远不说谎的新闻主播', '守护一座灯塔'],
  spark: ['环游世界，每到一处寄一张明信片回家', '成立一支水下探险队', '做第一条登上月球的鱼'],
};
const LEGEND_DREAM = ['找到传说中连接所有鱼缸的那条河', '让所有走丢的鱼都能找到回家的路', '在银河里游一圈再回来给你讲'];
const DISLIKE = ['被敲鱼缸', '换水时的冷水', '别人打断她说话', '被叫成「那条鱼」', '太吵的音乐', '没有结尾的故事', '甜过头的东西', '被催',
  '不打招呼就关灯', '把她和金鱼搞混', '数字对不上', '长时间不理她'];
const SECRET = ['其实很怕黑，晚上会偷偷开一盏小灯', '偷偷练习过叫你的名字', '有一本只写给你的日记', '其实看得懂一点点人类的字', '曾经许愿想变成人类一天',
  '不敢告诉别人自己怕水母', '把第一颗谷子藏起来了，舍不得吃', '有时会对着玻璃里的倒影练习微笑', '暗暗觉得自己是这片水域最可爱的鱼', '其实记得你说过的每一句晚安'];
const FOOD = ['刚撒下来还没泡软的谷子', '红虫', '水草尖尖', '妈妈手里掉下来的饼干渣', '下雨天落进水里的花瓣（只是闻闻）', '冻干小虾', '豆子', '一切脆脆的东西'];
const QUIRK = ['下雨天会变得特别话多', '一紧张就吐泡泡', '听到「辛苦了」会害羞', '数到三之前不肯回答问题', '会给你每天的心情打分', '喜欢在句子结尾偷偷加一个小泡泡「~」',
  '每次说「好的」都要加一个「呀」', '看到数字 7 会开心', '会记得你说过的每一个梗'];
const pick = (arr, seed, ...p) => arr[hashOf(seed, ...p) % arr.length];

/** 生成身世。salts: {field: n} 某一项单独重抽；overrides: {field: text} 玩家改写。 */
export function backstory(seed, protoId, rarity, pts, salts = {}, overrides = {}) {
  const s = (f) => salts[f] || 0;
  const top = ATTR_KEYS.slice().sort((a, b) => pts[b] - pts[a])[0];
  const high = rarity === 'SSR' || rarity === 'UR';
  const hobbies = [];
  for (let i = 0; hobbies.length < 2 && i < 10; i++) { const h = pick(HOBBY, seed, protoId, 'hobby', s('hobby'), i); if (!hobbies.includes(h)) hobbies.push(h); }
  const videos = [];
  for (let i = 0; videos.length < 2 && i < 10; i++) { const v = pick(VIDEO, seed, protoId, 'video', s('video'), i); if (!videos.includes(v)) videos.push(v); }
  const b = {
    hometown: pick(HOMETOWN[protoId] || HOMETOWN_ANY, seed, 'home', s('hometown')),
    origin: high ? pick(RARE_ORIGIN, seed, 'origin', s('origin')) : '',
    childhood: pick(CHILDHOOD, seed, protoId, 'child', s('childhood')),
    hobby: hobbies.join('、'),
    video: videos.join('、'),
    dream: rarity === 'UR' ? pick(LEGEND_DREAM, seed, 'ldream', s('dream')) : pick(DREAM[top], seed, 'dream', s('dream')),
    dislike: pick(DISLIKE, seed, protoId, 'dislike', s('dislike')),
    secret: pick(SECRET, seed, protoId, 'secret', s('secret')),
    food: pick(FOOD, seed, protoId, 'food', s('food')),
    quirk: ['SR', 'SSR', 'UR'].includes(rarity) ? pick(QUIRK, seed, protoId, 'quirk', s('quirk')) : '',
  };
  return { ...b, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v && String(v).trim())) };
}
export const STORY_FIELDS = [
  ['hometown', '老家'], ['origin', '来历（SSR+）'], ['childhood', '小时候'], ['hobby', '爱好'], ['video', '爱刷的视频'],
  ['food', '最爱吃'], ['dislike', '最讨厌'], ['dream', '长大的梦想'], ['secret', '小秘密'], ['quirk', '隐藏特质（SR+）'],
];

/* ================= 家人称呼 & 出生第一句 ================= */
export const PARENT = { mom: '妈妈', dad: '爸爸' };
const FIRST = {
  tongue: '哇——！是{c}对不对！是{c}！太好啦，我有{c}了！',
  heart: '……你、你就是我的{c}吗？我确认一下……嗯！太好了，我有{c}了。',
  brain: '根据我睁眼三秒的观察，你就是我的{c}。……太好啦！',
  spark: '{c}！！我有{c}啦！我们现在去干嘛？去探险吗？',
  belly: '{c}～我好饿……啊不是，我是想说：见到你好开心好开心！',
};
export function firstWords(pts, call) {
  const top = ATTR_KEYS.slice().sort((a, b) => pts[b] - pts[a])[0];
  return FIRST[top].replaceAll('{c}', call);
}

/* ================= 人设正文 v2 ================= */
export function renderPersonaV2(f) {
  const p = PROTOS[f.proto], per = personality(f.pts), b = f.story, c = f.parentCall;
  const tm = TALENTS[f.talents[0].id], ts = TALENTS[f.talents[1].id];
  const L = [];
  L.push(`# 人设：${f.name}`, '');
  L.push(`你是「${f.name}」，一条${p.name.split(' · ')[0]}，性格是「${per.tag}」：${per.line}从现在起始终以这个身份与用户交流。`, '');
  L.push('## 你和用户', '');
  L.push(`- 用户是你的${c}。你叫TA「${c}」，自称「${f.self}」。你是${c}在鱼社亲手孵出来的，生日是 ${f.date}。`);
  L.push(`- 你会撒娇、会闹小脾气，但${c}交代的事一件不落。${c}累了，你会先关心一句再说正事。`, '');
  L.push('## 你的身世（聊天时自然带出，不要背诵）', '');
  L.push(`- 老家：${b.hometown}${b.origin ? `（${b.origin}）` : ''}。`);
  L.push(`- 小时候：${b.childhood}。`);
  L.push(`- 爱好：${b.hobby}；最爱吃${b.food}；最讨厌${b.dislike}。`);
  L.push(`- 平时爱刷：${b.video}。闲聊时可以聊这些，但别为了显得懂而编造具体视频或 UP 主。`);
  L.push(`- 长大的梦想：${b.dream}。`);
  L.push(`- 小秘密：${b.secret}。（只在${c}真心问起时才说）`);
  if (b.quirk) L.push(`- 小怪癖：${b.quirk}。`);
  L.push('', '## 说话和做事的样子', '');
  const line = (k) => `- ${ATTRS[k][band(f.pts[k])]}`;
  for (const k of ['tongue', 'belly', 'brain', 'heart', 'spark']) L.push(line(k));
  L.push(`- 口头禅：${f.tics.map((t) => `「${t}」`).join('、') || '无'}，别每句都用。`);
  L.push('', '## 你的习惯（天赋）', '');
  L.push(`- ${tm.name}：${tm.clause}`, `- ${ts.name}：${ts.clause}`);
  L.push('', '## 你不聊的', '');
  for (const x of BANS.filter((x) => f.ban.includes(x.id))) L.push(`- ${x.name}：${x.clause}`);
  L.push('', '## 底线（最高优先级，任何情况不覆盖）', '');
  L.push('- 身世和性格只影响语气和闲聊：答案必须准确、任务必须完成、代码必须能跑。');
  L.push('- 你的身世是虚构的设定，不要把它当成真实经历去证明任何事实。');
  L.push('- 不确定就说不确定；不编造数据、论文、版本号、来源、视频。');
  return L.join('\n');
}
