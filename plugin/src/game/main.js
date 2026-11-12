// 鱼社 · 游戏（插件版，M2 出生）—— 跑在 DSH 浮层的 iframe 里：/api/dsh-yushe/game/
// 流程：引导（ink 剧本，本鱼问爸爸/妈妈）→ 撒谷子 → 鱼卵 → 揭晓 → 挑一颗 → 捏性格（200 点 + 身世）→ 起名
//      → 破壳（AI 现写第一句，头像换成宝宝）→ 领养落盘（宿主渲染人设并注入）→ 本鱼告别 → 上工
import { Story } from 'inkjs';
import storyJson from './story/onboarding.ink';
import { createScene, BACKDROPS, backdropByTime } from './scene.js';
import { PROTOS, PROTO_IDS, BANS, RARITY, ATTRS, ATTR_KEYS, COMMON_TICS, roll, pickTalents, protoOrder, checkName, newSeed } from '../shared/core.js';
import { allocate, adjust, band, personality, backstory, STORY_FIELDS, renderPersonaV2 } from '../shared/life.js';
import { poseFor, pickIdlePose } from '../shared/room.js';
import { tokensText } from '../shared/allowance.js';
import { nextTip, SAY_LINES } from '../shared/tips.js';
import { HOMES, homeOf } from '../shared/homes.js';
import { noteKind, DEPTH_NAMES, isFiller } from '../shared/notes.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ART = (id) => `./assets/girl-${id}.webp`;
// 游戏里不放 emoji（F-39）：图标都是项目自己的彩色图标集（美术/assets/icons，生图 + 抠图）
const ICON = (n, cls = '') => `<img class="ic${cls ? ` ${cls}` : ''}" src="./assets/icons/${n}.webp" alt="">`;
const UP_SVG = '<svg class="trend-up" viewBox="0 0 12 12"><path d="M6 2l4 6H2z" fill="#2fbf71" stroke="#2a2440" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const DN_SVG = '<svg class="trend-dn" viewBox="0 0 12 12"><path d="M6 10L2 4h8z" fill="#e0475b" stroke="#2a2440" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const ACT_ICON = { sleep: 'moon', dream: 'moon', out: 'door', working: 'work', reading: 'news', writing: 'diary', thinking: 'think', home: 'house' };
// 动作库（F-67）：每位角色 stand + sleep + assets/pose/<鱼种>/ 里出好的姿势（清单由构建生成）；没出的回落站姿
let POSE_MANIFEST = {};
fetch('./assets/pose/manifest.json').then((r) => r.json()).then((m) => { POSE_MANIFEST = m || {}; }).catch(() => {});
const posesOf = (proto) => new Set(['stand', 'sleep', ...(POSE_MANIFEST[proto] || [])]);
const POSE_ART = (id, pose) => (pose === 'sleep' ? `./assets/sleep-${id}.webp` : pose === 'stand' ? ART(id) : `./assets/pose/${id}/${pose}.webp`);
// 闲着随机换姿势 + 喂零食 / 摸头的小反应（几秒后回到平时）
const IDLE = { pose: null, until: 0 }, REACTION = { pose: null, until: 0 };
function react(pose, ms = 6000) { REACTION.pose = pose; REACTION.until = Date.now() + ms; if (LIFE?.fish) renderPresence(LIFE); setTimeout(() => { if (LIFE?.fish && document.body.dataset.screen === 'home') renderPresence(LIFE); }, ms + 50); }
setInterval(() => {
  if (document.body.dataset.screen !== 'home' || !LIFE?.fish || document.hidden) return;
  if (Date.now() < IDLE.until) return;
  const f = homeFish(); if (!f) return;
  IDLE.pose = pickIdlePose(posesOf(f.proto), IDLE.pose); IDLE.until = Date.now() + 20_000 + Math.random() * 20_000;
  renderPresence(LIFE);
}, 4000);
const POSE = (p) => `./assets/benyu/${p}.webp`;
const API = '/api/dsh-yushe';
const TIER_BG = { N: 'var(--N)', R: 'var(--R)', SR: 'var(--SR)', SSR: 'var(--SSR)' };
const STARS = { N: 1, R: 2, SR: 3, SSR: 4, UR: 5 };
const AFF = { code: '写代码', copy: '写文案', research: '查资料', chat: '陪聊', teach: '讲明白', ops: 'B站运营' };
const NAMES = { brain: '智力 · 想得深', tongue: '嘴 · 会说话', belly: '胃 · 讲得多', heart: '心 · 靠得住', spark: '灵 · 爱主动' };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// panel = 左侧栏整页面板（主入口）；overlay = 起始页 chip / 设置页打开的浮层
const MODE = new URLSearchParams(location.search).get('mode') === 'panel' ? 'panel' : 'overlay';

const S = {
  seed: null, casts: [], opened: [], picked: null, salt: [0, 0, 0], tal: [], main: [0, 0, 0], rerolls: 3, run: 0,
  firstEgg: true, owned: new Set(), call: '妈妈',
  pts: null, ptsSalt: 0, salts: {}, over: {},
  name: '', self: '本鱼', tics: [], ban: ['politics', 'flame'], firstWords: '', fish: null,
};

