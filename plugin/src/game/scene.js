import { HOMES } from '../shared/homes.js';
// 鱼社 · 鱼塘场景（PixiJS v8 + GSAP）· 插件版：宝箱换成鱼卵（M2）—— 卡通 2D 风：粗描边、平涂、硬边光、会弹的东西
// 所有纹理用 2D canvas 现画（Texture.from），不依赖外部图片。
import { Application, Assets, BlurFilter, Container, Sprite, Texture, TilingSprite } from 'pixi.js';
import { ShockwaveFilter } from 'pixi-filters';
import { gsap } from 'gsap';

export const RARITY_HEX = { N: 0xb8c4d0, R: 0x46c2ff, SR: 0xb57bff, SSR: 0xffc23a, UR: 0xff5fa8 };
const OL = '#2a2440';            // 统一描边色（跟渔娘立绘的深色线接得上）
const LW = 4;                    // 统一描边粗细
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const rnd = (a, b) => a + Math.random() * (b - a);

/* ================= 纹理工厂 ================= */
function cv(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.lineJoin = 'round'; g.lineCap = 'round';
  draw(g, w, h); return Texture.from(c);
}
const ink = (g, fill, lw = LW) => { g.fillStyle = fill; g.fill(); g.lineWidth = lw; g.strokeStyle = OL; g.stroke(); };

