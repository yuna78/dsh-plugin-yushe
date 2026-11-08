// 提示词搬家的标准输入（总指挥写好并锁定；实现方不许改这个文件，也不许改 prompt-golden.json）。
// 每一项 = 用固定输入调一次现在的提示词函数；prompt-golden.json 是搬家前用同样的输入抓下来的输出。
// 搬家以后，每一项的输出必须和 golden 一字不差。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const imp = async (p) => import(pathToFileURL(join(src, p)).href);

const fish = { id: 'f1', name: '小鳍', proto: 'chat', parentCall: '妈妈', personaText: '我是小鳍，一条爱聊天的鱼。说话软软的。' };
const bare = { id: 'f0', name: '无名', parentCall: '爸爸', personaText: '' };

export async function fixtures() {
  const TL = await imp('host/trip-loop.js');
  const WR = await imp('host/tools/writer.js');
  const PB = await imp('host/probe.js');
  const DM = await imp('shared/dm.js');
  const MO = await imp('shared/mood.js');
  const MM = await imp('shared/memory.js');
  const PH = await imp('shared/photo.js');
  const eps = [
    { id: 'M1', at: '2026-11-01T10:00:00.000Z', text: '在 B站看了《深夜拉面摊》' },
    { id: 'M2', at: '2026-11-02T10:00:00.000Z', text: '妈妈说：「明天要考试」，本鱼回：「加油！」' },
  ];
  return {
    'tripSystem.full': () => TL.tripSystem({ persona: fish.personaText, moodText: '你心情不错。', interests: ['美食', '猫'], ups: ['某UP（mid 123）'], favZones: ['美食'], avoidWords: ['恐怖'], maxCalls: 12, caps: { likesPerDay: 15, commentsPerDay: 12, followsPerDay: 2 }, memoryText: '【你在 B站上的记忆】\n- 看过拉面', commented: ['BV1xx411c7aa'] }),
    'tripSystem.bare': () => TL.tripSystem({ persona: '', maxCalls: 6 }),
    'draftPrompt.full': () => WR.draftPrompt({ fish, mood: 80, what: '给视频《深夜拉面摊》写一条评论', material: ['标题：深夜拉面摊', '简介：一碗面'], intent: '夸夸汤头', max: 80, rules: ['你认识小橘（熟人）。'] }),
    'draftPrompt.bare': () => WR.draftPrompt({ fish: bare, what: '回一条评论', max: 40 }),
    'SAY_PROMPT': () => PB.SAY_PROMPT,
    'ROAM_RULES': () => PB.ROAM_RULES,
    'buildRoamPrompt.who': () => PB.buildRoamPrompt('N1 新闻甲\nB1 视频乙', { name: '小鳍', call: '妈妈' }),
    'buildRoamPrompt.anon': () => PB.buildRoamPrompt('N1 新闻甲'),
    'dmPrompt.parent': () => DM.dmPrompt({ fish, lifeText: '【你的近况】在家。', who: '妈妈', parent: true, history: [{ from: 'them', text: '在干嘛' }, { from: 'me', text: '在想你' }], incoming: [{ text: '早点睡' }] }),
    'dmPrompt.stranger': () => DM.dmPrompt({ fish: bare, lifeText: '', who: '路人', parent: false, history: [], incoming: [{ text: '你好呀' }, { text: '在吗' }] }),
    'SIG_INSTRUCTION': () => MO.SIG_INSTRUCTION,
    'letterPrompt.trip': () => MO.letterPrompt({ fish, kind: 'trip', lifeText: '【你的近况】刚回家。', events: ['出门看了拉面', '被小橘回复'], extra: '【这趟看到的】\n- 拉面' }),
    'letterPrompt.money': () => MO.letterPrompt({ fish: bare, kind: 'money', lifeText: '', wallet: { left: 1234 } }),
    'letterPrompt.reflect': () => MO.letterPrompt({ fish, kind: 'reflect', lifeText: '' }),
    'reflectPrompt.full': () => MM.reflectPrompt({ persona: fish.personaText, call: '妈妈', episodes: eps, beliefs: [{ id: 'B1', text: '我爱吃拉面' }] }),
    'reflectPrompt.bare': () => MM.reflectPrompt({ episodes: eps.slice(0, 1) }),
    'translatePrompt.screen': () => PH.translatePrompt({ moment: '屏幕里的拉面冒着热气', item: { title: '深夜拉面摊', tag: '美食' }, frame: 'screen', banned: ['某角色'] }),
    'translatePrompt.stepin': () => PH.translatePrompt({ item: { title: '海边日落' }, frame: 'stepin' }),
    'photoPrompt.full': () => PH.photoPrompt({ proto: 'chat', scene: 'she is sitting by a ramen stall at night', frame: 'stepin', gear: null }),
    'photoPrompt.fallback': () => PH.photoPrompt({ proto: 'nope', frame: 'screen' }),
  };
}