const scene = await createScene($('sea'));
// 场景：鱼塘按时间（或在设置里固定一张），她的房间固定赛博鱼缸房。偏好只存在这个浏览器（可丢）。
const SCENE_KEY = 'dsh-yushe.pondScene';
const pondPref = () => { try { return localStorage.getItem(SCENE_KEY) || 'auto'; } catch { return 'auto'; } };
const pondScene = () => { const p = pondPref(); return p !== 'auto' && BACKDROPS[p] ? p : backdropByTime(); };
const toPondScene = () => scene.setBackdrop(pondScene());
const setScreen = (s) => { document.body.dataset.screen = s; };
let tt;
const toast = (m) => { const el = $('toast'); el.textContent = m; el.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => el.classList.remove('on'), 1800); };
const api = async (path, body) => (await fetch(`${API}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const closeGame = () => window.parent?.postMessage({ type: 'dsh-yushe:close' }, location.origin);

/* ================= 对话框 ================= */
let typing = null;
function setSpeaker(who, img) {
  $('who').textContent = who;
  const p = $('portrait');
  if (!p.src.endsWith(img.replace('./', '/'))) { p.src = img; p.classList.remove('boing'); void p.offsetWidth; p.classList.add('boing'); }
}
function typeLine(text) {
  clearInterval(typing);
  const el = $('line');
  if (reduced()) { el.textContent = text; return Promise.resolve(); }
  return new Promise((done) => {
    let i = 0; el.textContent = '';
    typing = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) { clearInterval(typing); done(); } }, 32);
  });
}
function waitTap() {
  $('tapnext').style.display = 'block';
  return new Promise((res) => {
    const on = (e) => { if (e.target.closest('button,input')) return; $('talk').removeEventListener('click', on); $('tapnext').style.display = 'none'; res(); };
    $('talk').addEventListener('click', on);
  });
}
function choose(options) {
  $('talk').classList.add('wait');
  return new Promise((res) => {
    $('choices').innerHTML = options.map((o, i) => `<button class="gb ${i ? 'plain' : 'pink'} sm" data-i="${i}">${esc(o)}</button>`).join('');
    $('choices').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $('choices').innerHTML = ''; $('talk').classList.remove('wait'); res(+b.dataset.i); };
  });
}
function askCall() {
  $('callBox').classList.add('on'); $('callInput').value = ''; $('callInput').focus();
  return new Promise((res) => {
    const ok = () => {
      const v = $('callInput').value.trim();
      const err = !v ? '写一个称呼吧' : v.length > 6 ? '最多 6 个字' : checkName(v);
      if (err) return toast(err);
      $('callBox').classList.remove('on'); res(v);
    };
    $('callOk').onclick = ok;
    $('callInput').onkeydown = (e) => { if (e.key === 'Enter') ok(); };
  });
}

/* ================= ink 剧本 ================= */
const story = new Story(storyJson);
const ACTIONS = {};
const MIDWIFE = '鱼见未来本鱼'; // 接生员的名牌（她说话时还自称「本鱼」）
async function runKnot(knot) {
  story.ChoosePathString(knot);
  for (;;) {
    while (story.canContinue) {
      const raw = story.Continue().trim();
      const tags = Object.fromEntries(story.currentTags.map((t) => { const [k, ...v] = t.split(':'); return [k.trim(), v.join(':').trim()]; }));
      const m = raw.match(/^([^：:]{1,8})[：:]\s*([\s\S]*)$/);
      const who = m ? (m[1] === '本鱼' ? MIDWIFE : m[1]) : MIDWIFE, text = m ? m[2] : raw; // 剧本里写「本鱼：」，名牌显示接生员全名
      if (tags.pose) setSpeaker(who, POSE(tags.pose)); else $('who').textContent = who;
      await typeLine(text);
      if (tags.input === 'call') { const v = await askCall(); story.variablesState.call = v; S.call = v; }
      else if (!tags.action && (story.canContinue || !story.currentChoices.length)) await waitTap();
      if (tags.action && ACTIONS[tags.action]) await ACTIONS[tags.action]();
    }
    if (story.currentChoices.length) { story.ChooseChoiceIndex(await choose(story.currentChoices.map((c) => c.text))); continue; }
    break;
  }
  S.call = String(story.variablesState.call || S.call);
}

/* ================= 卡牌 ================= */
function cardHTML(c, name) {
  const p = PROTOS[c.proto];
  const peak = Math.max(...ATTR_KEYS.map((k) => c.attrs[k]));
  const best = Object.entries(p.affinity).find(([, g]) => g === 'S');
  return `<div class="card" data-r="${c.rarity}"><div class="in">
    <div class="art"><img src="${ART(c.proto)}" alt=""><div class="gem">${c.rarity}</div><div class="stars">${'<i></i>'.repeat(STARS[c.rarity])}</div><div class="plate">${esc(name || p.defaultName)}</div></div>
    <div class="meta"><div class="sp">${esc(p.name)} · 最拿手：${best ? AFF[best[0]] : '通用'}</div>
      <div class="st">${ATTR_KEYS.map((k) => { const v = c.attrs[k], pk = v === peak && v >= 80 ? 'pk' : ''; return `<span>${ATTRS[k].name}</span><i><b class="${pk}" style="width:${v}%"></b></i><em class="${pk}">${v}</em>`; }).join('')}</div>
    </div><div class="shine"></div></div></div>`;
}

/* ================= 撒谷子 → 鱼卵 → 揭晓 ================= */
ACTIONS.cast = async () => { setScreen('pond'); };
async function castFlow() {
  const run = ++S.run;
  S.seed = newSeed();
  S.casts = protoOrder(S.seed).slice(0, 3).map((p, i) => roll(S.seed, p, i, i === 0 && S.firstEgg ? 'SR' : null));
  S.opened = [true, false, false]; S.picked = null; S.salt = [0, 0, 0]; S.main = [0, 0, 0]; S.rerolls = 3;
  S.tal = S.casts.map((c, i) => pickTalents(S.seed, c.proto, i, c.rarity, 0));
  setScreen('casting'); setSpeaker(MIDWIFE, POSE('hype')); typeLine('撒——！看它们抢得多欢……');
  await scene.cast(innerWidth / 2);
  if (run !== S.run) return;
  setSpeaker(MIDWIFE, POSE('point')); typeLine('有一颗鱼卵浮上来啦！摸摸它～');
  await scene.showBox();
  if (run !== S.run) return;
  setSpeaker(MIDWIFE, POSE('hype')); typeLine('它在动……');
  await scene.openBox(S.casts[0].rarity);
  if (run !== S.run) return;
  showReveal(0);
}
const REACT = { N: ['是一颗普通的卵～普通也很可爱嘛！', 'wow'], R: ['哦哦！还不错嘛～', 'wow'], SR: ['哇——SR！运气真好呀！', 'jump'], SSR: ['SSR！！！本鱼都要羡慕了！', 'cheer'], UR: ['UR……是传说！本鱼要晕过去了……', 'cheer'] };
function showReveal(i) {
  const c = S.casts[i], rk = $('rk');
  rk.dataset.r = c.rarity; rk.style.setProperty('--rc', `var(--${c.rarity})`);
  rk.innerHTML = `${c.rarity}<small>${RARITY[c.rarity].name}</small>`;
  rk.style.animation = 'none'; void rk.offsetWidth; rk.style.animation = '';
  $('rcard').innerHTML = cardHTML(c);
  scene.backdrop(c.rarity);
  setScreen('reveal');
  setSpeaker(MIDWIFE, POSE(REACT[c.rarity][1])); typeLine(`${REACT[c.rarity][0]}　点一下继续～`);
}
function leaveReveal() { if (document.body.dataset.screen !== 'reveal') return; scene.clearStage(); renderPick(); setScreen('pick'); }
$('reveal').addEventListener('click', leaveReveal);
$('talk').addEventListener('click', (e) => { if (!e.target.closest('button,input') && document.body.dataset.screen === 'reveal') leaveReveal(); });
$('skip').addEventListener('click', () => { S.run++; scene.clearStage(); showReveal(0); });
$('castBtn').addEventListener('click', () => castFlow());

/* ================= 挑一颗 ================= */
function renderPick() {
  const trio = $('trio');
  trio.classList.toggle('has-sel', S.picked !== null);
  trio.innerHTML = S.casts.map((c, i) => `<div class="flip ${S.opened[i] ? 'open' : ''} ${S.picked === i ? 'sel' : ''}" data-i="${i}"><div class="inner"><div class="face"><div class="back"><div><b>卵</b></div></div></div><div class="face front">${cardHTML(c)}</div></div><div class="q">点我打开！</div></div>`).join('');
  const left = S.opened.filter((x) => !x).length;
  $('pickTip').textContent = left ? `还有 ${left} 颗没开，点开看看！` : (S.picked === null ? '都打开啦！挑一颗最有缘的～' : '再给她挑一个最拿手的习惯！');
  renderSkills();
  $('toForge').disabled = S.picked === null;
  $('reroll').disabled = S.picked === null || S.rerolls <= 0;
  $('rerollN').textContent = S.rerolls;
}
$('trio').addEventListener('click', (e) => {
  const f = e.target.closest('.flip'); if (!f) return;
  const i = +f.dataset.i;
  if (!S.opened[i]) {
    S.opened[i] = true; f.classList.add('open');
    const b = f.getBoundingClientRect();
    setTimeout(() => { scene.pop(b.left + b.width / 2, b.top + b.height / 2, S.casts[i].rarity); toast(`${S.casts[i].rarity}！${PROTOS[S.casts[i].proto].defaultName}`); }, 300);
    setTimeout(renderPick, 650);
    return;
  }
  S.picked = i; renderPick();
});
function renderSkills() {
  if (S.picked === null) { $('skills').innerHTML = ''; $('skillLabel').textContent = ''; return; }
  $('skillLabel').textContent = '— 她最拿手的习惯（选一个）—';
  $('skills').innerHTML = S.tal[S.picked].main.map((x, j) => `<button class="skill ${S.main[S.picked] === j ? 'on' : ''}" data-j="${j}"><span class="tier" style="background:${TIER_BG[x.tier]}">${x.tier}</span><b>${esc(x.name)}</b><small>${esc(x.clause)}</small></button>`).join('');
}
$('skills').addEventListener('click', (e) => { const b = e.target.closest('.skill'); if (!b) return; S.main[S.picked] = +b.dataset.j; renderSkills(); });
$('reroll').addEventListener('click', () => {
  if (S.picked === null || S.rerolls <= 0) return;
  const i = S.picked, c = S.casts[i];
  S.rerolls--; S.salt[i]++; S.main[i] = 0;
  S.tal[i] = pickTalents(S.seed, c.proto, i, c.rarity, S.salt[i]);
  renderPick();
});
$('recast').addEventListener('click', () => castFlow());
$('toForge').addEventListener('click', async () => { setScreen('intro'); await runKnot('picked'); });

/* ================= 捏性格（200 点 + 身世） ================= */
const cur = () => S.casts[S.picked];
ACTIONS.forge = async () => {
  const c = cur();
  S.ptsSalt = 0; S.pts = allocate(S.seed, c.proto, c.rarity); S.salts = {}; S.over = {};
  renderForge(); setScreen('forge');
};
function renderForge() {
  const c = cur(), per = personality(S.pts);
  $('forgeCard').innerHTML = cardHTML(c);
  $('ftag').textContent = per.tag; $('ftagline').textContent = per.line;
  $('psum').textContent = Object.values(S.pts).reduce((a, b) => a + b, 0);
  $('stats').innerHTML = ATTR_KEYS.map((k) => {
    const v = S.pts[k], bd = band(v);
    return `<div class="stat"><div class="k">${ATTRS[k].name}</div><div class="bar2"><i class="${bd === 'high' ? 'hi' : bd === 'low' ? 'lo' : ''}" style="width:${(v / 80) * 100}%"></i></div><button class="pm" data-k="${k}" data-d="-5">−</button><div class="n">${v}</div><button class="pm" data-k="${k}" data-d="5">+</button><div class="desc">${NAMES[k]}：${esc(ATTRS[k][bd])}</div></div>`;
  }).join('');
  const st = backstory(S.seed, c.proto, c.rarity, S.pts, S.salts, S.over);
  $('story').innerHTML = STORY_FIELDS.map(([f, label]) => {
    const locked = !st[f];
    return `<div class="sf ${locked ? 'locked' : ''}"><b>${label}</b><div class="v ${S.over[f] ? 'edited' : ''}" contenteditable="${!locked}" data-f="${f}">${locked ? '（稀有度不够，还没解锁）' : esc(st[f])}</div><button class="dice" data-f="${f}" ${locked ? 'disabled' : ''} title="重抽">${ICON('dice')}</button></div>`;
  }).join('');
}
$('stats').addEventListener('click', (e) => { const b = e.target.closest('.pm'); if (!b) return; S.pts = adjust(S.pts, b.dataset.k, +b.dataset.d); renderForge(); });
$('story').addEventListener('click', (e) => { const b = e.target.closest('.dice'); if (!b) return; const f = b.dataset.f; S.salts[f] = (S.salts[f] || 0) + 1; delete S.over[f]; renderForge(); });
$('story').addEventListener('focusout', (e) => { const v = e.target.closest('.v'); if (!v) return; const text = v.textContent.trim().slice(0, 60); if (text) S.over[v.dataset.f] = text; else delete S.over[v.dataset.f]; renderForge(); });
$('prand').addEventListener('click', () => { S.ptsSalt++; S.pts = allocate(S.seed, cur().proto, cur().rarity, S.ptsSalt); renderForge(); });
$('preset').addEventListener('click', () => { S.ptsSalt = 0; S.pts = allocate(S.seed, cur().proto, cur().rarity); renderForge(); });
$('backPick').addEventListener('click', () => setScreen('pick'));
$('toName').addEventListener('click', () => { openName(); setScreen('name'); });

/* ================= 起名 ================= */
function spec() {
  const c = cur(), t = S.tal[S.picked];
  return {
    seed: S.seed, proto: c.proto, cast: S.picked, minRarity: S.picked === 0 && S.firstEgg ? 'SR' : null,
    pts: S.pts, salts: S.salts, overrides: S.over, parentCall: S.call,
    name: S.name || PROTOS[c.proto].defaultName, self: S.self, tics: S.tics, ban: S.ban,
    talentIds: [t.main[S.main[S.picked]].id, t.sub.id], firstWords: S.firstWords, home: S.home || 'cyberroom', workspaceId: S.workspaceId || null,
  };
}
function previewPersona() {
  const s = spec(), c = cur();
  return renderPersonaV2({ proto: c.proto, pts: s.pts, story: backstory(s.seed, c.proto, c.rarity, s.pts, s.salts, s.overrides), parentCall: s.parentCall, name: s.name, self: s.self, tics: s.tics, ban: s.ban, talents: [S.tal[S.picked].main[S.main[S.picked]], S.tal[S.picked].sub], date: new Date().toISOString().slice(0, 10) });
}
function openName() {
  const p = PROTOS[cur().proto];
  S.name = p.defaultName; S.self = p.selfDefault; S.tics = [p.tics[0]];
  $('fName').value = S.name; $('fErr').textContent = '';
  renderNameForm();
}
function renderNameForm() {
  const p = PROTOS[cur().proto];
  $('nameCard').innerHTML = cardHTML(cur(), S.name);
  $('fSelf').innerHTML = [...new Set([p.selfDefault, '本鱼', '我', '人家'])].map((s) => `<button class="chip ${S.self === s ? 'on' : ''}" data-v="${esc(s)}">${esc(s)}</button>`).join('');
  $('fTics').innerHTML = [...new Set([...p.tics, ...COMMON_TICS.slice(0, 4)])].map((s) => `<button class="chip ${S.tics.includes(s) ? 'on' : ''}" data-v="${esc(s)}">${esc(s)}</button>`).join('');
  $('fBan').innerHTML = BANS.map((b) => `<button class="chip ${S.ban.includes(b.id) ? 'on' : ''} ${b.locked ? 'lock' : ''}" data-v="${b.id}">${esc(b.name)}</button>`).join('');
  $('fPreview').textContent = previewPersona();
}
$('fName').addEventListener('input', (e) => { S.name = e.target.value.trim(); $('fErr').textContent = checkName(S.name); $('nameCard').querySelector('.plate').textContent = S.name || PROTOS[cur().proto].defaultName; $('fPreview').textContent = previewPersona(); });
$('fSelf').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; S.self = b.dataset.v; renderNameForm(); });
$('fTics').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  const v = b.dataset.v;
  if (S.tics.includes(v)) S.tics = S.tics.filter((x) => x !== v);
  else if (S.tics.length >= 2) return toast('口头禅最多两个哦');
  else S.tics = [...S.tics, v];
  renderNameForm();
});
$('fBan').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  const ban = BANS.find((x) => x.id === b.dataset.v);
  if (ban.locked) return toast('涉政和骂战永远不聊，关不掉的～');
  S.ban = S.ban.includes(ban.id) ? S.ban.filter((x) => x !== ban.id) : [...S.ban, ban.id];
  renderNameForm();
});
$('backForge').addEventListener('click', () => { renderForge(); setScreen('forge'); });
$('hatchBtn').addEventListener('click', async () => {
  const err = checkName(S.name);
  if (err) { $('fErr').textContent = err; return toast('这个名字不行哦'); }
  setScreen('intro');
  await runKnot('hatch');
});

/* ================= 破壳：AI 现写第一句 → 领养 ================= */
async function streamFirstWords() {
  const r = await fetch(`${API}/first-words`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: spec() }) });
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', final = null;
  clearInterval(typing); $('line').textContent = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type === 'delta') { text += m.text; $('line').textContent = text; }
      else if (m.type === 'done') final = m;
      else if (m.type === 'error') throw new Error(m.error);
    }
  }
  if (final && !final.ai) await typeLine(final.text); // 没有模型时用模板
  return final?.text || text;
}
ACTIONS.hatch = async () => {
  const c = cur();
  setScreen('hatch');
  scene.backdrop(c.rarity);
  scene.pop(innerWidth / 2, innerHeight * 0.45, c.rarity);
  setTimeout(() => scene.pop(innerWidth / 2, innerHeight * 0.45, c.rarity), 350);
  const name = S.name || PROTOS[c.proto].defaultName;
  setSpeaker(name, ART(c.proto));
  $('who').style.background = `var(--${c.rarity})`;
  try { S.firstWords = await streamFirstWords(); }
  catch (e) { S.firstWords = `${S.call}……？`; await typeLine(S.firstWords); toast(`第一句没写出来：${e.message}`); }
  await waitTap();
  const r = await api('/adopt', { spec: spec() });
  if (!r.ok) { $('who').style.background = ''; setSpeaker(MIDWIFE, POSE('oops')); await typeLine(`哎呀，领养没成功：${r.error}`); await waitTap(); setScreen('name'); return; }
  S.fish = r.fish; S.owned.add(c.proto); S.firstEgg = false; renderDex();
  scene.clearStage();
  $('who').style.background = '';
  setScreen('intro');
  await runKnot('farewell');
  openDone();
};
/* ================= 挑一个家（F-49） ================= */
/** 诞生时先挑家；mode='change' 是设置里换房间。返回选中的房间 id（取消返回 null）。 */
function pickHome(mode = 'birth', current = 'cyberroom') {
  return new Promise((resolve) => {
    let sel = current;
    const back = document.body.dataset.screen;
    setScreen('homes');
    $('homesTitle').textContent = mode === 'birth' ? '挑一个家' : '换一间房';
    $('homesCancel').hidden = mode === 'birth';
    $('homesTip').textContent = mode === 'birth' ? '点一间看看，背景会换成那里～' : '想搬去哪里？点一间看看～';
    const draw = () => { $('homeGrid').innerHTML = HOMES.map((h) => `<div class="hcard ${h.id === sel ? 'on' : ''}" data-home="${h.id}"><div class="hpic" style="background-image:url(./assets/bg/${h.id}.webp?v=3)"></div><b>${esc(h.name)}</b><small>${esc(h.desc)}</small></div>`).join(''); };
    draw();
    scene.setBackdrop(sel);
    $('homeGrid').onclick = (e) => { const c = e.target.closest('[data-home]'); if (!c) return; sel = c.dataset.home; draw(); scene.setBackdrop(sel); };
    $('homesOk').onclick = () => { $('homeGrid').onclick = null; resolve(sel); };
    $('homesCancel').onclick = () => { $('homeGrid').onclick = null; scene.setBackdrop(current); setScreen(back); resolve(null); };
  });
}
/* ================= 她在哪儿上工（F-64）：挑一个 DSH 工作区；null = 所有工作区 ================= */
// 返回 { id, title } 或 null（所有工作区）；mode='change' 时取消返回 undefined
function pickWorkspace(mode = 'birth', currentId = undefined) {
  return new Promise(async (resolve) => {
    const back = document.body.dataset.screen;
    let r; try { r = await api('/workspaces'); } catch { r = { list: [] }; }
    const list = r.list || [];
    if (!list.length && mode === 'birth') { resolve(null); return; } // 拿不到工作区（老宿主）：所有工作区都算
    let sel = currentId !== undefined ? currentId : (list[0]?.id ?? null);
    setScreen('work');
    $('workTitle').textContent = mode === 'birth' ? '她在哪儿上工' : '换个地方上工';
    $('workCancel').hidden = mode === 'birth';
    const draw = () => { $('wsGrid').innerHTML = list.map((w) => `<div class="wscard ${w.id === sel ? 'on' : ''}" data-ws="${esc(w.id)}"><b>${esc(w.title)}</b><small>${esc(w.path)}</small></div>`).join('') + `<div class="wscard all ${sel === null ? 'on' : ''}" data-ws=""><b>所有工作区</b><small>在哪个工作区她都在（以后能换）</small></div>`; };
    draw();
    $('wsGrid').onclick = (e) => { const c = e.target.closest('[data-ws]'); if (!c) return; sel = c.dataset.ws || null; draw(); };
    $('workOk').onclick = () => { $('wsGrid').onclick = null; const w = list.find((x) => x.id === sel); resolve(w ? { id: w.id, title: w.title } : null); };
    $('workCancel').onclick = () => { $('wsGrid').onclick = null; setScreen(back); resolve(undefined); };
  });
}
ACTIONS.workspace = async () => { const w = await pickWorkspace('birth'); S.workspaceId = w?.id || null; S.workspaceTitle = w?.title || null; setScreen('intro'); };
ACTIONS.home = async () => { S.home = await pickHome('birth', S.home || 'cyberroom'); setScreen('intro'); scene.setBackdrop(pondScene()); };

/* ================= 开局设置（F-38）：B站扫码 + 生图 API，都能以后再说 ================= */
// 扫码好了：问一次要不要关注接生员的 B站号（F-61）。只有点「关注」才关注；「先不用」不再追问。返回 Promise（答完才往下走）
async function askFollowOfficial() {
  let v; try { v = await api('/bili/official'); } catch { return; }
  if (!v?.available || !v.loggedIn || v.following || v.declined) return;
  const box = $('followAsk');
  box.querySelector('p').textContent = `她有自己的 B站号啦！要不要让她关注一下接生员「${v.name}」的号？以后有新鱼、新玩法，她刷 B站会第一个看到。`;
  box.hidden = false;
  await new Promise((done) => {
    $('followYes').onclick = async () => { $('followYes').disabled = true; const r = await api('/bili/official', { follow: true }).catch((e) => ({ ok: false, error: e.message })); toast(r.ok ? `关注好了，她会常去看「${v.name}」` : `没关注上：${r.error || ''}`); $('followYes').disabled = false; done(); };
    $('followNo').onclick = async () => { await api('/bili/official', { decline: true }).catch(() => {}); done(); };
  });
  box.hidden = true;
}
let qrTimer = null;
async function startQr(box, state, onDone) {
  clearInterval(qrTimer);
  box.classList.remove('done'); box.innerHTML = '<div class="qrph">二维码生成中…</div>'; state.textContent = '等你扫码…';
  let r; try { r = await api('/bili/qr', {}); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r.ok) { box.innerHTML = '<div class="qrph">没连上 B站</div>'; state.innerHTML = `${esc(r.error || '生成失败')} <a href="#" data-retry>重试</a>`; return; }
  box.innerHTML = r.svg;
  qrTimer = setInterval(async () => {
    let p; try { p = await api(`/bili/qr?id=${encodeURIComponent(r.id)}`); } catch { return; }
    if (p.state === 'scanned') state.textContent = '扫到了！在手机上点「确认登录」…';
    else if (p.state === 'expired') { clearInterval(qrTimer); state.innerHTML = `二维码过期了 <a href="#" data-retry>换一张</a>`; }
    else if (p.state === 'done') { clearInterval(qrTimer); box.classList.add('done'); state.textContent = `登录好了：${p.uname || '她的新号'}`; onDone?.(p); }
  }, 2000);
}
ACTIONS.setup = () => new Promise((resolve) => {
  let step = 'bili';
  const back = document.body.dataset.screen; // 剧本还要接着说话：关掉设置后回到对话那一屏（不然下一句在看不见的对话框里等点击，卡住）
  setScreen('setup');
  const show = () => {
    document.querySelectorAll('.s-setup .step').forEach((s) => s.classList.toggle('on', s.dataset.step === step));
    $('setBili').hidden = step !== 'bili'; $('setImg').hidden = step !== 'img';
    $('setupNext').textContent = step === 'bili' ? '下一步' : '保存，完成';
    $('setupTip').textContent = step === 'bili' ? '用给她的新号扫哦，别用你自己的～' : '不知道填什么就点「以后再说」，不影响养她～';
  };
  const finish = () => { clearInterval(qrTimer); setScreen(back || 'intro'); resolve(); };
  const next = async () => {
    if (step === 'bili') { clearInterval(qrTimer); step = 'img'; show(); return; }
    const base = $('setImgBase').value.trim(), model = $('setImgModel').value.trim(), key = $('setImgKey').value.trim();
    if (base || key) {
      const r = await api('/image-api', { baseUrl: base, model, apiKey: key });
      if (!r.ok) { toast(r.error || '没保存上'); return; }
      $('setImgKey').value = ''; toast(r.hasKey ? `生图 API 存好了（key ${r.keyTail}）` : '地址存好了，key 还没填');
    }
    finish();
  };
  $('setupNext').onclick = next;
  $('setupSkip').onclick = () => (step === 'bili' ? (clearInterval(qrTimer), step = 'img', show()) : finish());
  $('qrState').onclick = (e) => { if (e.target.closest('[data-retry]')) { e.preventDefault(); startQr($('qrBox'), $('qrState'), onBili); } };
  const onBili = async (p) => { document.querySelector('.s-setup .step[data-step="bili"]').classList.add('ok'); await askFollowOfficial(); setTimeout(() => { if (step === 'bili') { step = 'img'; show(); } }, 900); };
  show();
  api('/bili').then((b) => {
    if (b.loggedIn) { $('qrBox').classList.add('done'); $('qrBox').innerHTML = ''; $('qrState').textContent = `已经登录：${b.uname}（要换号去设置）`; document.querySelector('.s-setup .step[data-step="bili"]').classList.add('ok'); askFollowOfficial(); }
    else startQr($('qrBox'), $('qrState'), onBili);
  }).catch(() => startQr($('qrBox'), $('qrState'), onBili));
});

// 设置里的 B站号：随时补扫 / 换号
async function loadBiliCfg() {
  let b; try { b = await api('/bili'); } catch { return; }
  $('cfgBiliSub').textContent = b.loggedIn ? `已登录：${b.uname}（UID ${b.mid}${b.level != null ? `，Lv${b.level}` : ''}）` : b.expired ? '登录过期了，重新扫一下' : '还没登录。她出门会刷 B站，以后还要在评论区冒泡';
  $('cfgBiliLogin').textContent = b.loggedIn ? '换号' : '扫码登录';
  $('cfgBiliOut').hidden = !b.loggedIn;
  $('cfgFollow').hidden = true;
  if (b.loggedIn) api('/bili/official').then((v) => { if (v?.available && !v.following) { $('cfgFollow').hidden = false; $('cfgFollow').textContent = `关注「${v.name}」`; } }).catch(() => {});
}
// 报告问题（F-65）：没登录先去扫码；没关注先关注；写好用她的号私信接生员
async function openReport() {
  let v; try { v = await api('/bili/official'); } catch { v = null; }
  if (!v?.available) { toast('还没设置接生员的 B站号'); return; }
  if (!v.loggedIn) { toast('先在设置里给她扫码登录 B站，才能用她的号发私信'); return; }
  $('reportFollow').hidden = Boolean(v.following);
  $('reportText').disabled = !v.following; $('reportSend').disabled = !v.following;
  $('reportLeft').textContent = '';
  $('cfg').classList.remove('on'); $('reportM').classList.add('on');
  if (v.following) $('reportText').focus();
}
$('cfgReport').addEventListener('click', openReport);
$('reportX').addEventListener('click', () => { $('reportM').classList.remove('on'); $('cfg').classList.add('on'); });
$('reportFollowYes').addEventListener('click', async () => {
  $('reportFollowYes').disabled = true; $('reportFollowYes').textContent = '关注中…';
  const r = await api('/bili/official', { follow: true }).catch((e) => ({ ok: false, error: e.message }));
  $('reportFollowYes').disabled = false; $('reportFollowYes').textContent = '关注';
  if (!r.ok) { toast(`没关注上：${r.error || ''}`); return; }
  toast('关注好了，现在可以写了');
  $('reportFollow').hidden = true; $('reportText').disabled = false; $('reportSend').disabled = false; $('reportText').focus();
});
$('reportSend').addEventListener('click', async () => {
  const text = $('reportText').value.trim();
  $('reportSend').disabled = true; $('reportSend').textContent = '发送中…';
  $('reportLeft').textContent = 'B站限速，可能要等几十秒～';
  const r = await api('/bili/official', { report: text }).catch((e) => ({ ok: false, error: e.message }));
  $('reportSend').disabled = false; $('reportSend').textContent = '发送'; $('reportLeft').textContent = '';
  if (r.needFollow) { $('reportFollow').hidden = false; $('reportText').disabled = true; $('reportSend').disabled = true; toast(r.error); return; }
  if (!r.ok) { toast(r.error || '没发出去'); return; }
  $('reportText').value = ''; $('reportLeft').textContent = `发出去了！今天还能发 ${r.left} 条`;
  toast('发出去了，谢谢你！鱼见未来本鱼会去看的');
});
$('cfgFollow').addEventListener('click', async () => { $('cfgFollow').disabled = true; const r = await api('/bili/official', { follow: true }).catch((e) => ({ ok: false, error: e.message })); $('cfgFollow').disabled = false; toast(r.ok ? '关注好了' : `没关注上：${r.error || ''}`); loadBiliCfg(); });
$('cfgBtn').addEventListener('click', loadBiliCfg);
// 设置：她在哪儿上工（F-64）
async function loadWorkCfg() {
  let r; try { r = await api('/workspaces'); } catch { return; }
  $('cfgWsSub').textContent = r.current ? `「${r.current.title}」：这里的对话都是她在帮你，别的工作区里她不出现` : '所有工作区：在哪儿跟 DSH 说话都是她';
  $('cfgWsSub').title = r.current?.path || '';
  $('cfgWs').dataset.cur = r.current?.id || '';
}
$('cfgBtn').addEventListener('click', loadWorkCfg);
$('cfgWs').addEventListener('click', async () => {
  $('cfg').classList.remove('on');
  const back = document.body.dataset.screen;
  const w = await pickWorkspace('change', $('cfgWs').dataset.cur || null);
  if (w !== undefined) { const r = await api('/workspaces', { workspaceId: w ? w.id : null }); toast(r.ok ? (w ? `好，她以后在「${w.title}」上工` : '好，她在所有工作区都上工') : `没换成：${r.error || ''}`); }
  await refreshPond(); setScreen(back); if (back === 'home') refreshLife();
  $('cfg').classList.add('on'); loadWorkCfg();
});
$('cfgBiliLogin').addEventListener('click', async () => {
  $('cfg').classList.remove('on');
  const back = document.body.dataset.screen;
  await ACTIONS.setupBiliOnly();
  setScreen(back); if (back === 'home') refreshLife();
});
ACTIONS.setupBiliOnly = () => new Promise((resolve) => {
  setScreen('setup');
  document.querySelectorAll('.s-setup .step').forEach((s) => s.classList.toggle('on', s.dataset.step === 'bili'));
  $('setBili').hidden = false; $('setImg').hidden = true;
  $('setupTip').textContent = '用给她的号扫哦～';
  $('setupNext').textContent = '完成'; $('setupNext').onclick = () => { clearInterval(qrTimer); resolve(); };
  $('setupSkip').onclick = () => { clearInterval(qrTimer); resolve(); };
  $('qrState').onclick = (e) => { if (e.target.closest('[data-retry]')) { e.preventDefault(); startQr($('qrBox'), $('qrState'), done); } };
  const done = async () => { await askFollowOfficial(); setTimeout(() => { clearInterval(qrTimer); resolve(); }, 900); };
  startQr($('qrBox'), $('qrState'), done);
});
$('cfgBiliOut').addEventListener('click', async () => {
  if (!confirm('退出她的 B站号？（本机凭证会删掉；B站那边的登录设备请在 App 里下线）')) return;
  await api('/bili/logout', {}); loadBiliCfg(); toast('已退出');
});

function openDone() {
  const c = cur(), name = S.fish?.name || S.name;
  $('doneCard').innerHTML = cardHTML(c, name);
  $('doneTitle').textContent = `${name} 到家啦！`;
  $('doneLine').textContent = `「${S.firstWords}」`;
  $('doneHint').innerHTML = `她已经开始上工：在 DSH 里发下一条消息，就是 <b>${esc(name)}</b> 在回答，她会叫你「${esc(S.call)}」。<br>想让她歇着，去右上角的「设置」。`;
  setScreen('done');
  const b = $('doneCard').getBoundingClientRect();
  setTimeout(() => scene.pop(b.left + b.width / 2, b.top + b.height * 0.4, c.rarity), 150);
}
$('goWork').addEventListener('click', () => { if (MODE === 'panel') showHome(); else closeGame(); });
$('closeBtn').addEventListener('click', closeGame);
async function adoptAgain() { $('cfg').classList.remove('on'); await toPondScene(); story.variablesState.returning = true; S.firstEgg = false; $('guarantee').textContent = '再领养不保底，看缘分～'; $('who').style.background = ''; setSpeaker(MIDWIFE, POSE('wave')); setScreen('intro'); await runKnot('intro'); }
$('again').addEventListener('click', adoptAgain);

/* ================= 房间（有鱼时的首页） ================= */
let POND = { current: null, fish: [] };
const homeFish = () => POND.current || POND.fish[POND.fish.length - 1] || null;
async function refreshPond() { try { POND = await api('/pond'); } catch { /* 宿主没响应 */ } return POND; }
function fishCard(f) { return cardHTML({ proto: f.proto, rarity: f.rarity, attrs: roll(f.seed, f.proto, f.cast ?? 0, f.rarity === 'SR' && (f.cast ?? 0) === 0 ? 'SR' : null).attrs }, f.name); }
async function showHome() {
  await refreshPond();
  const f = homeFish();
  if (!f) { setScreen('intro'); return runKnot('intro'); }
  scene.clearStage();
  await scene.setBackdrop(f.home || 'cyberroom');
  const working = POND.current?.id === f.id;
  $('rName').textContent = f.name;
  $('rSub').textContent = `${f.rarity} · ${f.personality || ''} · ${working ? '在 DSH 上工' : '歇着'}`;
  $('fishBig').src = ART(f.proto); $('fishBig').style.visibility = 'visible';
  setScreen('home');
  await refreshLife();
  renderTab();
  startLifePoll();
  await loadTips(true);
  if (LIFE?.activity === 'out' || LIFE?.activity === 'sleep') return; // 出门 / 睡觉不打招呼
  bubbleSay(f.firstWords ? (f.firstWords.includes(f.parentCall) ? f.firstWords : `${f.parentCall}！${f.firstWords}`) : `${f.parentCall}，你来看我啦！`);
}
$('greetBtn').addEventListener('click', async () => {
  const f = homeFish(); if (!f) return;
  $('greetBtn').disabled = true;
  try {
    const r = await fetch(`${API}/greet`, { method: 'POST' });
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '';
    clearInterval(typing); $('line').textContent = '…';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.type === 'delta') { text += m.text; $('line').textContent = text; }
        else if (m.type === 'done' && !m.ai) await typeLine(m.text);
        else if (m.type === 'error') await typeLine(m.error);
      }
    }
  } catch (e) { toast(`她没听见：${e.message}`); }
  $('greetBtn').disabled = false;
});
$('newFishBtn').addEventListener('click', adoptAgain);

/* ================= M3 回家：她的日常 ================= */
let LIFE = null;
async function refreshLife() {
  try { LIFE = await api('/life'); } catch { return; }
  if (!LIFE?.fish) return;
  const L = LIFE;
  $('lifeBar').innerHTML = `<span>${ICON(ACT_ICON[L.activity] || 'house')} ${esc(L.activityText || L.whereText)}</span>`
    + `<span>${ICON(L.moodIcon || 'mood3')} ${esc(L.moodWord || '心情')} <i class="meter"><i style="width:${L.mood}%"></i></i></span>`
    + `<span>${ICON('bolt')} 精力 <i class="meter en"><i style="width:${L.energy}%"></i></i></span>`
    + (L.workToday ? `<span>${ICON('work')} 今天帮${esc(L.fish.parentCall)}干了 ${L.workToday} 次活</span>` : '');
  renderPresence(L);
  renderWalletChip(L.wallet);
  renderMailDot((L.unreadLetters || 0) + (L.pendingDrafts || 0) + (L.inboxUnseen || 0));
  checkTip();
}

/* ================= 小贴士（F-42） ================= */
let TIPSTATE = null, BILI_OK = null, tipShowing = null;
async function loadTips(visit = false) {
  try { if (visit) await api('/tips', { visit: true }); TIPSTATE = await api('/tips'); } catch { TIPSTATE = null; }
  if (BILI_OK === null) { try { BILI_OK = Boolean((await api('/bili')).loggedIn); } catch { BILI_OK = true; } }
  checkTip();
}
function checkTip() {
  if (!TIPSTATE || !LIFE?.fish || tipShowing || document.body.dataset.screen !== 'home') return;
  const ctx = { visits: TIPSTATE.visits, chats: TIPSTATE.chats, activity: LIFE.activity, mood: LIFE.mood, energy: LIFE.energy, wallet: LIFE.wallet, hasLetter: (LIFE.unreadLetters || 0) > 0, biliLoggedIn: BILI_OK, growthLog: LIFE.growth?.log?.length || 0, bagCount: LIFE.bagCount || 0, pendingDrafts: LIFE.pendingDrafts || 0 };
  const tip = nextTip(ctx, TIPSTATE.seen);
  if (!tip) return;
  tipShowing = tip.id;
  $('tipPose').src = POSE(tip.pose || 'point');
  $('tipText').textContent = tip.text;
  $('tipCard').hidden = false;
}
$('tipOk').addEventListener('click', async () => {
  const id = tipShowing; $('tipCard').hidden = true; tipShowing = null;
  if (!id) return;
  TIPSTATE.seen = [...(TIPSTATE.seen || []), id];
  try { await api('/tips', { seen: id }); } catch { /* 下次还会出 */ }
  setTimeout(checkTip, 1200); // 一条一条来，别一次糊一脸
});
async function openTipsBook() {
  const s = await api('/tips');
  const seen = new Set(s.seen || []);
  $('tipsBody').innerHTML = `<h4>${ICON('sparkle')} 小贴士</h4>${s.tips.filter((t) => seen.has(t.id)).map((t) => `<div class="tp"><img src="${POSE(t.pose || 'point')}" alt=""><span>${esc(t.text)}</span></div>`).join('')}${s.tips.length > seen.size ? `<div class="tp unseen"><img src="${POSE('look')}" alt=""><span>还有 ${s.tips.length - seen.size} 条小贴士没遇到，到时候本鱼再告诉你～</span></div>` : ''}
    <h4>${ICON('book')} 说明书</h4><dl>${s.kb.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  $('tipsM').classList.add('on');
}
$('tipAll').addEventListener('click', openTipsBook);
$('cfgTips').addEventListener('click', () => { $('cfg').classList.remove('on'); openTipsBook(); });
$('cfgTipsReset').addEventListener('click', async () => { await api('/tips', { reset: true }); toast('小贴士会重新出现'); $('cfg').classList.remove('on'); await loadTips(); });
$('tipsX').addEventListener('click', () => $('tipsM').classList.remove('on'));
let prevUnread = null;
function renderMailDot(n) {
  $('mailDot').hidden = !n; $('mailDot').textContent = n;
  if (prevUnread !== null && n > prevUnread) toast('信箱里有新东西：信、B站上有人理她，或者她想在 B站说的话');
  prevUnread = n;
}

/** 三态 + 正在干的事 → 画面：睡觉换抱枕闭眼立绘 + Zzz；出门人没了，挂「暂停营业」牌和字条；其余按动作库回落站姿。 */
let lastActivity = null, prevSent = null, prevPc = null;
function renderPresence(L) {
  const f = homeFish(); if (!f) return;
  const act = L.activity || (L.where === 'sleep' ? 'sleep' : 'home');
  const have = posesOf(f.proto);
  const pose = act === 'home' && REACTION.pose && Date.now() < REACTION.until && have.has(REACTION.pose) ? REACTION.pose : poseFor(act, have, { mood: L.mood, energy: L.energy, idle: IDLE.pose });
  const im = $('fishBig');
  $('away').hidden = act !== 'out';
  $('zzz').hidden = act !== 'sleep';
  im.classList.toggle('sleeping', act === 'sleep');
  im.classList.toggle('bob', act !== 'sleep');
  if (pose === null) { im.style.visibility = 'hidden'; $('bubble').classList.remove('on'); }
  else { const src = POSE_ART(f.proto, pose); if (!im.src.endsWith(src.slice(1))) { im.onerror = () => { im.onerror = null; im.src = ART(f.proto); }; im.src = src; im.classList.remove('swap'); void im.offsetWidth; im.classList.add('swap'); setTimeout(() => im.classList.remove('swap'), 400); } im.style.visibility = 'visible'; }
  if (act === 'out') {
    const tr = L.trip;
    const back = tr?.state === 'planned' && tr.returnAt ? `　大概 ${new Date(tr.returnAt).toTimeString().slice(0, 5)} 回来` : '';
    $('awayNote').textContent = `${tr?.note || `${L.fish.parentCall}，我出去逛逛，看到有意思的贴进笔记本～`}${tr?.total || tr?.pcSent ? `\n（${[tr.total ? `往笔记本贴了 ${tr.sent} 张${tr.sent < tr.total ? '，剩下的回家一起贴' : ''}` : '', tr.pcSent ? `寄回 ${tr.pcSent} 张明信片` : ''].filter(Boolean).join('、')}${back}）` : back ? `\n（${back.trim()}）` : ''}`;
  }
  // 明信片寄到了：提醒一下
  if (L.trip && prevSent !== null && L.trip.sent > prevSent) toast('她往笔记本上贴了一张新的便利贴（右上角「笔记本」）');
  if (L.trip && prevPc !== null && (L.trip.pcSent || 0) > prevPc) toast('她从外面寄回一张明信片（右上角「明信片」）');
  prevSent = L.trip ? L.trip.sent : null;
  prevPc = L.trip ? (L.trip.pcSent || 0) : null;
  $('rSub').textContent = `${f.rarity} · ${f.personality || ''} · ${L.activityText || L.whereText}`;
  document.querySelectorAll('.quick .qa').forEach((b) => { if (b.dataset.act !== 'work') b.disabled = act === 'out'; });
  $('sayIn').placeholder = act === 'out' ? '她出门了，回来再聊～' : act === 'sleep' ? '她在睡觉……小声点说（会把她叫醒）' : '跟她说点什么…（回车发送）';
  if (lastActivity === 'out' && act !== 'out') { bounce(); bubbleSay(`${L.fish.parentCall}，我回来啦！笔记本里夹好「这一趟」了～`); }
  lastActivity = act;
}
// 零花钱：余额 + 今天花了多少；每次花钱从钱包飘出一个「−N」（F-36）
let prevSpent = null;
function renderWalletChip(w) {
  if (!w) return;
  $('walletText').innerHTML = `${w.unlimited ? '不限' : esc(tokensText(w.left))}<small>今天 −${esc(tokensText(w.spentToday))}</small>`;
  $('walletChip').classList.toggle('broke', w.broke);
  $('walletChip').classList.toggle('low', w.level === 'low');
  if (prevSpent !== null && w.spentToday > prevSpent) {
    const d = document.createElement('span'); d.className = 'spend'; d.textContent = `−${tokensText(w.spentToday - prevSpent)}`;
    $('walletChip').appendChild(d); setTimeout(() => d.remove(), 1600);
  }
  prevSpent = w.spentToday;
}
async function refreshWallet() { try { renderWalletChip(await api('/allowance')); } catch { /* 下次再说 */ } }
let lifePoll = null;
function startLifePoll() {
  clearInterval(lifePoll);
  // 后台有事在跑（她在 DSH 干活、出门、睡着醒来）画面要跟着变，所以房间开着时每 15 秒看一眼
  lifePoll = setInterval(() => { if (!document.hidden && document.body.dataset.screen === 'home') refreshLife(); }, 15_000);
}
async function refreshClock() {
  try { const s = await api('/status'); $('clockChip').hidden = !s.clock?.skewed; if (s.clock?.skewed) $('clockText').textContent = new Date(s.clock.now).toTimeString().slice(0, 5); } catch { /* 没有就算了 */ }
}
refreshClock();
async function streamTo(path, body, onText, onStatus = null) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', final = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.type === 'delta') { text += m.text; onText(text); }
      else if (m.type === 'tool') onStatus?.(m.text || '');
      else if (m.type === 'done') final = m;
      else if (m.type === 'error') throw new Error(m.error);
    }
  }
  return final || { text };
}