const texSky = () => cv(4, 256, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#7fd0f2'); gr.addColorStop(1, '#d6f4fb');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
const texWater = () => cv(4, 512, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#3fd0dc'); gr.addColorStop(0.35, '#1fa3c4'); gr.addColorStop(0.75, '#14709c'); gr.addColorStop(1, '#0e4f78');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
const texCloud = () => cv(300, 140, (g) => {
  g.beginPath();
  g.arc(80, 90, 40, Math.PI * 0.5, Math.PI * 1.5);
  g.arc(130, 55, 46, Math.PI, Math.PI * 1.85);
  g.arc(195, 62, 38, Math.PI * 1.15, Math.PI * 1.95);
  g.arc(235, 92, 34, Math.PI * 1.5, Math.PI * 0.5);
  g.closePath();
  ink(g, '#ffffff', 4);
  g.beginPath(); g.ellipse(150, 112, 70, 6, 0, 0, Math.PI * 2); g.fillStyle = 'rgba(127,208,242,.35)'; g.fill();
});
// 远岸：一条起伏的草坡（横向可平铺）
const bankY = (x, w) => 46 - Math.sin((x / w) * Math.PI * 4) * 14 - Math.sin((x / w) * Math.PI * 2) * 6;
const texBank = () => cv(512, 90, (g, w, h) => {
  g.beginPath(); g.moveTo(0, h);
  for (let x = 0; x <= w; x += 8) g.lineTo(x, bankY(x, w));
  g.lineTo(w, h); g.closePath();
  g.fillStyle = '#7ccf6b'; g.fill();
  g.beginPath();
  for (let x = 0; x <= w; x += 8) x ? g.lineTo(x, bankY(x, w)) : g.moveTo(x, bankY(x, w));
  g.lineWidth = LW; g.strokeStyle = OL; g.stroke();
  g.fillStyle = '#5fb455';
  for (let i = 0; i < 18; i++) { g.beginPath(); g.ellipse(rnd(10, w - 10), rnd(64, 84), rnd(8, 18), 3, 0, 0, Math.PI * 2); g.fill(); }
});
// 水面浪线：白色浪花 + 描边（横向平铺）
const waveY = (x, w) => 16 + Math.sin((x / w) * Math.PI * 4) * 6;
const texWave = () => cv(256, 40, (g, w) => {
  g.beginPath(); g.moveTo(0, 40);
  for (let x = 0; x <= w; x += 4) g.lineTo(x, waveY(x, w));
  g.lineTo(w, 40); g.closePath();
  g.fillStyle = 'rgba(255,255,255,.92)'; g.fill();
  g.beginPath();
  for (let x = 0; x <= w; x += 4) x ? g.lineTo(x, waveY(x, w)) : g.moveTo(x, waveY(x, w));
  g.lineWidth = LW; g.strokeStyle = OL; g.stroke();
  g.fillStyle = '#3fd0dc'; g.fillRect(0, 30, w, 10);
});
const texSand = () => cv(512, 120, (g, w, h) => {
  const sy = (x) => 40 + Math.sin((x / w) * Math.PI * 2) * 16 + Math.sin((x / w) * Math.PI * 6) * 5;
  g.beginPath(); g.moveTo(0, h);
  for (let x = 0; x <= w; x += 8) g.lineTo(x, sy(x));
  g.lineTo(w, h); g.closePath(); g.fillStyle = '#f4d9a0'; g.fill();
  g.beginPath(); for (let x = 0; x <= w; x += 8) x ? g.lineTo(x, sy(x)) : g.moveTo(x, sy(x));
  g.lineWidth = LW; g.strokeStyle = OL; g.stroke();
  g.fillStyle = '#e5c07f';
  for (let i = 0; i < 40; i++) { g.beginPath(); g.arc(rnd(4, w - 4), rnd(64, h - 4), rnd(1.5, 3.5), 0, Math.PI * 2); g.fill(); }
});
const texRock = (fill) => cv(140, 90, (g) => {
  g.beginPath(); g.moveTo(10, 84); g.quadraticCurveTo(14, 30, 60, 18); g.quadraticCurveTo(118, 14, 130, 84); g.closePath();
  ink(g, fill);
  g.beginPath(); g.moveTo(40, 40); g.quadraticCurveTo(58, 28, 82, 30); g.lineWidth = 5; g.strokeStyle = 'rgba(255,255,255,.35)'; g.stroke();
});
const texWeed = (fill) => cv(70, 220, (g) => {
  g.beginPath(); g.moveTo(30, 218);
  g.bezierCurveTo(0, 160, 60, 110, 26, 60); g.quadraticCurveTo(14, 30, 36, 6);
  g.quadraticCurveTo(52, 34, 42, 62); g.bezierCurveTo(74, 112, 18, 160, 46, 218); g.closePath();
  ink(g, fill);
  g.beginPath(); g.moveTo(36, 200); g.bezierCurveTo(18, 160, 52, 110, 32, 50); g.lineWidth = 2.5; g.strokeStyle = 'rgba(255,255,255,.35)'; g.stroke();
});
const texReed = () => cv(60, 150, (g) => {
  for (const [x, hgt, lean] of [[18, 140, -6], [30, 120, 4], [42, 100, 10]]) {
    g.beginPath(); g.moveTo(x, 150); g.quadraticCurveTo(x + lean, 150 - hgt / 2, x + lean * 1.5, 150 - hgt); g.lineWidth = 7; g.strokeStyle = OL; g.stroke();
    g.lineWidth = 3.5; g.strokeStyle = '#6fbf5d'; g.stroke();
  }
  g.beginPath(); g.ellipse(9, 22, 6, 16, -0.1, 0, Math.PI * 2); ink(g, '#a0673a', 3);
});
// 卡通鱼：身体 + 尾巴 + 背鳍 + 眼睛 + 花纹，朝右
function texFish(body, belly, spots) {
  return cv(150, 92, (g) => {
    g.beginPath(); g.moveTo(34, 46); g.lineTo(8, 18); g.quadraticCurveTo(18, 46, 8, 74); g.closePath(); ink(g, body);
    g.beginPath(); g.moveTo(66, 22); g.quadraticCurveTo(84, 4, 100, 20); g.closePath(); ink(g, body);
    g.beginPath(); g.ellipse(82, 48, 54, 30, 0, 0, Math.PI * 2); g.fillStyle = body; g.fill();
    g.save(); g.beginPath(); g.ellipse(82, 48, 52, 28, 0, 0, Math.PI * 2); g.clip();
    g.fillStyle = belly; g.beginPath(); g.ellipse(88, 70, 46, 16, 0, 0, Math.PI * 2); g.fill();
    if (spots) { g.fillStyle = spots; for (const [x, y, r] of [[66, 34, 10], [96, 30, 7], [52, 54, 7]]) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); } }
    g.restore();
    g.beginPath(); g.ellipse(82, 48, 54, 30, 0, 0, Math.PI * 2); g.lineWidth = LW; g.strokeStyle = OL; g.stroke();
    g.beginPath(); g.moveTo(84, 54); g.quadraticCurveTo(96, 64, 86, 70); g.lineWidth = 3; g.stroke();
    g.beginPath(); g.arc(114, 40, 9, 0, Math.PI * 2); ink(g, '#fff', 3);
    g.beginPath(); g.arc(117, 40, 4.5, 0, Math.PI * 2); g.fillStyle = OL; g.fill();
    g.beginPath(); g.arc(119, 38, 1.6, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.beginPath(); g.arc(131, 54, 3, 0.2, Math.PI - 0.2); g.lineWidth = 2.5; g.strokeStyle = OL; g.stroke();
    g.fillStyle = 'rgba(255,140,160,.6)'; g.beginPath(); g.ellipse(110, 56, 6, 3, 0, 0, Math.PI * 2); g.fill();
  });
}
const texBubble = () => cv(40, 40, (g) => {
  g.beginPath(); g.arc(20, 20, 15, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,.25)'; g.fill();
  g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.95)'; g.stroke();
  g.beginPath(); g.arc(14, 14, 4, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
});
const texGrain = () => cv(30, 34, (g) => {
  g.beginPath(); g.ellipse(15, 17, 8, 12, 0.35, 0, Math.PI * 2); ink(g, '#ffcf4a', 3);
  g.beginPath(); g.moveTo(12, 9); g.quadraticCurveTo(10, 16, 13, 24); g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.8)'; g.stroke();
});
const texRing = () => cv(260, 260, (g) => { g.beginPath(); g.arc(130, 130, 120, 0, Math.PI * 2); g.lineWidth = 8; g.strokeStyle = '#fff'; g.stroke(); });
const texSoft = (r = 64) => cv(r * 2, r * 2, (g) => {
  const gr = g.createRadialGradient(r, r, 0, r, r, r);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, r * 2, r * 2);
});
const texShaft = () => cv(200, 600, (g, w, h) => {
  g.beginPath(); g.moveTo(60, 0); g.lineTo(140, 0); g.lineTo(200, h); g.lineTo(0, h); g.closePath();
  const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fill();
});
const texBurst = () => cv(800, 800, (g, w) => {
  const c = w / 2, n = 18;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = a0 + Math.PI / n;
    g.beginPath(); g.moveTo(c, c); g.arc(c, c, c, a0, a1); g.closePath();
    const gr = g.createRadialGradient(c, c, 0, c, c, c); gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fill();
  }
});
const texStar = () => cv(64, 64, (g) => {
  g.beginPath();
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 11 : 28, a = -Math.PI / 2 + (i * Math.PI) / 5; g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); }
  g.closePath(); ink(g, '#ffffff', 3.5);
});
const texConf = () => cv(20, 12, (g) => { g.beginPath(); g.roundRect(1, 1, 18, 10, 3); ink(g, '#fff', 2); });
// 鱼卵：奶油色卵壳 + 粉蓝金斑点 + 高光，沿锯齿裂缝切成上下两半（part = 'top' | 'bottom'）
const EGG_W = 240, EGG_H = 300, CRACK_Y = 138;
function crackPath(g) {
  g.moveTo(0, CRACK_Y);
  const n = 9;
  for (let i = 0; i <= n; i++) g.lineTo((EGG_W / n) * i, CRACK_Y + (i % 2 ? -16 : 12));
}
function texEggPart(part) {
  return cv(EGG_W, EGG_H, (g, w, h) => {
    g.save();
    // 裁出这一半
    g.beginPath();
    if (part === 'top') { g.moveTo(0, 0); g.lineTo(w, 0); g.lineTo(w, CRACK_Y + 12); for (let i = 9; i >= 0; i--) g.lineTo((w / 9) * i, CRACK_Y + (i % 2 ? -16 : 12)); g.closePath(); }
    else { crackPath(g); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); }
    g.clip();
    // 卵身
    const egg = () => { g.beginPath(); g.moveTo(w / 2, 14); g.bezierCurveTo(w * 0.92, 14, w - 10, h * 0.62, w - 14, h * 0.68); g.bezierCurveTo(w - 22, h - 8, 22, h - 8, 14, h * 0.68); g.bezierCurveTo(10, h * 0.62, w * 0.08, 14, w / 2, 14); g.closePath(); };
    egg(); g.fillStyle = '#fff7e6'; g.fill();
    g.save(); egg(); g.clip();
    for (const [x, y, r, c] of [[70, 80, 18, '#ffb8d0'], [170, 60, 12, '#9fe0ff'], [150, 120, 22, '#ffe08a'], [60, 190, 16, '#9fe0ff'], [180, 210, 20, '#ffb8d0'], [110, 245, 13, '#ffe08a'], [120, 170, 9, '#c9b8ff']]) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = c; g.fill(); }
    g.beginPath(); g.ellipse(w * 0.34, h * 0.26, 18, 38, -0.4, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,.75)'; g.fill();
    g.fillStyle = 'rgba(42,36,64,.08)'; g.fillRect(0, h * 0.72, w, h);
    g.restore();
    egg(); g.lineWidth = 6; g.strokeStyle = OL; g.stroke();
    g.restore();
    // 裂缝描边（两半都画，叠起来就是一条线）
    g.beginPath(); crackPath(g); g.lineWidth = 4; g.strokeStyle = OL; g.stroke();
  });
}
const texChestBody = () => texEggPart('bottom');
const texChestLid = () => texEggPart('top');

