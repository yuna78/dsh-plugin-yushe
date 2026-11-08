/**
 * 相册照片（F-46）：每趟出门回来，用妈妈配的生图 API 画一张「她在外面」的照片。
 * 规则拼提示词（跟旅行青蛙「地形 × 道具」拼照片一个意思）：她的样子 × 这趟去的地方 × 带的装备。
 * 纯函数；真正调 API 在 host/photos.js。
 */

/** 十五位角色的样子（和立绘出图时的设定一致，见 美术/出图/prompts/<id>.txt）。 */
export const LOOKS = {
  tech: 'silver-white fluffy hair with an ahoge, big deep blue eyes, translucent fin-like ears, iridescent fish tail, black tech jacket with glowing cyan trim, pleated skirt',
  fun: 'long twin-tails with rainbow gradient tips, sparkling amber-pink eyes, translucent fin-like ears, small fish tail, bright pink idol hoodie with star patches, short skirt',
  rigor: 'neat short sky-blue bob, round thin glasses, small pufferfish hair clips, translucent fin-like ears, small fish tail, light-blue cardigan over white blouse with a bow tie',
  grind: 'tidy short black hair with one cyan streak, focused eyes, translucent fin-like ears, small fish tail, slate-grey overalls with a tool belt',
  chat: 'fluffy wavy long orange hair, soft warm eyes, translucent fin-like ears, small goldfish tail, oversized cozy cream knit sweater and loose shorts',
  write: 'long straight violet hair with a thin braid, thoughtful eyes, translucent fin-like ears, small koi tail, violet blazer over white shirt',
  debate: 'high crimson ponytail, sharp confident eyes, translucent fin-like ears, betta fish tail with flowing fins, red military-style jacket with epaulettes',
  slack: 'messy mint-green bun, sleepy half-closed eyes, translucent fin-like ears, small loach tail, oversized mint pajama hoodie and fluffy slippers',
  angel: 'long wavy coral-pink hair with ribbon-like angelfish fin streamers, a tilted beret, translucent fin-like ears, elegant long-finned fish tail, artsy cream smock with a coral scarf',
  shark: 'short messy indigo hair, a tiny fang in her grin, translucent fin-like ears, sturdy shark tail, oversized indigo shark hoodie with a tooth-pattern hood brim',
  seahorse: 'golden curly hair in two buns with a seahorse hair clip, gentle smile, translucent fin-like ears, curled seahorse tail, mustard-yellow dress with a frilly white apron',
  angler: 'long dark navy hair with a small glowing anglerfish lure light on her head, sleepy eyes with a sly smile, translucent fin-like ears, small dark fish tail, cozy navy sweater with a blanket over her shoulders',
  butterfly: 'teal and white two-tone side ponytail with a big butterfly-fin bow, bright smile, translucent fin-like ears, small striped fish tail, teal sailor-style jacket with yellow trim',
  marlin: 'lime-green high ponytail with a sail-like marlin fin crest, determined grin, translucent fin-like ears, sleek forked fish tail, sporty lime and white track jacket and shorts',
  flounder: 'sandy-brown asymmetric bob with long side bangs covering one eye, calm half-smile, translucent fin-like ears, flat wide fish tail, sand-colored explorer vest with many pockets',
};

/** 这趟看了什么 → 照片场景（第一个对得上的；都对不上就逛街）。 */
const SCENES = [
  [['AI', '科技', '数码'], 'exploring a bright futuristic tech expo hall with friendly robots and glowing screens'],
  [['游戏', '动画'], 'at a colorful arcade full of claw machines and game cabinets'],
  [['萌宠', '动物', '猫'], 'in a cozy cat cafe surrounded by fluffy cats'],
  [['美食'], 'at a lively night food market with steaming stalls and lanterns'],
  [['音乐'], 'at a small outdoor music stage with string lights'],
  [['旅行', '纪录片'], 'on a seaside pier at sunset with seagulls'],
  [['知识', '历史', '效率生活'], 'in a sunlit old library with tall bookshelves'],
  [['生活', '时尚', '手工'], 'browsing a cute street market with handmade crafts'],
];
const DEFAULT_SCENE = 'strolling down a sunny shopping street with cherry trees';

/** 带的装备会出现在照片里（旅行青蛙「道具入画」）。 */
const GEAR_PROPS = { camera: 'holding a small vintage camera', compass: 'holding a brass compass', headphones: 'wearing big over-ear headphones', goggles: 'with swimming goggles pushed up on her head' };

export function sceneFor(tags = []) {
  for (const [keys, scene] of SCENES) if (tags.some((t) => keys.some((k) => String(t).includes(k) || k.includes(String(t))))) return scene;
  return DEFAULT_SCENE;
}

/** 照片的提示词：风格锚点固定（跟游戏立绘一致），人物 × 场景 × 道具。 */
export function photoPrompt({ proto, tags = [], gear = null }) {
  const look = LOOKS[proto] || LOOKS.rigor;
  const prop = GEAR_PROPS[gear] ? `, ${GEAR_PROPS[gear]}` : '';
  return [
    `A travel snapshot photo of a cute chibi anime fish girl (${look})${prop}, ${sceneFor(tags)}, happy candid moment, full body, she is small in the frame so the place is visible.`,
    'STYLE: high-end 2D anime mobile game illustration, cel-shaded with soft gradients, crisp clean lineart, vivid saturated colors, warm lighting, like a polaroid travel photo. No text, no letters, no watermark, no border.',
  ].join(' ');
}