// 喂零食
$('feedBtn').addEventListener('click', async () => {
  const f = homeFish(); if (!f) return;
  const r = await api('/feed', {});
  if (!r.ok) return toast(r.error || '没喂上');
  const b = $('homeCard').getBoundingClientRect();
  scene.pop(b.left + b.width / 2, b.top + b.height * 0.35, f.rarity);
  setSpeaker(f.name, ART(f.proto)); typeLine(r.line);
  refreshLife();
});

// 聊天
function renderMsgs(chat) {
  const f = homeFish();
  $('msgs').innerHTML = chat.length ? chat.map((c) => c.role === 'user'
    ? `<div class="msg me"><div class="t">${esc(c.text)}</div></div>`
    : `<div class="msg fish"><img src="${ART(f.proto)}" alt=""><div class="t">${esc(c.text)}</div></div>`).join('')
    : `<div class="empty">跟 ${esc(f.name)} 说点什么吧，她会用她自己的方式回你～</div>`;
  $('msgs').scrollTop = $('msgs').scrollHeight;
}
$('chatBtn').addEventListener('click', async () => {
  const f = homeFish(); if (!f) return;
  await refreshLife();
  $('chatTitle').textContent = `和 ${f.name} 聊天`;
  renderMsgs(LIFE?.chat || []);
  $('chatM').classList.add('on'); $('chatIn').focus();
});
$('chatX').addEventListener('click', () => { $('chatM').classList.remove('on'); refreshLife(); });
async function sendChat() {
  const text = $('chatIn').value.trim(); if (!text) return;
  const f = homeFish();
  $('chatIn').value = ''; $('chatSend').disabled = true;
  const chat = [...(LIFE?.chat || []), { role: 'user', text }];
  renderMsgs([...chat, { role: 'fish', text: '…' }]);
  try {
    let said = false;
    const r = await streamTo('/chat', { text }, (t) => { said = true; renderMsgs([...chat, { role: 'fish', text: t }]); }, (s) => { if (!said) renderMsgs([...chat, { role: 'fish', text: `（${s}）` }]); });
    LIFE = { ...LIFE, chat: [...chat, { role: 'fish', text: r.text }] };
    renderMsgs(LIFE.chat);
    setSpeaker(f.name, ART(f.proto)); $('line').textContent = r.text;
  } catch (e) { toast(e.message); renderMsgs(chat); }
  $('chatSend').disabled = false; $('chatIn').focus();
}
$('chatSend').addEventListener('click', sendChat);
$('chatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) sendChat(); });

// 日记
function renderDiary(list) {
  $('diaryList').innerHTML = list?.length ? list.map((d) => `<div class="dentry"><b>${esc(d.day)}</b><p>${esc(d.text)}</p></div>`).join('')
    : '<div class="empty">还没有日记。她每天睡前会写一篇；也可以现在就让她写。</div>';
}
$('diaryBtn').addEventListener('click', async () => {
  const f = homeFish(); if (!f) return;
  await refreshLife();
  $('diaryTitle').textContent = `${f.name} 的日记`;
  renderDiary(LIFE?.diary || []);
  $('diaryM').classList.add('on');
});
$('diaryX').addEventListener('click', () => $('diaryM').classList.remove('on'));
$('diaryWrite').addEventListener('click', async () => {
  $('diaryWrite').disabled = true; $('diaryWrite').textContent = '她在写……';
  const r = await api('/diary', {});
  $('diaryWrite').disabled = false; $('diaryWrite').textContent = '让她写今天的日记';
  if (!r.ok) return toast(r.error);
  renderDiary(r.diary);
});

/* ================= 设置（右上角齿轮） ================= */
async function openCfg() {
  await refreshPond();
  const cur = POND.current, last = homeFish();
  $('cfgWorkTitle').textContent = cur ? `${cur.name} 正在上工` : '现在没有鱼在上工';
  $('cfgWorkSub').textContent = cur ? `${cur.workspace ? `在「${cur.workspace.title}」里` : '在所有工作区'}跟 DSH 说话就是她在回答，叫你「${cur.parentCall}」` : 'DSH 里不会出现鱼社的人设';
  $('cfgWork').textContent = cur ? '让她歇着' : (last ? `叫 ${last.name} 回来上工` : '先去领养一条');
  $('cfgWork').dataset.act = cur ? 'rest' : (last ? 'work' : 'adopt');
  const pref = pondPref();
  $('cfgScene').innerHTML = [['auto', '自动（随时间）'], ...['lagoon', 'sakura', 'aquarium'].map((k) => [k, BACKDROPS[k].name])].map(([k, n]) => `<button class="chip ${pref === k ? 'on' : ''}" data-scene="${k}">${n}</button>`).join('');
  $('cfgHomeSub').textContent = last ? `现在住在「${homeOf(last.home || 'cyberroom').name}」` : '领养之后才有家';
  $('cfgPond').innerHTML = POND.fish.slice().reverse().map((f) => `<div class="cfgrow fishrow ${cur?.id === f.id ? 'cur' : ''}"><img src="${ART(f.proto)}" alt=""><div style="flex:1"><b>${esc(f.name)}</b><small>${f.rarity} · ${esc(f.personality || '')} · 叫你「${esc(f.parentCall)}」 · ${esc((f.createdAt || '').slice(0, 10))}</small></div>${cur?.id === f.id ? '<span class="tier" style="background:var(--green)">上工中</span>' : `<button class="gb plain sm" data-work="${f.id}">换她上工</button>`}</div>`).join('') || '<div class="cfgnote">鱼塘还是空的。</div>';
  $('cfg').classList.add('on');
}
$('cfgBtn').addEventListener('click', openCfg);
$('cfgHome').addEventListener('click', async () => {
  const f = homeFish(); if (!f) return;
  $('cfg').classList.remove('on');
  const h = await pickHome('change', f.home || 'cyberroom');
  if (!h) return;
  const r = await api('/home', { home: h });
  if (!r.ok) return toast(r.error || '没搬成');
  toast(`搬进了${homeOf(h).name}`);
  showHome();
});
$('cfgX').addEventListener('click', () => $('cfg').classList.remove('on'));
$('cfg').addEventListener('click', (e) => { if (e.target.id === 'cfg') $('cfg').classList.remove('on'); });
$('cfgAdopt').addEventListener('click', adoptAgain);
$('cfgScene').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-scene]'); if (!b) return;
  try { localStorage.setItem(SCENE_KEY, b.dataset.scene); } catch { /* 存不了就只这次生效 */ }
  if (document.body.dataset.screen !== 'home') await toPondScene();
  openCfg();
  toast(b.dataset.scene === 'auto' ? '鱼塘会跟着时间换景' : `鱼塘换成「${BACKDROPS[b.dataset.scene].name}」`);
});
$('cfgWork').addEventListener('click', async () => {
  const act = $('cfgWork').dataset.act;
  if (act === 'adopt') return adoptAgain();
  const r = await api('/current', { id: act === 'rest' ? null : homeFish()?.id });
  if (!r.ok) return toast(r.error || '没切换成功');
  toast(act === 'rest' ? '她去歇着啦' : '她回来上工啦');
  await openCfg(); if (document.body.dataset.screen === 'home') showHome();
});
$('cfgPond').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-work]'); if (!b) return;
  const r = await api('/current', { id: b.dataset.work });
  if (!r.ok) return toast(r.error || '没切换成功');
  toast(`${r.current?.name} 来上工啦`);
  await openCfg(); showHome();
});