// 插画背景模式下的鱼：无描边的柔和剪影（白色，按场景着色）
const texFishSoft = () => cv(150, 80, (g) => {
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(36, 40); g.lineTo(6, 14); g.quadraticCurveTo(16, 40, 6, 66); g.closePath(); g.fill();
  g.beginPath(); g.ellipse(84, 40, 54, 22, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(70, 20); g.quadraticCurveTo(86, 4, 104, 20); g.closePath(); g.fill();
});

/** 卡通 2D 背景图：surface = 水面在屏幕高度的比例（null = 看不到水面）；fish.style = cartoon（描边卡通鱼）| soft（柔和剪影，配写实风背景）。 */
// 换了背景图就把 ?v= 加一，避开浏览器缓存的旧图
export const BACKDROPS = {
  lagoon: { name: '晨光浅湾', url: './assets/bg/lagoon.webp?v=2', surface: 0.07, shafts: true, fish: { style: 'cartoon', count: 7 }, mote: 0xfff1c2 },
  aquarium: { name: '夜光水族馆', url: './assets/bg/aquarium.webp?v=2', surface: null, shafts: false, bubbles: false, fish: { style: 'cartoon', count: 0 }, mote: 0x9fe8ff },
  sakura: { name: '夕樱锦鲤池', url: './assets/bg/sakura.webp?v=2', surface: null, shafts: false, bubbles: false, fish: { style: 'cartoon', count: 0 }, mote: 0xffc4dc },
  // 她的家（F-49）：10 间房间，数据在 shared/homes.js
  ...Object.fromEntries(HOMES.map((h) => [h.id, { name: h.name, url: `./assets/bg/${h.id}.webp?v=3`, surface: null, shafts: false, bubbles: false, fish: { style: 'cartoon', count: 0 }, mote: h.mote }])),
};
/** 按本地时间挑鱼塘：白天浅湾、傍晚樱花池、夜里水族馆。 */
export function backdropByTime(d = new Date()) {
  const h = d.getHours();
  return h >= 6 && h < 17 ? 'lagoon' : h >= 17 && h < 19 ? 'sakura' : 'aquarium';
}

/* ================= 舞台 ================= */
export async function createScene(canvas) {
  const app = new Application();
  await app.init({ canvas, resizeTo: window, backgroundColor: 0x7fd0f2, antialias: true, preference: 'webgl', resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true });
  const T = {
    sky: texSky(), water: texWater(), cloud: texCloud(), bank: texBank(), wave: texWave(), sand: texSand(),
    rockA: texRock('#8aa6b8'), rockB: texRock('#a3b6a0'), weedA: texWeed('#4fbf6a'), weedB: texWeed('#2f9c6e'), reed: texReed(),
    fish: [texFish('#ff8a3d', '#ffe2b8', '#fff4e6'), texFish('#ffd23f', '#fff3c4', null), texFish('#ff7aa8', '#ffe0ec', '#ffffff'), texFish('#5ec8ff', '#e0f6ff', null)],
    bubble: texBubble(), grain: texGrain(), ring: texRing(), soft: texSoft(), shaft: texShaft(), burst: texBurst(), star: texStar(), conf: texConf(),
    body: texChestBody(), lid: texChestLid(), fishSoft: texFishSoft(),
  };
  for (const k of ['bank', 'wave', 'sand']) T[k].source.addressMode = 'repeat';

  const W = () => app.screen.width, H = () => app.screen.height;
  let bg = null; // null = 程序画的卡通鱼塘（兜底）；否则是 BACKDROPS 的 key
  const surfaceY = () => (bg ? (BACKDROPS[bg].surface == null ? -200 : Math.round(H() * BACKDROPS[bg].surface)) : Math.round(H() * 0.24));

  const world = new Container();
  const skyL = new Container(), waterL = new Container(), deco = new Container(), fishL = new Container(), fx = new Container(), boxLayer = new Container();
  const imgL = new Container(), glowL = new Container();
  world.addChild(imgL, skyL, waterL, deco, fishL, glowL, fx);
  const bgSprite = new Sprite(Texture.EMPTY); imgL.addChild(bgSprite);
  // 插画模式的氛围层：柔光微尘 + 斜射光柱
  const glowMotes = Array.from({ length: 36 }, () => {
    const s = new Sprite(T.soft); s.anchor.set(0.5); s.blendMode = 'add';
    s.fx = Math.random(); s.fy = Math.random(); s.vx = rnd(-0.004, 0.004); s.vy = rnd(-0.012, -0.003); s.ph = rnd(0, 6); s.sc = rnd(0.03, 0.11);
    glowL.addChild(s); return s;
  });
  const glowShafts = [0, 1, 2, 3].map((i) => { const s = new Sprite(T.shaft); s.anchor.set(0.5, 0); s.blendMode = 'add'; s.ph = rnd(0, 6); s.fx = 0.15 + i * 0.24; s.skew.x = -0.3; glowL.addChild(s); return s; });
  glowL.visible = false; imgL.visible = false;
  app.stage.addChild(world, boxLayer);
  const flash = new Sprite(Texture.WHITE); flash.alpha = 0; app.stage.addChild(flash);

  const sky = new Sprite(T.sky); skyL.addChild(sky);
  const clouds = [0, 1, 2, 3].map((i) => { const c = new Sprite(T.cloud); c.anchor.set(0.5); c.scale.set(rnd(0.45, 0.8)); c.vx = rnd(6, 14); c.fx = i / 4 + rnd(0, 0.15); c.fy = rnd(0.15, 0.55); skyL.addChild(c); return c; });
  const bank = new TilingSprite({ texture: T.bank, width: 10, height: 90 }); skyL.addChild(bank);
  const reeds = [0, 1].map(() => { const r = new Sprite(T.reed); r.anchor.set(0.5, 1); skyL.addChild(r); return r; });

  const water = new Sprite(T.water); waterL.addChild(water);
  const shafts = [0, 1, 2, 3, 4].map((i) => { const s = new Sprite(T.shaft); s.anchor.set(0.5, 0); s.ph = rnd(0, 6); s.fx = 0.1 + i * 0.2 + rnd(-0.04, 0.04); s.skew.x = -0.25; waterL.addChild(s); return s; });
  const wave = new TilingSprite({ texture: T.wave, width: 10, height: 40 }); waterL.addChild(wave);

  const sand = new TilingSprite({ texture: T.sand, width: 10, height: 120 }); deco.addChild(sand);
  const weeds = [], rocks = [];
  [0.04, 0.09, 0.2, 0.33, 0.62, 0.78, 0.88, 0.95].forEach((fx_, i) => { const w = new Sprite(i % 2 ? T.weedA : T.weedB); w.anchor.set(0.5, 1); w.fx = fx_; w.ph = rnd(0, 6); w.sc = rnd(0.55, 1.05); deco.addChild(w); weeds.push(w); });
  [[0.14, T.rockA, 0.9], [0.27, T.rockB, 0.6], [0.72, T.rockB, 1], [0.85, T.rockA, 0.7]].forEach(([fx_, t, sc]) => { const r = new Sprite(t); r.anchor.set(0.5, 1); r.fx = fx_; r.sc = sc; deco.addChild(r); rocks.push(r); });

  const fishes = [];
  for (let i = 0; i < 9; i++) {
    const f = new Sprite(T.fish[i % 4]); f.anchor.set(0.5);
    f.base = rnd(0.42, 0.7); f.speed = rnd(40, 70); f.dir = Math.random() < 0.5 ? -1 : 1; f.ph = rnd(0, 6);
    f.x = rnd(0, 1600); f.yf = rnd(0.36, 0.8); f.y = 0; f.target = null;
    fishL.addChild(f); fishes.push(f);
  }

  const shock = new ShockwaveFilter({ center: { x: -999, y: -999 }, amplitude: 10, wavelength: 80, speed: 380, brightness: 1.05, radius: 420 });
  shock.time = 10; world.filters = [shock];

  // 宝箱
  const chest = new Container();
  const body = new Sprite(T.body); body.anchor.set(0.5, 0.5);
  const lid = new Sprite(T.lid); lid.anchor.set(0.5, 0.5);
  chest.addChild(body, lid);
  const shadow = new Sprite(T.soft); shadow.anchor.set(0.5); shadow.tint = 0x0e4f78; shadow.alpha = 0.5;
  const halo = new Sprite(T.soft); halo.anchor.set(0.5); halo.blendMode = 'add'; halo.alpha = 0;
  const burst = new Sprite(T.burst); burst.anchor.set(0.5); burst.alpha = 0;
  boxLayer.addChild(burst, halo, shadow, chest); boxLayer.visible = false;
  chest.eventMode = 'none'; chest.cursor = 'pointer';
  const cs = () => Math.min(1, Math.max(0.55, Math.min(W(), H()) / 760));
  const chestY = () => H() * 0.42;
  function placeChest() {
    const s = cs(); chest.scale.set(s); chest.x = W() / 2; chest.y = chestY();
    body.y = 0; lid.y = 0; lid.x = 0;
    shadow.position.set(W() / 2, chestY() + 150 * s); shadow.scale.set(2.2 * s, 0.32 * s);
    halo.position.set(W() / 2, chestY()); halo.scale.set(5 * s);
    burst.position.set(W() / 2, chestY()); burst.scale.set(1.25 * s);
  }

  function coverBg(extra = 1) {
    const tx = bgSprite.texture;
    if (!tx || tx === Texture.EMPTY || !tx.width) return;
    const s = Math.max(W() / tx.width, H() / tx.height) * extra;
    bgSprite.scale.set(s); bgSprite.anchor.set(0.5); bgSprite.position.set(W() / 2, H() / 2);
  }
  function layout() {
    coverBg(1.06);
    for (const s of glowShafts) { s.y = -20; s.height = H() * 0.9; s.width = W() * 0.14; }
    const sy = surfaceY();
    sky.width = W(); sky.height = sy + 10;
    bank.width = W(); bank.y = sy - 70;
    reeds[0].position.set(W() * 0.06, sy + 6); reeds[1].position.set(W() * 0.94, sy + 6); reeds[1].scale.x = -1;
    water.y = sy; water.width = W(); water.height = H() - sy;
    wave.width = W(); wave.y = sy - 18;
    sand.width = W(); sand.y = H() - 110;
    for (const s of shafts) { s.y = sy + 10; s.height = H() * 0.75; s.width = W() * 0.12; }
    weeds.forEach((w) => { w.x = w.fx * W(); w.y = H() - 40; w.scale.set(w.sc * Math.min(1, H() / 800)); });
    rocks.forEach((r) => { r.x = r.fx * W(); r.y = H() - 30; r.scale.set(r.sc * Math.min(1, H() / 800)); });
    flash.width = W(); flash.height = H();
    placeChest();
  }
  app.renderer.on('resize', layout);

  const grains = [], rings = [], bubbles = [], parts = [];
  let biteResolve = null, t = 0;
  app.ticker.add((tk) => {
    const dt = Math.min(tk.deltaMS / 1000, 0.05); t += dt;
    const sy = surfaceY();
    if (shock.time < 10) shock.time += dt;
    if (bg) {
      coverBg(1.06 + Math.sin(t * 0.05) * 0.015);
      bgSprite.x += Math.sin(t * 0.03) * W() * 0.008; bgSprite.y += Math.cos(t * 0.04) * H() * 0.006;
      for (const m of glowMotes) {
        m.fx += m.vx * dt; m.fy += m.vy * dt;
        if (m.fy < -0.05) { m.fy = 1.05; m.fx = Math.random(); }
        m.position.set(m.fx * W() + Math.sin(t + m.ph) * 10, m.fy * H()); m.scale.set(m.sc); m.alpha = 0.25 + Math.sin(t * 1.3 + m.ph) * 0.15;
      }
      for (const s of glowShafts) { s.x = s.fx * W() + Math.sin(t * 0.3 + s.ph) * 40; s.alpha = 0.07 + Math.sin(t * 0.6 + s.ph) * 0.04; }
    }
    wave.tilePosition.x -= dt * 30;
    bank.tilePosition.x = -t * 4;
    clouds.forEach((c) => { c.fx += (c.vx * dt) / W(); if (c.fx > 1.2) c.fx = -0.2; c.position.set(c.fx * W(), c.fy * sy); });
    shafts.forEach((s) => { s.x = s.fx * W() + Math.sin(t * 0.4 + s.ph) * 30; s.alpha = 0.14 + Math.sin(t * 0.7 + s.ph) * 0.06; });
    weeds.forEach((w) => { w.skew.x = Math.sin(t * 1.2 + w.ph) * 0.12; });
    reeds.forEach((r, i) => { r.skew.x = Math.sin(t * 0.9 + i) * 0.06; });
    if ((!bg || BACKDROPS[bg].bubbles !== false) && Math.random() < dt * 1.2) bubble(rnd(0.05, 0.95) * W(), H() - 60);

    const live = grains.filter((g) => !g.eaten && g.y > sy);
    for (const f of fishes) {
      f.ph += dt * (f.target ? 14 : 6);
      if (!f.y) f.y = f.yf * H();
      let tg = null;
      if (live.length) { let bd = 1e9; for (const g of live) { const d = Math.hypot(g.x - f.x, g.y - f.y); if (d < bd) { bd = d; tg = g; } } }
      f.target = tg;
      if (tg) {
        const dx = tg.x - f.x, dy = tg.y - f.y, d = Math.hypot(dx, dy) || 1;
        f.dir = dx < 0 ? -1 : 1; const sp = f.speed * 3;
        f.x += (dx / d) * sp * dt; f.y += (dy / d) * sp * dt;
        if (d < 20) {
          tg.eaten = true; tg.visible = false; pop(f.x, f.y, 0xffcf4a, 6);
          if (biteResolve) { const r = biteResolve; biteResolve = null; r({ x: f.x, y: f.y }); }
        }
      } else {
        f.x += f.dir * f.speed * dt; f.y += Math.sin(t * 0.8 + f.ph) * 10 * dt;
        f.y = Math.max(sy + 50, Math.min(H() - 130, f.y));
        if (f.x < -120) { f.dir = 1; f.y = rnd(0.36, 0.8) * H(); }
        if (f.x > W() + 120) { f.dir = -1; f.y = rnd(0.36, 0.8) * H(); }
      }
      f.scale.set(f.base * f.dir * (1 + Math.sin(f.ph) * 0.05), f.base * (1 - Math.sin(f.ph) * 0.04));
      f.rotation = Math.sin(f.ph * 0.5) * 0.05 * f.dir;
    }
    for (const g of grains) {
      if (g.eaten) continue;
      g.vy += (g.y < sy ? 900 : 30) * dt;
      if (g.y >= sy && !g.splashed) { g.splashed = true; g.vy *= 0.15; g.vx *= 0.3; ring(g.x, sy + 4); if (Math.random() < 0.5) bubble(g.x, sy + 20); }
      if (g.y > sy) g.vy = Math.min(g.vy, 60);
      g.x += g.vx * dt + (g.y > sy ? Math.sin(t * 2 + g.ph) * 10 * dt : 0); g.y += g.vy * dt; g.rotation += dt * 2;
      if (g.y > H() - 80) { g.eaten = true; g.visible = false; }
    }
    for (let i = rings.length - 1; i >= 0; i--) { const r = rings[i]; r.age += dt; const k = r.age / 0.9; r.scale.set(0.1 + k * 0.45, (0.1 + k * 0.45) * 0.25); r.alpha = (1 - k) * r.a0; if (k >= 1) { r.destroy(); rings.splice(i, 1); } }
    for (let i = bubbles.length - 1; i >= 0; i--) { const b = bubbles[i]; b.y -= b.v * dt; b.x += Math.sin(t * 3 + b.ph) * 16 * dt; if (b.y < sy + 6) { ring(b.x, sy + 4, 0.3); b.destroy(); bubbles.splice(i, 1); } }
    for (let i = parts.length - 1; i >= 0; i--) {
      const s = parts[i]; s.age += dt; s.vx *= 0.97; s.vy = s.vy * 0.97 + s.g * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.rotation += s.spin * dt;
      const k = s.age / s.life; s.alpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      if (k >= 1) { s.destroy(); parts.splice(i, 1); }
    }
    if (burst.alpha > 0) burst.rotation += dt * 0.35;
  });

  function ring(x, y, a = 0.9) { const r = new Sprite(T.ring); r.anchor.set(0.5); r.x = x; r.y = y; r.age = 0; r.a0 = a; fx.addChild(r); rings.push(r); }
  function bubble(x, y) { const b = new Sprite(T.bubble); b.anchor.set(0.5); b.scale.set(rnd(0.3, 0.7)); b.x = x; b.y = y; b.v = rnd(50, 100); b.ph = rnd(0, 6); fx.addChild(b); bubbles.push(b); }
  function pop(x, y, color, n = 30, layer = fx) {
    if (reduced()) return;
    const palette = [color, 0xffffff, 0xffcf4a, 0x6fe3ff, 0xff8fb8];
    for (let i = 0; i < n; i++) {
      const star = Math.random() < 0.45;
      const s = new Sprite(star ? T.star : T.conf); s.anchor.set(0.5);
      s.tint = palette[(Math.random() * palette.length) | 0];
      s.scale.set(star ? rnd(0.3, 0.6) : rnd(0.7, 1.2));
      s.x = x; s.y = y;
      const a = rnd(-Math.PI, 0), v = rnd(260, 620);
      s.vx = Math.cos(a) * v * 1.2; s.vy = Math.sin(a) * v; s.g = 700; s.spin = rnd(-8, 8); s.life = rnd(1, 1.7); s.age = 0;
      layer.addChild(s); parts.push(s);
    }
  }
  function shockAt(x, y) { shock.center = { x, y }; shock.time = 0; }
  layout();

  /** 切换背景：key 见 BACKDROPS；null 回到程序画的卡通鱼塘。图加载失败就保持卡通鱼塘。 */
  async function setBackdrop(key) {
    const conf = key ? BACKDROPS[key] : null;
    if (conf) {
      try { bgSprite.texture = await Assets.load(conf.url); }
      catch { key = null; }
    }
    bg = key || null;
    const on = Boolean(bg);
    imgL.visible = on; glowL.visible = on;
    skyL.visible = !on; waterL.visible = !on; deco.visible = !on;
    glowShafts.forEach((s) => { s.visible = on && BACKDROPS[bg]?.shafts; });
    glowMotes.forEach((m) => { m.tint = on ? BACKDROPS[bg].mote : 0xffffff; });
    fishes.forEach((f, i) => {
      const fc = on ? BACKDROPS[bg].fish : null;
      if (fc && fc.style === 'soft') { f.texture = T.fishSoft; f.tint = fc.tint; f.alpha = i < fc.count ? fc.alpha : 0; }
      else { f.texture = T.fish[i % 4]; f.tint = 0xffffff; f.alpha = fc ? (i < fc.count ? (fc.alpha ?? 1) : 0) : 1; }
      f.y = Math.max(surfaceY() + 60, Math.min(H() - 140, f.y || f.yf * H()));
    });
    fishL.filters = on && BACKDROPS[bg].fish.style === 'soft' ? [new BlurFilter({ strength: 1.6 })] : null;
    layout();
    return bg;
  }

  return {
    app,
    setBackdrop,
    get backdrop() { return bg; },
    cast(x = W() / 2) {
      if (reduced()) return Promise.resolve();
      for (let i = 0; i < 16; i++) {
        const g = new Sprite(T.grain); g.anchor.set(0.5); g.scale.set(rnd(0.7, 1));
        g.x = x + rnd(-W() * 0.14, W() * 0.14); g.y = -rnd(10, 180); g.vx = rnd(-40, 40); g.vy = rnd(0, 150); g.ph = rnd(0, 6);
        fx.addChild(g); grains.push(g);
      }
      setTimeout(() => shockAt(x, surfaceY()), 360);
      return new Promise((res) => { biteResolve = res; setTimeout(() => { if (biteResolve) { biteResolve = null; res({ x, y: H() / 2 }); } }, 4500); });
    },
    showBox() {
      grains.forEach((g) => { g.eaten = true; g.visible = false; });
      placeChest(); boxLayer.visible = true;
      chest.alpha = 1; chest.rotation = 0; lid.rotation = 0; lid.alpha = 1; lid.y = 0; burst.alpha = 0; halo.alpha = 0;
      const y0 = chest.y, s = cs();
      if (!reduced()) {
        chest.y = H() + 220;
        const tl = gsap.timeline();
        tl.to(chest, { y: y0, duration: 0.7, ease: 'power2.out' })
          .to(chest.scale, { x: s * 1.15, y: s * 0.85, duration: 0.1 })
          .to(chest.scale, { x: s, y: s, duration: 0.5, ease: 'elastic.out(1,0.35)' })
          .add(() => gsap.to(chest, { y: y0 - 10, duration: 0.9, yoyo: true, repeat: -1, ease: 'sine.inOut' }));
        gsap.fromTo(shadow, { alpha: 0 }, { alpha: 0.5, duration: 0.8 });
      }
      chest.eventMode = 'static';
      return new Promise((res) => chest.once('pointertap', () => { chest.eventMode = 'none'; res(); }));
    },
    async openBox(rarity) {
      const col = RARITY_HEX[rarity], s = cs();
      gsap.killTweensOf(chest); chest.y = chestY();
      if (reduced()) { boxLayer.visible = false; return; }
      const high = rarity === 'SR' || rarity === 'SSR' || rarity === 'UR';
      const tl = gsap.timeline();
      halo.tint = high ? RARITY_HEX.R : col;
      tl.to(halo, { alpha: 0.6, duration: 0.3 });
      const shakes = high ? 12 : 7;
      for (let i = 0; i < shakes; i++) {
        const k = 0.5 + i / shakes;
        tl.to(chest, { rotation: (i % 2 ? -1 : 1) * 0.09 * k, duration: 0.08, ease: 'sine.inOut' });
        if (i % 3 === 0) tl.to(lid, { y: -10 * k, rotation: (i % 2 ? 0.06 : -0.06), duration: 0.05, yoyo: true, repeat: 1 }, '<');
      }
      if (high) tl.add(() => { halo.tint = col; shockAt(chest.x, chest.y); }).to(halo.scale, { x: 7 * s, y: 7 * s, duration: 0.2, yoyo: true, repeat: 1 });
      tl.to(chest, { rotation: 0, duration: 0.06 })
        .to(chest.scale, { x: s * 1.2, y: s * 0.8, duration: 0.12, ease: 'power2.in' })
        .add(() => { burst.tint = col; pop(chest.x, chest.y, col, rarity === 'N' ? 30 : rarity === 'R' ? 45 : 80, app.stage); shockAt(chest.x, chest.y); })
        .to(chest.scale, { x: s, y: s, duration: 0.35, ease: 'elastic.out(1,0.4)' })
        .to(lid, { y: -300, rotation: -0.8, duration: 0.55, ease: 'power2.out' }, '<')
        .to(lid, { alpha: 0, duration: 0.2 }, '>-0.15')
        .to(flash, { alpha: high ? 0.9 : 0.6, duration: 0.06 }, '<-0.4')
        .to(flash, { alpha: 0, duration: 0.5 })
        .to(burst, { alpha: 0.85, duration: 0.3 }, '<-0.4')
        .to([chest, shadow], { alpha: 0, duration: 0.3 }, '<');
      await tl.then();
    },
    backdrop(rarity) {
      boxLayer.visible = true; chest.alpha = 0; shadow.alpha = 0;
      burst.tint = RARITY_HEX[rarity]; halo.tint = RARITY_HEX[rarity];
      burst.position.set(W() / 2, H() * 0.44); halo.position.set(W() / 2, H() * 0.44);
      gsap.to(burst, { alpha: reduced() ? 0.5 : 0.8, duration: 0.3 });
      gsap.to(halo, { alpha: 0.5, duration: 0.3 });
    },
    clearStage() { gsap.to([burst, halo], { alpha: 0, duration: 0.3, onComplete: () => { boxLayer.visible = false; placeChest(); } }); },
    pop(x, y, rarity) { pop(x, y, RARITY_HEX[rarity], 34, app.stage); },
  };
}