/* ================= 图鉴 ================= */
function renderDex() {
  $('dexGrid').innerHTML = PROTO_IDS.map((id) => `<div class="${S.owned.has(id) ? 'own' : ''}"><img src="${ART(id)}" alt=""><span>${S.owned.has(id) ? esc(PROTOS[id].short) : '？？？'}</span></div>`).join('');
}
$('dexBtn').addEventListener('click', () => { renderDex(); $('dex').classList.add('on'); });
$('dexX').addEventListener('click', () => $('dex').classList.remove('on'));
$('dex').addEventListener('click', (e) => { if (e.target.id === 'dex') $('dex').classList.remove('on'); });

/* ================= 房间 v2：气泡 / 输入 / 快捷动作 / 右侧面板 / 手机 / 生图设置 ================= */
let bubbleTimer = null;
function bubbleSay(text, { think = false, stay = false } = {}) {
  const b = $('bubble'); b.classList.toggle('think', think); b.classList.add('on');
  clearInterval(typing); clearTimeout(bubbleTimer);
  const el = $('bubbleText');
  if (reduced()) el.textContent = text;
  else { let i = 0; el.textContent = ''; typing = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(typing); }, 30); }
  if (!stay) bubbleTimer = setTimeout(() => b.classList.remove('on'), Math.max(6000, text.length * 220));
}
function bubbleLive(text, think = false) { clearInterval(typing); clearTimeout(bubbleTimer); const b = $('bubble'); b.classList.toggle('think', think); b.classList.add('on'); $('bubbleText').textContent = text; }
/** 她被你的话打动 / 伤到时，头顶冒一下（不显示规则，只显示感受）。 */
function moodFx(d) {
  const el = document.createElement('div'); el.className = 'moodfx';
  el.innerHTML = d > 0 ? ICON('heart') + (d >= 6 ? ICON('heart') : '') : ICON('drop');
  $('fishBig').parentElement.appendChild(el); setTimeout(() => el.remove(), 1900);
  if (d > 0) bounce();
}
function bounce() { const im = $('fishBig'); im.classList.remove('boing'); void im.offsetWidth; im.classList.add('boing'); }
/** 等回复时：气泡里三个跳动的点 + 她轻轻歪头晃一晃；第一段字到了就停。 */
function bubbleThinking(on) {
  const im = $('fishBig');
  if (!on) { im.classList.remove('ponder'); return; }
  clearInterval(typing); clearTimeout(bubbleTimer);
  const b = $('bubble'); b.classList.add('on', 'think');
  $('bubbleText').innerHTML = '<span class="dots" aria-label="她在想"><i></i><i></i><i></i></span>';
  im.classList.add('ponder');
}
async function roomStream(path, body, think = false) {
  bubbleThinking(true);
  let first = true;
  try {
    const r = await streamTo(path, body, (t) => { if (first) { first = false; bubbleThinking(false); } bubbleLive(t, think); }, (s) => { if (first) { bubbleThinking(false); bubbleLive(`（${s}）`, true); } }); // F-86：她在调工具时显示在干嘛，开口后就不再盖住她的话
    bubbleThinking(false);
    refreshWallet();
    if (r.ai === false && r.text) bubbleSay(r.text); else bubbleTimer = setTimeout(() => $('bubble').classList.remove('on'), Math.max(8000, (r.text || '').length * 220));
    return r;
  } catch (e) { bubbleThinking(false); bubbleSay(e.message); return null; }
}
async function sayToFish() {
  const text = $('sayIn').value.trim(); if (!text) return;
  if (LIFE?.activity === 'out') { toast('她出门了，回来再聊～'); return; }
  $('sayIn').value = ''; $('saySend').disabled = true;
  const r = await roomStream('/chat', { text });
  if (r?.moodDelta) moodFx(r.moodDelta);
  $('saySend').disabled = false; $('sayIn').focus();
  await refreshLife(); renderTab();
}
$('saySend').addEventListener('click', sayToFish);
$('sayIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) sayToFish(); });

let surfPoll = null;
document.querySelector('.quick').addEventListener('click', async (e) => {
  const b = e.target.closest('.qa'); if (!b) return;
  const f = homeFish(); if (!f) return;
  const act = b.dataset.act;
  if (act === 'work') { window.parent?.postMessage({ type: 'dsh-yushe:work', name: f.name, workspaceId: f.workspace?.id || null }, location.origin); bubbleSay(f.workspace ? `好！${f.parentCall}，我们去「${f.workspace.title}」里干活～` : `好！${f.parentCall}，我们去 DSH 里干活～`); return; }
  b.disabled = true;
  try {
    if (act === 'news') await roomStream('/news', {});
    else if (act === 'greet') await roomStream('/greet', {}, true);
    else if (act === 'nap') {
      const r = await api('/nap', {});
      bubbleSay(r.line || r.error || '……');
    } else if (act === 'feed' || act === 'pat') {
      const r = await api(`/${act}`, {});
      if (!r.ok) bubbleSay(r.error || '……'); else { react(act === 'feed' ? 'eat' : 'shy'); bubbleSay(r.line); bounce(); const bb = $('fishBig').getBoundingClientRect(); scene.pop(bb.left + bb.width / 2, bb.top + bb.height * 0.3, f.rarity); }
    } else if (act === 'surf') {
      // 问她想不想出门：她可以拒绝（放养）。答应了就出门，画面由 refreshLife 按「出门」状态切换
      const r = await api('/surf', {});
      if (!r.ok) { bubbleSay(r.line || r.error || '……'); if (r.reason === 'sulky') bounce(); return; }
      // 这一趟要 1–3 小时；明信片会按时间一张张寄回来，房间每 15 秒同步一次
      bubbleSay(r.line, { stay: true }); bounce();
      setTimeout(() => refreshLife(), 1800);
      return;
    }
    await refreshLife(); renderTab();
  } finally { b.disabled = LIFE?.activity === 'out'; }
});

/** 「她」面板（F-24）：她现在、性格、近 7 天心情、五维（现在 vs 出生）、爱好（带升降和原因）、记住的 UP 主、成长日志。 */
function herPanel(g, fish) {
  if (!g) return '<div class="empty">她还小，成长记录还没开始。</div>';
  // 「她现在」（心情-一期-3 D）：数据在 /life 展开的 snapshot 里（LIFE.feel.emotions：程度词 + 情绪名 + 因为什么，不给数字 / 机制词）。
  // 最多 3 个小标签，原因一行小字（esc 转义——cause 是宿主写的事件文字，照原样显示；她的标签不换行，窄屏整个标签排下去）。
  const feels = LIFE?.feel?.emotions || [];
  const cur = feels.length
    ? feels.map((e) => `<span class="nowfeel"><b>${esc(e.word || ((e.level || '') + (e.name || '情绪')))}</b>${e.cause ? `<small>${esc(e.cause)}</small>` : ''}</span>`).join('')
    : '<div class="empty">心情平稳</div>';
  const mood = g.moodDays.length ? `<div class="mood7wrap"><div class="mood7">${g.moodDays.map((m) => `<i style="height:${Math.max(6, m.mood)}%" title="${esc(m.day)} 心情 ${m.mood}"><span>${esc(m.day.slice(5))}</span></i>`).join('')}</div></div>` : '<div class="empty">还没攒够心情记录</div>';
  const capSingle = g.caps?.single ?? 100, capTotal = g.caps?.total ?? 200;
  const stats = g.stats.map((s) => `<div class="st2"><span>${esc(s.label)}</span><div class="bar3"><b style="width:${s.nowPct ?? s.now}%"></b><em style="left:${s.bornPct ?? s.born}%" title="出生时 ${s.born}"></em></div><span title="现在 ${s.now}，单维上限 ${capSingle}">${s.now}${s.now !== s.born ? (s.now > s.born ? UP_SVG : DN_SVG) : ''}</span></div>`).join('');
  const ints = g.interests.length ? g.interests.map((x) => `<div class="int"><span>${esc(x.tag)}</span><div class="bar3"><b style="width:${x.heat}%"></b></div><span>${x.trend > 0 ? UP_SVG : x.trend < 0 ? DN_SVG : ''}</span><small>${esc(x.src || '')}</small></div>`).join('') : '<div class="empty">还没发现她特别爱什么</div>';
  const lean = [g.lean.clingText, g.lean.livelyText].filter(Boolean).join('、');
  return `<div class="her">
    <h4>性格</h4><div class="ptype">${esc(g.type)}${g.prevType ? `<small>从「${esc(g.prevType)}」变过来的</small>` : ''}${lean ? `<small>最近更${esc(lean)}一些</small>` : ''}</div>
    ${g.outgoing ? `<h4>${ICON('door')} 爱不爱出门</h4><div class="ptype" style="font-size:17px">${esc(g.outgoing.label)}<small>${g.outgoing.why.length ? esc(g.outgoing.why.join('、')) + '；' : ''}性格变了，出门习惯也会跟着变</small></div>` : ''}
    <h4>${ICON('mood4')} 她现在</h4>${cur}
    <h4>${ICON('heart')} 近 7 天心情</h4>${mood}
    <h4>${ICON('brain')} 五维 <small style="font:11px var(--body);color:var(--mute)">（虚线是出生时，合计 ${g.total}/${capTotal}）</small></h4>${stats}
    <h4>${ICON('sparkle')} 爱好</h4>${ints}
    ${g.ups.length ? `<h4>${ICON('tv')} 记住的 UP 主</h4>${g.ups.map((u) => `<span class="up">${esc(u.name)}</span>`).join('')}` : ''}
    <h4>${ICON('sprout')} 成长日志</h4>${g.log.length ? `<div class="glog">${g.log.map((l) => `<div><i>${esc((l.at || '').slice(5, 10))}</i>${esc(l.text)}</div>`).join('')}</div>` : '<div class="empty">还没有变化，慢慢来～</div>'}
  </div>`;
}

// 记忆页（F-76 第二步）：她还记得什么、对自己的认识、想法怎么变的、认识的人
// 记忆页折起来的几块（三期，妈妈 11-08 拍板）：展开状态记在浏览器里，存不了就每次都折着
const MEM_OPEN_KEY = 'yushe.memOpen';
const memOpen = () => { try { return new Set(JSON.parse(localStorage.getItem(MEM_OPEN_KEY) || '[]')); } catch { return new Set(); } };
document.addEventListener('toggle', (e) => {
  const d = e.target; if (!d?.dataset?.msec) return;
  try { const s = memOpen(); d.open ? s.add(d.dataset.msec) : s.delete(d.dataset.msec); localStorage.setItem(MEM_OPEN_KEY, JSON.stringify([...s])); } catch { /* 存不了就算了 */ }
}, true);
const memFold = (key, icon, title, n, body, open) => `<details class="msec" data-msec="${key}"${open.has(key) ? ' open' : ''}><summary>${ICON(icon)} ${title} <small>· ${n} 条</small></summary>${body}</details>`;
function memPanel(m) {
  // 她写的回忆录（三期）：本月 / 最近一章 + 最近 4 篇周记，只看 headline，点开看全文；不清晰的标出来；空的时候按真实状态说
  function memoirHtml(m) {
    const ws = (m.weeklies || []).slice(0, 4), ch = (m.chapters || [])[0], st = m.weeklyStatus || {};
    const status = st.lastWeekMissed ? '上周没写成（那几天没开 DSH 或零花钱不够），下次写日记时补'
      : st.thisWeekCount ? `这周攒了 ${st.thisWeekCount} 件事，周日她写完日记就写`
      : '她每周日写一篇周记，月初写上个月的一章';
    const chRow = ch ? `<details class="memo ch"><summary><b>${esc(ch.title)}</b>${esc(ch.headline)}<i>${esc(ch.month)} · 一章</i></summary><p>${esc(ch.text)}</p></details>` : '';
    const wRow = (w) => `<details class="memo${w.stage !== '清晰' ? ' faded' : ''}"><summary><b>${esc(w.headline)}</b><i>${esc((w.from || '').slice(5))}–${esc((w.to || '').slice(5))} · 周记${w.stage !== '清晰' ? ` · ${esc(w.stage)}` : ''}</i></summary><p>${esc(w.text)}</p></details>`;
    const empty = !ch && !ws.length;
    return `<h4>${ICON('book')} 她写的回忆录</h4><div class="empty" style="font-size:12px;margin-top:-2px">她自己回想着写的，不是逐条记录</div>${chRow}${ws.map(wRow).join('')}${empty || st.lastWeekMissed || (st.thisWeekCount && !ws.length) ? `<div class="empty" style="margin-top:6px">${status}</div>` : ''}`;
  }
  if (!m || !m.ok) return '<div class="empty">记忆还没准备好，过一会儿再看～</div>';
  const call = esc(LIFE?.fish?.parentCall || '爸妈');
  const stat = `<div class="mstat"><div><b>${m.clear || 0}</b>清晰</div><div class="s-fuzzy"><b>${m.fuzzy || 0}</b>模糊</div><div class="s-trace"><b>${m.trace || 0}</b>只剩印象</div><div><b>${m.people?.filter((p) => p.tier !== '爸妈').length || 0}</b>认识的人</div></div>`;
  // 认识只有四种口吻：想明白了的展开看；还在想的先不上计数（有的念头想几天就会放下，这很正常）
  const sure = (m.beliefs || []).filter((b) => b.state === '想明白了');
  const germ = (m.beliefs || []).filter((b) => b.state === '还在想');
  // 四期-2 G：钉住的标「记牢了」、不再提的标「不再提」——她办了什么，爸妈在页面一眼能对上（只显示，不加按钮）
  const flagOf = (b) => (b.pinned || b.muted) ? `${b.pinned ? '记牢了' : ''}${b.pinned && b.muted ? ' · ' : ''}${b.muted ? '不再提' : ''}` : '';
  const bl = sure.length ? sure.map((b) => { const flag = flagOf(b); return `<details class="belief fold"><summary>${esc(b.text)}<i>${esc(b.about)}${b.source === 'parent' ? ` · ${call}纠正过` : ''}${flag ? ` · ${esc(flag)}` : ''}${b.times > 1 ? ` · 想到过 ${b.times} 次` : ''}${b.home ? ' · 家里的事，不对外说' : ''}</i></summary>${b.why || b.effect ? `<dl>${b.why ? `<dt>为什么</dt><dd>${esc(b.why)}</dd>` : ''}${b.effect ? `<dt>以后会怎样</dt><dd>${esc(b.effect)}</dd>` : ''}</dl>` : ''}</details>`; }).join('') : `<div class="empty" style="margin-top:6px">还没有。她每天写完日记会想一想，慢慢攒下对自己的认识。</div>`;
  const germRow = germ.length ? `<div class="germ">还在想：${germ.map((b) => `<em>${esc(b.text)}</em>`).join('、')}</div><div class="empty" style="font-size:12px">有的念头想几天就会放下，这很正常</div>` : '';
  // 想法变了：最近 8 条，四种变化用不同的口吻说，别让人以为她坏了
  const chgRow = (c) => c.kind === '取代' ? `以前觉得 ${esc(c.before)}，现在觉得 ${esc(c.after)}` : c.kind === '站住了' ? `${esc(c.before)} —— 想了几天，她自己也认了` : c.kind === '没站住' ? `想过 ${esc(c.before)}，后来没再想下去` : `后来不这么觉得了：${esc(c.before)}${c.why ? `（因为${esc(c.why)}…）` : ''}`;
  const mmdd = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''; }; // 本机日子，不拿 ISO 前几位（晚上的事别显示成第二天）
  const chg = (m.changes || []).slice(0, 8).length ? `<div class="glog">${(m.changes || []).slice(0, 8).map((c) => `<div><i>${esc(mmdd(c.at))}</i><span>${chgRow(c)}</span></div>`).join('')}</div>` : '';
  const ppl = (m.people || []).filter((p) => p.tier !== '爸妈');
  const pp = ppl.length ? ppl.map((p) => `<span class="up">${esc(p.who)} · ${esc(p.tier)}${p.fuzzy ? '（记不清了）' : ''}</span>`).join('') : '<div class="empty" style="margin-top:6px">B站上还没认识谁</div>';
  const rec = (m.recent || []).length ? m.recent.map((e) => { const flag = flagOf(e); return `<div class="mrow st-${esc(e.stage)}"><i>${esc(e.stage)}</i><span>${esc(e.text)}${flag ? ` <b style="font-weight:600;color:var(--mute)">${esc(flag)}</b>` : ''}</span></div>`; }).join('') : '<div class="empty" style="margin-top:6px">还没记下什么</div>';
  // 四期-2 F / 修补-3 T：改动记录白话一句（op 不认识的按「整理了一下」说）。现在分两段：爸妈让她办的放最前，自动的合成一天一行
  const opWord = (l) => {
    const t = l.text || '';
    switch (l.op) {
      case 'add': return `记下了 ${l.n || '几'} 件事`;
      case 'forget': return `忘掉了 ${l.n || '几'} 件`;
      case 'tell': return `说好了要记：${t}`;
      case 'untell': return `忘掉了一件要记的：${t}`;
      case 'mute': return `不再提${t}`;
      case 'unmute': return `接着照旧提${t}`;
      case 'pin': return `记牢了${t}`;
      case 'unpin': return `不用记牢了，照旧慢慢忘：${t}`;
      case 'fix': return `改了一处记错的：${t}`; // 四期-3 K：爸妈说「你记错了」办完记一笔
      case 'drop': return `忘掉了一件${t}`; // 四期-3 K：一样两步走，日志里只有种类、没有原话（J8）
      case 'confirm': return `想明白了：${t}`;
      case 'supersede': return `想法变了：${t}`;
      case 'retire': return `不再这么想了：${t}`;
      case 'reflect': return `睡前想了想：${t}`;
      case 'weekly': return `写了一篇周记：${t}`;
      case 'chapter': return `写完一章回忆录：${t}`;
      default: return '整理了一下';
    }
  };
  // 修补-3 T：改动记录分两段——上面「{爸妈}让她办的 · N 条」（新的在前，最多 20 条，白话沿用现在的说法）、下面「她自己整理的」一天一行
  const askedN = (m.asked || []).length;
  const askedHtml = askedN ? `<div class="glog">${(m.asked || []).map((l) => `<div><i>${esc(mmdd(l.at))}</i><span>${esc(opWord(l))}</span></div>`).join('')}</div>` : '<div class="empty" style="margin-top:6px">还没让她办过什么</div>';
  const dayRow = (d) => [d.add ? `记下 ${d.add} 件` : '', d.forget ? `忘掉 ${d.forget} 件` : '', d.thought ? `想明白 ${d.thought} 条` : '', d.weekly ? (d.weekly === 1 ? '写了一篇周记' : `写了 ${d.weekly} 篇周记`) : '', d.chapter ? (d.chapter === 1 ? '写完一章回忆录' : `写完 ${d.chapter} 章回忆录`) : ''].filter(Boolean).join('、') || (d.reflect ? '睡前想了想，没想出新的' : '整理了一下');
  const dailyN = (m.daily || []).length;
  const dailyHtml = dailyN ? `<div class="glog">${(m.daily || []).map((d) => `<div><i>${esc((d.day || '').slice(5))}</i><span>${esc(dayRow(d))}</span></div>`).join('')}</div>` : '<div class="empty" style="margin-top:6px">这几天她还没整理过</div>';
  // 带日子的嘱咐（四期-1 C）：日子在后显示出来，是哪天她一望便知；过了的按「已经过去了」说
  const toldWhen = (x) => {
    if (!x.due) return '';
    if (x.past) return '已经过去了';
    const d = new Date(`${x.due}T12:00:00`); // 按中午算，躲开时区改日
    const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    const t = new Date();
    const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    return today === x.due ? '就是今天' : `${esc(x.due.slice(5))} ${esc(wk)}`;
  };
  // 排法（妈妈 11-08 拍板）：统计条 → 她写的回忆录（置顶）→ 其余几块默认折起来，只显示「标题 · N 条」
  const open = memOpen();
  const chgN = (m.changes || []).slice(0, 8).length;
  return `<div class="her">
    <h4>${ICON('brain')} 她还记得多少 <small style="font:11px var(--body);color:var(--mute)">聊天、日记、她自己说过的话记得久；刷过的视频、扫一眼的东西忘得快</small></h4>${stat}
    ${memoirHtml(m)}
    ${(m.told || []).length ? memFold('told', 'bookmark', `${call}让她记住的`, m.told.length, m.told.map((x) => { const flag = flagOf(x); const when = toldWhen(x); return `<div class="belief">${esc(x.text)}<small>${when ? `${when} · ` : ''}${flag ? `${esc(flag)} · ` : ''}${x.loose ? '先随手记着 · ' : ''}只在家里说</small></div>`; }).join(''), open) : ''}
    ${memFold('beliefs', 'sparkle', '对自己的认识', sure.length, `${bl}${germRow}`, open)}
    ${chgN ? memFold('changes', 'sparkle', '想法变了', chgN, chg, open) : ''}
    ${memFold('people', 'heart', 'B站上认识的人', ppl.length, pp, open)}
    ${memFold('recent', 'book', '最近记得的事', (m.recent || []).length, `<div class="empty" style="font-size:12px">会慢慢变模糊；档案在「笔记本」「日记」里，一直都在</div>${rec}`, open)}
    ${memFold('ops', 'pencil', `${call}让她办的`, askedN, askedHtml, open)}
    ${dailyN ? memFold('dayrun', 'pencil', '她自己整理的', dailyN, dailyHtml, open) : ''}
    <div class="empty" style="font-size:12px">想让她记牢、别再提、改掉记错的、忘掉一件事，直接跟她说就行：「${SAY_LINES.join('」「')}」；她办完会告诉你</div>
    <div class="empty" style="font-size:12px">${call}可以在设置里调「记性」：健忘 / 适中 / 好记性</div>
  </div>`;
}

// 右侧面板
let TAB = 'today';
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
async function renderTab() {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.dataset.tab === TAB));
  $('diaryWrite2').style.display = TAB === 'diary' ? 'inline-flex' : 'none';
  const body = $('tabBody');
  if (TAB === 'today') {
    const ev = (LIFE?.events || []).slice().reverse();
    body.innerHTML = ev.length ? ev.map((e) => `<div class="tl"><i>${hhmm(e.at)}</i><span>${esc(e.text)}</span></div>`).join('') + (LIFE?.workToday ? `<div class="tl"><i>今天</i><span>${ICON('work')} 在 DSH 帮${esc(LIFE.fish.parentCall)}干了 ${LIFE.workToday} 次活</span></div>` : '') : '<div class="empty">今天还没发生什么～跟她说句话吧</div>';
  } else if (TAB === 'sched') {
    const r = await api('/schedule');
    const head = `<div class="schhead">${r.ready ? (r.ai ? '她今天的打算（早上醒来自己想的）' : '她今天的打算') : '她还在想今天干啥……（先看个大概）'}<small>只是打算，会不会变看她心情；出不出门还是她自己决定；真发生了什么看「今天」</small></div>`;
    const rows = (r.rows || []).map((x) => `<div class="sch ${x.now ? 'now' : ''}"><span>${ICON(x.icon)}</span><b>${x.from}–${x.to}</b><span>${esc(x.what)}${x.now ? '<i class="nowtag">现在</i>' : ''}</span></div>`).join('');
    body.innerHTML = head + rows; // 真发生的事在「今天」页，这里只放打算（F-54）
    if (!r.ready) setTimeout(() => { if (TAB === 'sched') renderTab(); }, 8000); // 她写好了就换上
  } else if (TAB === 'her') {
    body.innerHTML = herPanel(LIFE?.growth, LIFE?.fish);
  } else if (TAB === 'mem') {
    body.innerHTML = '<div class="empty">她在回想……</div>';
    const m = await api('/memory').catch(() => null);
    if (TAB === 'mem') body.innerHTML = memPanel(m);
  } else {
    const d = LIFE?.diary || [];
    body.innerHTML = d.length ? d.map((x) => `<div class="dentry" style="margin-bottom:8px"><b>${esc(x.day)}</b><p>${esc(x.text)}</p></div>`).join('') : '<div class="empty">还没有日记，她睡前会写；也可以现在让她写。</div>';
  }
}
document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (!b) return; TAB = b.dataset.tab; renderTab(); });
$('diaryWrite2').addEventListener('click', async () => {
  const b = $('diaryWrite2'); b.disabled = true; b.textContent = '她在写……';
  const r = await api('/diary', {});
  b.disabled = false; b.textContent = '让她写今天的日记';
  if (!r.ok) return toast(r.error);
  await refreshLife(); renderTab(); bubbleSay('日记写好啦，不许偷看太久哦～');
});

// 手机：相册 / 日程 / 日记
let APP = 'album';
// 右上角各入口的页面（F-45 / F-46 / F-47）：不再有手机那排二级入口，点哪个就是哪一页
const BOOK_TITLE = { letters: '信箱', album: '明信片', journal: '她的笔记本', bag: '背包' };
// F-89：信箱分 tab，别把 B站消息和她的信拼成一坨
const MAIL_TABS = ['全部', '信', 'B站', '待发'];
let MAIL = { list: [], i: 0, unread: new Set(), tab: '全部' }, PHOTOS = { list: [], i: -1 }, PHOTO_JUMP = null; // PHOTO_JUMP：从见闻缩略图点进来，直接翻到那张
const navBtns = (i, n, prev, next) => `<div class="lnav"><button class="gb plain sm" data-nav="prev" ${i <= 0 ? 'disabled' : ''}><i class="tri l"></i>${prev}</button><span>${n ? `第 ${i + 1} / ${n}` : ''}</span><button class="gb plain sm" data-nav="next" ${i >= n - 1 ? 'disabled' : ''}>${next}<i class="tri"></i></button></div>`;
const draftLabel = (d) => d.kind === 'comment' ? `评论 · 在《${esc(d.target?.title || '')}》下面` : d.kind === 'dm' ? `私信 · 回 ${esc(d.target?.who || '网友')}` : '动态';
// 私信 + 爸妈专线（任务 46）：一段段对话，对方的话只展示
const DM_STATUS = { pending: '等你批准', queued: '排队', sending: '正在发', sent: '', uncertain: '不确定发出去没', failed: '没发出去', rejected: '你说不发', expired: '过期没发' };
function dmsHtml() {
  const v = MAIL.dms; if (!v || !(v.convs || []).length) return '';
  return `<div class="drafts"><h4>${ICON('speech')} B站私信</h4>${v.convs.slice(0, 6).map((c) => `<div class="dmconv ${c.parent ? 'parent' : ''}"><b>${c.unseen ? '<span class="newtag">新</span>' : ''}${c.parent ? `${esc(LIFE?.fish?.parentCall || '爸妈')}（专线）` : esc(c.who || '网友')}</b>${c.history.slice(-4).map((x) => `<div class="dml ${x.from}"><span>${esc(x.text)}</span>${x.status && DM_STATUS[x.status] ? `<i>${DM_STATUS[x.status]}</i>` : ''}</div>`).join('')}${c.note ? `<small class="trust">${esc(c.note)}</small>` : ''}</div>`).join('')}${v.parentSet ? '' : '<small class="trust">想用 B站私信跟她说话？在设置「她的上网习惯」里填上你自己的 B站 UID（爸妈专线）。</small>'}</div>`;
}
function draftsHtml() {
  const ds = MAIL.drafts || [];
  // 自己发模式（F-51）：只看她排队想说的话，可以撤下某一条
  if (MAIL.mode !== 'approve') {
    const qs = MAIL.queued || [];
    if (!qs.length) return '';
    // F-92：她说不出为什么——是睡着了、在等发言间隔、还是今天额度用完了，得让爸妈看见
    const next = MAIL.queuedWhy || (MAIL.nextAt && Date.parse(MAIL.nextAt) > Date.now() ? `下一条最早 ${hhmm(MAIL.nextAt)} 发` : '马上就会发');
    return `<div class="drafts"><h4>${ICON('speech')} 她排队想在 B站说的话（${qs.length} 条）</h4><small class="trust">${esc(next)}</small>${qs.map((d) => `<div class="dcard"><b>${draftLabel(d)}</b>${d.target?.url ? ` <a href="${esc(d.target.url)}" target="_blank" rel="noreferrer">看视频</a>` : ''}<p style="margin:6px 0;font:14px/1.6 var(--body)">${esc(d.text)}</p><div class="dacts"><button class="gb plain sm" data-reject="${esc(d.id)}">不发这条</button></div></div>`).join('')}<small class="trust">发言间隔、每天上限、要不要先给你批准，都在设置「她的上网习惯」里。</small></div>`;
  }
  if (!ds.length) return '';
  const tr = MAIL.trust;
  return `<div class="drafts"><h4>${ICON('speech')} 她想在 B站说的话（${ds.length} 条等你批准）</h4>${tr ? `<small class="trust">她现在：${esc(tr.step)}${tr.next ? `；再原样批准 ${tr.next.need} 条就到「${esc(tr.next.name)}」` : ''}</small>` : ''}${ds.map((d) => `<div class="dcard"><b>${draftLabel(d)}</b>${d.target?.url ? ` <a href="${esc(d.target.url)}" target="_blank" rel="noreferrer">看视频</a>` : ''}<textarea data-draft="${esc(d.id)}" maxlength="${d.kind === 'comment' ? 80 : d.kind === 'dm' ? 120 : 200}">${esc(d.text)}</textarea><div class="dacts"><button class="gb plain sm" data-reject="${esc(d.id)}">不行</button><button class="gb green sm" data-approve="${esc(d.id)}">批准发出</button></div></div>`).join('')}<small class="trust">今天已发：评论 ${MAIL.today?.comment ?? 0}/${MAIL.limits?.comment ?? 0}，动态 ${MAIL.today?.post ?? 0}/${MAIL.limits?.post ?? 0}（上限在设置「她的上网习惯」里改）</small></div>`;
}
// 收件箱（任务 45）：B站上有人回她 / 给她点赞 / 关注她。别人的话只展示
const INBOX_ICON = { reply: 'speech', like: 'heart', follow: 'sparkle' };
function inboxHtml() {
  const ib = MAIL.inbox; if (!ib || !(ib.items || []).length) return '';
  const line = (x) => x.kind === 'reply' ? `<b>${esc(x.who)}</b> 回了她${x.mine ? `那句「${esc(x.mine.slice(0, 14))}${x.mine.length > 14 ? '…' : ''}」` : ''}<p>${esc(x.text)}</p>`
    : x.kind === 'like' ? `<b>${esc(x.who)}</b>${(x.count || 1) > 1 ? ` 等 ${x.count} 人` : ''} 赞了她${x.mine ? `：「${esc(x.mine.slice(0, 20))}${x.mine.length > 20 ? '…' : ''}」` : ''}`
    : `<b>${esc(x.who)}</b> 关注了她`;
  return `<div class="drafts"><h4>${ICON('heart')} B站上有人理她${ib.fanCount != null ? `<small style="color:var(--mute);font-weight:400"> · 粉丝 ${ib.fanCount}</small>` : ''}</h4>${ib.items.slice(0, 40).map((x) => `<div class="jentry">${!x.seenBefore ? '<span class="newtag">新</span>' : ''}${ICON(INBOX_ICON[x.kind] || 'sparkle')} ${line(x)}<small style="color:var(--mute)">${esc(String(x.at || x.got || '').slice(5, 10))} ${esc(hhmm(x.at || x.got))}</small>${x.url ? ` <a href="${esc(x.url)}" target="_blank" rel="noreferrer">在 B站看</a>` : ''}</div>`).join('')}</div>`;
}
// F-89：信箱 tab —— 全部按时间倒序混排，信 / B站 / 待发各自成页
const tabBar = (cur) => `<div class="mtabs">${MAIL_TABS.map((t) => `<button class="mtab${t === cur ? ' on' : ''}" data-mtab="${t}">${t}</button>`).join('')}</div>`;
const mailTime = (x) => Date.parse(x.at || x.got || x.createdAt || 0) || 0;
function allHtml() {
  // 全部：她的信 + B站上有人理她 + 待发，一条时间轴
  const items = [];
  for (const l of MAIL.list || []) items.push({ at: mailTime(l), raw: l.at, kind: 'letter', x: l });
  for (const x of (MAIL.inbox?.items || [])) items.push({ at: mailTime(x), raw: x.at || x.got, kind: 'inbox', x });
  for (const d of [...(MAIL.queued || []), ...(MAIL.drafts || [])]) items.push({ at: mailTime(d), raw: d.createdAt, kind: 'draft', x: d });
  items.sort((a, b) => b.at - a.at);
  if (!items.length) return `<div class="needcfg">${ICON('mail')}<div>还没有东西。<br>她出门回来、有感悟、零花钱快花光时会给你写信。</div></div>`;
  const line = (x) => x.kind === 'reply' ? `<b>${esc(x.who)}</b> 回了她<p>${esc(x.text)}</p>`
    : x.kind === 'like' ? `<b>${esc(x.who)}</b>${(x.count || 1) > 1 ? ` 等 ${x.count} 人` : ''} 赞了她`
    : `<b>${esc(x.who)}</b> 关注了她`;
  return items.map(({ at, raw, kind, x }) => {
    const when = `<small style="color:var(--mute)">${esc(mmdd(raw || at))} ${esc(hhmm(raw || new Date(at).toISOString()))}</small>`;
    if (kind === 'letter') {
      const li = MAIL.list.indexOf(x);
      return `<div class="jentry" data-mletter="${li}"><b>${ICON('mail')} ${esc(x.kindText || '信')}</b> ${when}<p>${esc(String(x.text || '').slice(0, 60))}${String(x.text || '').length > 60 ? '…' : ''}</p><a href="javascript:void 0" data-mletter="${li}">展开看</a></div>`;
    }
    if (kind === 'inbox') return `<div class="jentry">${ICON(INBOX_ICON[x.kind] || 'sparkle')} ${line(x)} ${when}</div>`;
    return `<div class="jentry"><b>${ICON('speech')} ${draftLabel(x)}</b> ${when}<p>${esc(String(x.text || '').slice(0, 60))}</p></div>`;
  }).join('');
}
function renderLetter() {
  const { list, i, tab } = MAIL;
  const bar = tabBar(tab);
  if (tab === '全部') { $('phoneBody').innerHTML = bar + allHtml(); return; }
  if (tab === 'B站') { $('phoneBody').innerHTML = bar + (dmsHtml() + inboxHtml() || `<div class="needcfg">${ICON('heart')}<div>B站上还没人理她。</div></div>`); return; }
  if (tab === '待发') { $('phoneBody').innerHTML = bar + (draftsHtml() || `<div class="needcfg">${ICON('speech')}<div>她没在排队说什么。</div></div>`); return; }
  const l = list[i];
  if (!l) { $('phoneBody').innerHTML = bar + `<div class="needcfg">${ICON('mail')}<div>还没有信。<br>她出门回来、有感悟、零花钱快花光时会给你写信。</div></div>`; return; }
  $('phoneBody').innerHTML = bar + `<div class="lview"><div class="lpaper"><div class="lhead">${MAIL.unread.has(l.id) ? '<span class="newtag">新</span>' : ''}${esc(l.kindText || '信')} · ${esc(l.day)} ${esc(hhmm(l.at))}</div><p>${esc(l.text)}</p></div>${navBtns(i, list.length, '新一封', '旧一封')}</div>`;
}
// 明信片（F-84/F-85）：她出门途中从外面寄回家的。正面是她拍的照片，没拍成就是一张风景明信片（鱼社自己的画）；
// 背面她自己选写哪种：见闻 / 想你 / 口信（F-85）——风景卡选了想你和口信就不放链接和便利贴，只放她的话；照片卡照旧
const FRAME = { screen: '隔着屏幕', object: '变成东西', stepin: '走进去' };
const SAY_LABEL = { 见闻: '见闻', 想你: '想你', 口信: '口信' }; // 背面那种的小标签；scene 只认这样的 id 才拼进路径，防路径注入
const SCENE_OK = /^[a-z][a-z0-9]{2,20}$/;
const mmdd = (at) => { const d = new Date(at); return isNaN(+d) ? '某月某日' : `${d.getMonth() + 1} 月 ${d.getDate()} 日`; }; // 本机时区的哪天（别拿 ISO 前 10 位）
const pcFront = (ph, big) => (ph.url ? `<img src="${esc(ph.url)}" alt="${esc(ph.caption || '她拍的照片')}"${big ? '' : ' loading="lazy"'}>`
  : ph.kind !== 'text' && ph.scene && SCENE_OK.test(ph.scene) ? `<div class="pcscene" style="background-image:url(./assets/bg/${esc(ph.scene)}.webp)"><span class="pcpost">${esc(ph.at.slice(5, 10).replace('-', '.'))}<br>鱼社</span><p>${esc(ph.caption || ph.text || '从外面寄来的')}</p></div>`
  : `<div class="pcstamp"><span class="pcpost">${esc(ph.at.slice(5, 10).replace('-', '.'))}<br>鱼社</span><p>${esc(ph.caption || ph.text || '从外面寄来的')}</p><small>${esc(ph.ref?.title ? `在《${ph.ref.title}》那里` : '')}</small></div>`);
let PC_BACK = false;
let GONB_TRIP = null; // 从「去笔记本看」跳过去的：只切筛选，不另外定死到某一趟
function renderPhotoView() {
  const { list, i } = PHOTOS, ph = list[i];
  const link = ph.ref?.title ? `<div class="psrc">${ph.url ? '拍于《' : '寄自《'}${esc(ph.ref.title)}》${/^https?:\/\//.test(ph.ref.url || '') ? ` · <a href="${esc(ph.ref.url)}" target="_blank" rel="noreferrer">${/bilibili\.com/.test(ph.ref.url) ? '在 B站看' : '去看看'}</a>` : ''}${FRAME[ph.frame] ? ` <span class="pframe">${FRAME[ph.frame]}</span>` : ''}</div>` : '';
  const b = ph.back;
  const tag = SAY_LABEL[ph.say] && ph.say !== '见闻' ? `<span class="ptag">${esc(ph.say)}</span>` : '';
  const when = `<small style="color:var(--mute)">${esc(ph.at.slice(0, 10))} ${esc(hhmm(ph.at))} 寄到</small>`;
  // F-85：风景卡写了想你和口信 → 只放她的话 + 那种 + 寄到时间，不放链接和便利贴；最下面「去笔记本看」切到这趟的「这一趟」
  const back = !ph.url && (ph.say === '想你' || ph.say === '口信')
    ? `<div class="pcback"><div class="pcmsg big">${esc(ph.text || ph.caption || '')}</div>${tag}${when}<div class="pcfoot"><button class="pcgo" data-gonb>寄自 ${esc(mmdd(ph.at))}那趟 · 去笔记本看</button></div></div>`
    : `<div class="pcback"><div class="pcmsg">${esc(ph.text || ph.caption || '')}</div>${tag}${link}${b && (b.line || b.gist) ? `<div class="pcnote"><b>${esc(b.tag || '心得')}</b>${b.gist ? `<p>${esc(b.gist)}</p>` : ''}${b.line ? `<p class="nb-line">${esc(b.line)}</p>` : ''}</div>` : ''}${!ph.url && ph.moment ? `<div class="jwish">${ICON('camera')} 她想拍下：${esc(ph.moment)}</div>` : ''}${when}</div>`;
  if (!ph.pc) { // 0.34.0 以前的照片（没有背面）：照旧一张照片 + 说明 + 拍于哪条，不翻面
    $('phoneBody').innerHTML = `<div class="pview"><div class="pbig">${pcFront(ph, true)}</div><div class="pcap">${esc(ph.caption || '')}<br><small style="color:var(--mute)">${esc(ph.at.slice(0, 10))} ${esc(hhmm(ph.at))}</small>${link}</div>${navBtns(i, list.length, '上一张', '下一张')}<div style="text-align:center;margin-top:8px"><button class="gb plain sm" data-grid>回到明信片册</button></div></div>`;
    return;
  }
  $('phoneBody').innerHTML = `<div class="pview"><div class="pbig pcflip" data-pcflip>${PC_BACK ? back : pcFront(ph, true)}</div><div class="pcap">${PC_BACK ? '' : esc(ph.caption || '')}<div class="pctip">${PC_BACK ? '点一下翻回正面' : '点一下翻过来看背面'}</div></div>${navBtns(i, list.length, '上一张', '下一张')}<div style="text-align:center;margin-top:8px"><button class="gb plain sm" data-grid>回到明信片册</button></div></div>`;
}
// 笔记本（F-82）：只看不改；筛选和翻页只是换个看法
let NOTEBOOK = { entries: [], foot: [], ibFoot: {}, filter: '全部', page: 0, flipped: new Set() };
const NB_FILTERS = ['全部', '学到的', '感悟', '好点子', '心得', '踩雷', '这一趟', '足迹'];
const NB_CLASS = { 学到的: 'n-learn', 感悟: 'n-feel', 好点子: 'n-idea', 心得: 'n-thought', 踩雷: 'n-meh', 这一趟: 'n-card', 梦: 'n-dream', 见闻: 'n-old' };
const NB_PER_PAGE = 6;
const footHtml = (items, st) => items.length ? items.map((x) => { const s = st[x.id]; return `<div class="jentry"><b>${esc(({ comment: '评论', reply: '回复评论', dyncomment: '评论动态', post: '动态', like: '点赞', unlike: '取消点赞', comment_like: '给评论点赞', collect: '收藏', follow: '关注', unfollow: '取关' })[x.kind] || (x.kind === 'dm' ? `私信 · 回 ${x.target?.who || '网友'}` : '动态'))} · ${esc(x.at.slice(0, 10))} ${esc(hhmm(x.at))}${x.uncertain ? ' · 不确定有没有发出去' : ''}${s ? ` · ${[s.likes ? `${s.likes} 个赞` : '', s.replies ? `${s.replies} 条回复` : ''].filter(Boolean).join('、')}` : ''}</b><p>${esc(x.text)}</p>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noreferrer">在 B站看</a>` : ''}${x.target?.title ? ` <small style="color:var(--mute)">《${esc(x.target.title)}》</small>` : ''}</div>`; }).join('') : `<div class="needcfg">${ICON('sprout')}<div>她还没在 B站留下什么。</div></div>`;
const linkOf = (s) => `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.title)}</a>${s.source ? ` <small>${esc(s.source)}</small>` : ''}`;
const thumbOf = (s) => (s.photo && /^[a-z0-9-]{4,40}$/.test(s.photo) ? `<img class="jthumb" data-jph="${esc(s.photo)}" src="/api/dsh-yushe/photo/${esc(s.photo)}" alt="她拍的照片" title="她拍的照片">` : '');
function stickyHtml(c, i) {
  const kind = noteKind(c), cls = NB_CLASS[kind] || 'n-old';
  const tilt = ((i * 37 + c.at.length * 11) % 7) - 3; // 歪一点点，像手贴的
  const when = `${esc(c.at.slice(5, 10))} ${esc(hhmm(c.at))}`;
  const links = (arr) => arr.map((x) => `<div class="nb-more">· ${linkOf(x)}${thumbOf(x)}</div>`).join('');
  if (kind === '这一趟') {
    // F-84：回家时规则夹进来的一页：这趟扫过几个、点进去哪些、喜不喜欢（明信片已经在路上寄回了，在「明信片」册里）
    const rows = (c.read || []).map((x) => `<li><span class="nb-lk nb-lk-${esc({ 喜欢: 'y', 一般: 'm', 不喜欢: 'n' }[x.like] || 'q')}">${esc(x.inferred ? '看样子喜欢' : (x.like || '没说'))}</span>${linkOf(x)}<small>${esc(DEPTH_NAMES[x.depth] || '')}${x.acts?.length ? ` · ${esc(x.acts.join('、'))}` : ''}</small>${x.why ? `<em>${esc(x.why)}</em>` : ''}</li>`).join('');
    const body = c.read
      ? `<div class="nb-scan">扫过 ${c.scanned || 0} 个标题，点进去看了 ${(c.read || []).length} 个${rows ? '：' : '。'}</div>${rows ? `<ul class="nb-read">${rows}</ul>` : ''}`
      : `${c.text ? `<p class="nb-line">${esc(c.text)}</p>` : ''}${links(c.seen || [])}${c.wantPhoto?.moment ? `<div class="jwish">${ICON('camera')} 她想拍下：${esc(c.wantPhoto.moment)}</div>` : ''}`; // 以前的格式：回家写的那几句 + 链接
    return `<div class="nb-sticky ${cls}" style="--tilt:${tilt}deg"><div class="nb-head"><b>${ICON('door')} 这一趟</b><span>${when}</span></div>${body}</div>`;
  }
  if (kind === '见闻' || kind === '梦') {
    // 以前的见闻 / 梦：只是看过的链接，不冒充心得；占位话不显示
    return `<div class="nb-sticky ${cls}" style="--tilt:${tilt}deg"><div class="nb-head"><b>${kind === '梦' ? `${ICON('moon')} 梦` : '看过的'}</b><span>${when}</span></div>${!isFiller(c.text) ? `<p class="nb-line">${esc(c.text)}</p>` : ''}${links(c.seen || [])}</div>`;
  }
  const s = (c.seen || [])[0];
  const depth = c.note?.depth && c.note.depth !== 'title' ? DEPTH_NAMES[c.note.depth] : ''; // 只扫过标题的已经写在正文里了
  const gist = c.note?.gist ? `<p class="nb-gist">${esc(c.note.gist)}</p>` : c.note?.depth === 'title' ? '<p class="nb-gist none">只扫了一眼标题</p>' : '';
  return `<div class="nb-sticky ${cls}" style="--tilt:${tilt}deg"><div class="nb-head"><b>${esc(kind)}</b><span>${when}</span></div>${s ? `<div class="nb-title">${linkOf(s)}${thumbOf(s)}</div>` : ''}${gist}${c.text ? `<p class="nb-line">${esc(c.text)}</p>` : ''}${depth ? `<span class="nb-depth">${esc(depth)}</span>` : ''}</div>`;
}
function renderNotebook() {
  const nb = NOTEBOOK, body = $('phoneBody');
  const chips = `<div class="nbchips">${NB_FILTERS.map((f) => `<button class="nbchip ${NB_CLASS[f] || ''} ${nb.filter === f ? 'on' : ''}" data-nf="${f}">${f}</button>`).join('')}</div>`;
  if (nb.filter === '足迹') { body.innerHTML = chips + `<div class="drafts">${footHtml(nb.foot, nb.ibFoot)}</div>`; return; }
  const list = nb.entries.filter((c) => nb.filter === '全部' || noteKind(c) === nb.filter);
  if (!list.length) { body.innerHTML = chips + `<div class="needcfg">${ICON('book')}<div>${nb.filter === '全部' ? '笔记本还是空的。<br>她出门逛的时候，看到有意思的会贴一张便利贴。' : nb.filter === '这一趟' ? '还没有。<br>她每趟逛完回家，会在这里夹一页：这趟看了哪些、喜不喜欢。' : `还没有「${esc(nb.filter)}」的便利贴。${nb.filter === '心得' ? '<br>以前看过的在「全部」里，标着「看过的」。' : ''}`}</div></div>`; return; }
  const pages = Math.ceil(list.length / NB_PER_PAGE);
  nb.page = Math.max(0, Math.min(pages - 1, nb.page));
  const cards = list.slice(nb.page * NB_PER_PAGE, (nb.page + 1) * NB_PER_PAGE);
  body.innerHTML = chips + `<div class="nbpage">${cards.map(stickyHtml).join('')}</div>` + navBtns(nb.page, pages, '新一页', '旧一页');
}
async function renderPhone() {
  $('bookTitle').textContent = BOOK_TITLE[APP] || '';
  const body = $('phoneBody');
  body.onclick = null;
  if (APP === 'letters') {
    // 信箱：一封一封看，新的在前；打开时把「新」记下来再标已读
    // F-93：先推一次队列（宿主心跳 10 分钟一次，别让爸妈打开信箱还干等）
    await api('/flush', {}).catch(() => {});
    const [r, dr, ib, dm] = await Promise.all([api('/letters'), api('/drafts').catch(() => ({ pending: [] })), api('/inbox').catch(() => null), api('/dms').catch(() => null)]);
    if (ib) ib.items = (ib.items || []).map((x) => ({ ...x, seenBefore: x.seen }));
    MAIL = { list: r.letters || [], i: 0, tab: (MAIL && MAIL.tab) || '全部', unread: new Set((r.letters || []).filter((l) => !l.read).map((l) => l.id)), drafts: dr.pending || [], queued: dr.queued || [], mode: dr.mode, nextAt: dr.nextAt, queuedWhy: dr.queuedWhy, trust: dr.trust, today: dr.today, limits: dr.limits, inbox: ib, dms: dm };
    if (!MAIL.list.length && !MAIL.drafts.length && !MAIL.queued.length && !(ib?.items || []).length && !(dm?.convs || []).length) { body.innerHTML = `<div class="needcfg">${ICON('mail')}<div>还没有信。<br>她出门回来、有感悟、零花钱快花光时会给你写信。</div></div>`; return; }
    renderLetter();
    if (r.unread || ib?.unseen || dm?.unseen) { if (r.unread) await api('/letters/read', {}); if (ib?.unseen) await api('/inbox', { seen: true }); if (dm?.unseen) await api('/dms', { seen: true }); renderMailDot(MAIL.mode === 'approve' ? MAIL.drafts.length : MAIL.queued.length); }
    body.onclick = async (e) => {
      const ap = e.target.closest('[data-approve]'), rj = e.target.closest('[data-reject]');
      if (ap || rj) {
        const id = (ap || rj).dataset.approve || (ap || rj).dataset.reject;
        const text = ap ? body.querySelector(`textarea[data-draft="${id}"]`)?.value : undefined;
        (ap || rj).disabled = true;
        const res = await api('/drafts', { id, action: ap ? 'approve' : 'reject', text });
        if (ap) toast(res.ok ? '发出去了！在「笔记本」的足迹里' : res.status === 'uncertain' ? `不确定有没有发出去：${res.error || ''}` : `没发出去：${res.error || ''}`);
        else toast('好，这条不发');
        return renderPhone();
      }
      const tb = e.target.closest('[data-mtab]');
      if (tb) { MAIL.tab = tb.dataset.mtab; MAIL.i = 0; return renderLetter(); }
      const lt = e.target.closest('[data-mletter]');
      if (lt) { MAIL.tab = '信'; MAIL.i = Number(lt.dataset.mletter) || 0; return renderLetter(); }
      const b = e.target.closest('[data-nav]'); if (!b || b.disabled) return; MAIL.i += b.dataset.nav === 'next' ? 1 : -1; renderLetter();
    };
  } else if (APP === 'album') {
    // 明信片册（F-84）：她出门途中寄回的明信片，正面照片或文字卡；点开翻面看背面
    const r = await api('/album');
    PHOTOS = { list: r.photos || [], i: -1 }; PC_BACK = false;
    const grid = () => {
      if (!PHOTOS.list.length) { body.innerHTML = `<div class="needcfg">${ICON('postcard')}<div>还没有明信片。<br>她出门时会从外面寄回来。${r.configured ? '' : '<br>想让她寄照片？可以在设置里接一个画图服务（不接也行，会寄文字明信片）。'}</div>${r.configured ? '' : '<button class="gb plain sm" data-gocfg>去设置</button>'}</div>`; return; }
      body.innerHTML = `<div class="pgrid">${PHOTOS.list.map((ph, k) => `<div class="ptile${ph.url ? '' : ' pctext'}" data-ph="${k}">${pcFront(ph)}<span>${esc(ph.at.slice(5, 10))} ${esc(ph.url ? (ph.caption || '') : (String(ph.text || ph.caption || '寄来的明信片').slice(0, 8) + (String(ph.text || '').length > 8 ? '…' : '')))}</span></div>`).join('')}</div>`;
    };
    const jump = PHOTO_JUMP; PHOTO_JUMP = null;
    const at = jump ? PHOTOS.list.findIndex((p) => p.photo === jump) : -1;
    if (at >= 0) { PHOTOS.i = at; renderPhotoView(); } else grid();
    body.onclick = (e) => {
      if (e.target.closest('a')) return;
      if (e.target.closest('[data-gocfg]')) { $('phoneM').classList.remove('on'); openCfg(); loadImgApi(); return; }
      const gonb = e.target.closest('[data-gonb]'); // F-85：风景卡按了「去笔记本看」→ 打开笔记本，切到「这一趟」筛选
      if (gonb) { PC_BACK = false; PHOTOS.i = -1; GONB_TRIP = true; openApp('journal'); return; }
      const tile = e.target.closest('[data-ph]'); if (tile) { PHOTOS.i = Number(tile.dataset.ph); PC_BACK = false; renderPhotoView(); return; }
      if (e.target.closest('[data-pcflip]')) { PC_BACK = !PC_BACK; renderPhotoView(); return; }
      if (e.target.closest('[data-grid]')) { PHOTOS.i = -1; grid(); return; }
      const b = e.target.closest('[data-nav]'); if (b && !b.disabled) { PHOTOS.i += b.dataset.nav === 'next' ? 1 : -1; PC_BACK = false; renderPhotoView(); }
    };
  } else if (APP === 'journal') {
    // 笔记本（F-82，docs/设计/13）：一张张便利贴，最新的在第一页左上角；明信片翻过来是这趟的读过清单；足迹在筛选里
    const [r, fp, ib] = await Promise.all([api('/journal'), api('/footprints').catch(() => ({ items: [] })), api('/inbox').catch(() => ({ foot: {} }))]);
    NOTEBOOK = { entries: r.entries || [], foot: fp.items || [], ibFoot: ib?.foot || {}, filter: GONB_TRIP ? '这一趟' : '全部', page: 0, flipped: new Set() }; // F-85：从「去笔记本看」跳过来就切到「这一趟」
    GONB_TRIP = null;
    renderNotebook();
    body.onclick = (e) => {
      const t = e.target.closest('[data-jph]'); if (t) { PHOTO_JUMP = t.dataset.jph; openApp('album'); return; }
      const fl = e.target.closest('[data-nf]'); if (fl) { NOTEBOOK.filter = fl.dataset.nf; NOTEBOOK.page = 0; renderNotebook(); return; }
      const nv = e.target.closest('[data-nav]'); if (nv && !nv.disabled) { NOTEBOOK.page += nv.dataset.nav === 'next' ? 1 : -1; renderNotebook(); return; }
      const fp2 = e.target.closest('[data-flip]'); if (fp2 && !e.target.closest('a')) { const k = fp2.dataset.flip; NOTEBOOK.flipped.has(k) ? NOTEBOOK.flipped.delete(k) : NOTEBOOK.flipped.add(k); renderNotebook(); }
    };
  } else if (APP === 'bag') {
    const b = await api('/bag');
    const gearRow = `<div class="gearslot"><b>出门带上</b>${b.gear ? `<span class="gi">${ICON(b.gear)}${esc(b.items.find((x) => x.id === b.gear)?.name || '')}</span><button class="gb plain sm" data-unequip>拿出来</button>` : '<span class="gempty">（空着。装备放进来，下一趟会有用）</span>'}</div>`;
    const items = b.items.length ? b.items.map((x) => `<div class="bitem ${b.gear === x.id ? 'on' : ''}"><img src="./assets/icons/${esc(x.icon)}.webp" alt=""><div><b>${esc(x.name)}</b>${x.count > 1 ? `<em>×${x.count}</em>` : ''}<small class="r-${esc(x.rarity)}">${esc(x.rarity)}</small><p>${esc(x.desc)}${x.gear ? `<br><i>装备：${esc(x.gear)}</i>` : ''}</p>${x.gear && b.gear !== x.id ? `<button class="gb sm" data-equip="${esc(x.id)}">带上它</button>` : ''}</div></div>`).join('') : `<div class="empty">${ICON('bag', 'big')}<br>背包还是空的。她出门闲逛回来会带小东西。</div>`;
    const book = `<h4 class="bookh">${ICON('dex')} 小东西图鉴 ${b.book.got}/${b.book.total}</h4><div class="bookgrid">${b.book.all.map((x) => `<div class="bk ${x.got ? 'got' : ''}" title="${x.got ? esc(x.name) : '还没捡到'}"><img src="./assets/icons/${esc(x.icon)}.webp" alt=""><span>${x.got ? esc(x.name) : '？？？'}</span></div>`).join('')}</div>`;
    body.innerHTML = gearRow + items + book;
    body.onclick = async (e) => {
      const eq = e.target.closest('[data-equip]'), un = e.target.closest('[data-unequip]');
      if (!eq && !un) return;
      const r = await api('/bag', { equip: eq ? eq.dataset.equip : null });
      if (r.ok === false) toast(r.error); else renderPhone();
    };
  }
}
// 右上角入口：信箱 / 明信片 / 笔记本 / 背包各自直达
const openApp = (app) => { APP = app; $('phoneM').classList.add('on'); renderPhone(); };
$('mailBtn').addEventListener('click', () => openApp('letters'));
$('albumBtn').addEventListener('click', () => openApp('album'));
$('journalBtn').addEventListener('click', () => openApp('journal'));
$('bagBtn').addEventListener('click', () => openApp('bag'));
$('phoneX').addEventListener('click', () => $('phoneM').classList.remove('on'));
$('phoneM').addEventListener('click', (e) => { if (e.target.id === 'phoneM') $('phoneM').classList.remove('on'); });

// 设置：生图 API
// 设置：零花钱
async function loadWallet() {
  let w; try { w = await api('/allowance'); } catch { return; }
  document.querySelectorAll('#walletModes .chip').forEach((c) => c.classList.toggle('on', c.dataset.mode === w.mode));
  $('walletJarRow').hidden = w.mode !== 'jar';
  $('walletDailyRow').hidden = w.mode !== 'daily';
  $('walletLeft').textContent = w.mode === 'jar' ? `罐里还剩 ${tokensText(w.left)} token` : '';
  $('walletDaily').value = w.daily;
  const by = (w.byKind || []).map((k) => `${k.label} ${tokensText(k.tokens)}`).join('，');
  $('walletSpent').textContent = `今天花了 ${tokensText(w.spentToday)}${by ? `（${by}）` : ''}；一共花了 ${tokensText(w.total)}${w.broke ? '。花光了，她在歇着' : ''}`;
  renderWalletChip(w);
}
$('walletModes').addEventListener('click', async (e) => { const c = e.target.closest('.chip'); if (!c) return; await api('/allowance', { mode: c.dataset.mode }); loadWallet(); });
$('walletJarRow').addEventListener('click', async (e) => { const b = e.target.closest('[data-top]'); if (!b) return; await api('/allowance', { topUp: Number(b.dataset.top) }); toast(`放了 ${tokensText(Number(b.dataset.top))} 零花钱`); loadWallet(); });
$('walletDailySave').addEventListener('click', async () => { await api('/allowance', { daily: Number($('walletDaily').value) }); toast('每天的零花钱改好了'); loadWallet(); });
$('walletChip').addEventListener('click', () => { openCfg(); loadWallet(); loadImgApi(); });
$('cfgBtn').addEventListener('click', loadWallet);
// 设置：她的上网习惯（F-41 → F-59 两层配置）——上面三个档位 + 几个开关；细配置只读展开（细的跟她聊天改）
async function loadHabits() {
  let r; try { r = await api('/habits'); } catch { return; }
  const { habits: h, fields: F, knobs = [], fine = [] } = r;
  const knobRows = knobs.map((k) => `<div class="hrow"><span>${esc(k.label)}</span><span class="chips knob">${k.levels.map((l) => `<button class="chip ${k.level === l ? 'on' : ''}" data-knob="${k.key}" data-level="${esc(l)}">${esc(l)}</button>`).join('')}${k.level === '自定义' ? '<button class="chip on custom" disabled>她按你的话定的</button>' : ''}</span></div>`).join('');
  const uiRows = Object.entries(F).map(([k, f]) => {
    let ctl = '';
    if (f.type === 'bool') ctl = `<span class="switch ${h[k] ? 'on' : ''}" data-hk="${k}" data-bool></span>`;
    else if (f.type === 'int') ctl = `<span class="stepper"><button data-hk="${k}" data-d="-1" ${h[k] <= f.min ? 'disabled' : ''}>−</button><b data-v="${h[k]}">${h[k] === 0 && f.zero ? f.zero : h[k]}</b><button data-hk="${k}" data-d="1" ${h[k] >= f.max ? 'disabled' : ''}>+</button></span>`;
    else if (f.type === 'enum') ctl = `<span class="chips">${f.values.map((v) => `<button class="chip ${h[k] === v ? 'on' : ''}" data-hk="${k}" data-v="${v}">${esc(f.names[v])}</button>`).join('')}</span>`;
    else if (f.type === 'time') ctl = `<input type="time" value="${esc(h[k])}" data-hk="${k}">`;
    else if (f.type === 'uid') ctl = `<input type="text" class="uidin" inputmode="numeric" maxlength="20" placeholder="一串数字" title="B站 App「我的」页头像旁边的 UID" value="${esc(h[k])}" data-hk="${k}" data-uid>`;
    return `<div class="hrow"><span>${esc(f.label)}</span>${ctl}</div>`;
  }).join('');
  const fineBox = fine.length ? `<details class="fine" id="fineBox" ${document.getElementById('fineBox')?.open ? 'open' : ''}><summary>细配置（只能看，想改跟她在 DSH 里说）</summary>${fine.map((g) => `<h4>${esc(g.name)}</h4>${g.items.map((it) => `<div class="frow"><span>${esc(it.label)}</span><i>${esc(it.text)}</i></div>`).join('')}`).join('')}</details>` : '';
  $('habitsBox').innerHTML = knobRows + uiRows + fineBox;
  const og = LIFE?.growth?.outgoing;
  $('habitsSum').textContent = r.summary + (og ? `。她现在是「${og.label}」${og.why.length ? `（${og.why.join('、')}）` : ''}，出不出门由性格掷骰子` : '');
}
// 改完重画这一块时保住设置面板的滚动位置（不然内容会跳，下一下就点错行）
const keepScroll = async (fn) => {
  const sc = document.querySelector('#cfg .cfgbody'), top = sc?.scrollTop ?? 0;
  const r = await fn();
  await loadHabits();
  if (sc) { sc.scrollTop = top; requestAnimationFrame(() => { sc.scrollTop = top; }); }
  return r;
};
const saveHabit = (patch) => keepScroll(async () => { const r = await api('/habits', patch); if (r.changed?.length) toast(`改好了：${r.changed.map((c) => c.label).join('、')}`); return r; });
const setKnob = (knob, level) => keepScroll(async () => {
  let r = await api('/habits', { knob, level });
  if (r.needsForce) { if (!confirm(`${r.error}。确定换吗？`)) return r; r = await api('/habits', { knob, level, force: true }); }
  if (r.ok) toast(r.changed?.length ? `换成「${level}」：改了 ${r.changed.length} 项` : `已经是「${level}」`);
  return r;
});
$('habitsBox').addEventListener('click', (e) => {
  const kb = e.target.closest('[data-knob]'); if (kb && !kb.disabled) return setKnob(kb.dataset.knob, kb.dataset.level);
  const el = e.target.closest('[data-hk]'); if (!el || el.disabled) return;
  const k = el.dataset.hk;
  if (el.hasAttribute('data-bool')) return saveHabit({ [k]: !el.classList.contains('on') });
  if (el.dataset.d) { const cur = Number(el.parentElement.querySelector('b').dataset.v); return saveHabit({ [k]: cur + Number(el.dataset.d) }); }
  if (el.dataset.v) return saveHabit({ [k]: el.dataset.v });
});
$('habitsBox').addEventListener('change', (e) => {
  const el = e.target.closest('input[type=time][data-hk]'); if (el) return saveHabit({ [el.dataset.hk]: el.value });
  const u = e.target.closest('input[data-uid]'); if (!u) return;
  const v = u.value.replace(/\s/g, '');
  if (v && !/^\d{1,20}$/.test(v)) { toast('UID 是一串数字，在 B站 App「我的」里能看到'); return; }
  saveHabit({ [u.dataset.hk]: v });
});
$('cfgBtn').addEventListener('click', loadHabits);

async function loadImgApi() {
  try {
    const r = await api('/image-api');
    $('imgBase').value = r.baseUrl || ''; $('imgModel').value = r.model || ''; $('imgKey').value = '';
    $('imgState').textContent = r.hasKey ? `已设置 key（${r.keyTail}）` : '还没设置 key';
  } catch { /* 宿主没响应 */ }
}
$('cfgBtn').addEventListener('click', loadImgApi);
$('imgTest').addEventListener('click', async () => {
  const b = $('imgTest'); b.disabled = true; b.textContent = '在拍…';
  try {
    const r = await api('/photo-test', {});
    if (!r.ok) toast(r.error || '没拍成'); else { toast('试拍好了（只是试拍，不算她寄的明信片），在右上角「明信片」里'); }
  } catch (e) { toast(`没拍成：${e.message}`); }
  b.disabled = false; b.textContent = '试拍一张';
});
$('imgSave').addEventListener('click', async () => {
  const r = await api('/image-api', { baseUrl: $('imgBase').value.trim(), model: $('imgModel').value.trim(), apiKey: $('imgKey').value });
  if (!r.ok) return toast(r.error || '没保存上');
  $('imgKey').value = ''; $('imgState').textContent = r.hasKey ? `已保存（key ${r.keyTail}）` : '已保存（还没有 key）';
  toast('生图 API 已保存');
});

/* ================= 启动 ================= */
['wave', 'peek', 'point', 'hype', 'wow', 'jump', 'cheer', 'look', 'sign', 'proud', 'oops'].forEach((p) => { new Image().src = POSE(p); });
try {
  const pond = await api('/pond');
  for (const f of pond.fish || []) S.owned.add(f.proto);
  if ((pond.fish || []).length) { S.firstEgg = false; story.variablesState.returning = true; $('guarantee').textContent = '再领养不保底，看缘分～'; }
} catch { /* 宿主没响应也能玩，只是领养那一步会报错 */ }
renderDex();
if (MODE === 'panel') $('closeBtn').style.display = 'none';
if (story.variablesState.returning) showHome();
else { await toPondScene(); setScreen('intro'); runKnot('intro'); }
