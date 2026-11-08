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
import { nextTip } from '../shared/tips.js';
import { HOMES, homeOf } from '../shared/homes.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ART = (id) => `./assets/girl-${id}.webp`;
// 游戏里不放 emoji（F-39）：图标都是项目自己的彩色图标集（美术/assets/icons，生图 + 抠图）
const ICON = (n, cls = '') => `<img class="ic${cls ? ` ${cls}` : ''}" src="./assets/icons/${n}.webp" alt="">`;
const UP_SVG = '<svg class="trend-up" viewBox="0 0 12 12"><path d="M6 2l4 6H2z" fill="#2fbf71" stroke="#2a2440" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const DN_SVG = '<svg class="trend-dn" viewBox="0 0 12 12"><path d="M6 10L2 4h8z" fill="#e0475b" stroke="#2a2440" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const ACT_ICON = { sleep: 'moon', out: 'door', working: 'work', reading: 'news', writing: 'diary', thinking: 'think', home: 'house' };
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
    + `<span>${ICON(L.moodIcon || 'mood3')} 心情 <i class="meter"><i style="width:${L.mood}%"></i></i></span>`
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
let lastActivity = null, prevSent = null;
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
    $('awayNote').textContent = `${tr?.note || `${L.fish.parentCall}，我出去逛逛，回来给你寄明信片～`}${tr?.total ? `\n（已经寄回 ${tr.sent}/${tr.total} 张明信片${back}）` : back ? `\n（${back.trim()}）` : ''}`;
  }
  // 明信片寄到了：提醒一下
  if (L.trip && prevSent !== null && L.trip.sent > prevSent) toast('她在外面看到了新东西，记在右上角的「见闻」里');
  prevSent = L.trip ? L.trip.sent : null;
  $('rSub').textContent = `${f.rarity} · ${f.personality || ''} · ${L.activityText || L.whereText}`;
  document.querySelectorAll('.quick .qa').forEach((b) => { if (b.dataset.act !== 'work') b.disabled = act === 'out'; });
  $('sayIn').placeholder = act === 'out' ? '她出门了，回来再聊～' : act === 'sleep' ? '她在睡觉……小声点说（会把她叫醒）' : '跟她说点什么…（回车发送）';
  if (lastActivity === 'out' && act !== 'out') { bounce(); bubbleSay(`${L.fish.parentCall}，我回来啦！见闻和照片都放好了～`); }
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
async function streamTo(path, body, onText) {
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
    const r = await streamTo('/chat', { text }, (t) => renderMsgs([...chat, { role: 'fish', text: t }]));
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
    const r = await streamTo(path, body, (t) => { if (first) { first = false; bubbleThinking(false); } bubbleLive(t, think); });
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

/** 「她」面板（F-24）：性格、近 7 天心情、五维（现在 vs 出生）、爱好（带升降和原因）、记住的 UP 主、成长日志。 */
function herPanel(g, fish) {
  if (!g) return '<div class="empty">她还小，成长记录还没开始。</div>';
  const mood = g.moodDays.length ? `<div class="mood7wrap"><div class="mood7">${g.moodDays.map((m) => `<i style="height:${Math.max(6, m.mood)}%" title="${esc(m.day)} 心情 ${m.mood}"><span>${esc(m.day.slice(5))}</span></i>`).join('')}</div></div>` : '<div class="empty">还没攒够心情记录</div>';
  const capSingle = g.caps?.single ?? 100, capTotal = g.caps?.total ?? 200;
  const stats = g.stats.map((s) => `<div class="st2"><span>${esc(s.label)}</span><div class="bar3"><b style="width:${s.nowPct ?? s.now}%"></b><em style="left:${s.bornPct ?? s.born}%" title="出生时 ${s.born}"></em></div><span title="现在 ${s.now}，单维上限 ${capSingle}">${s.now}${s.now !== s.born ? (s.now > s.born ? UP_SVG : DN_SVG) : ''}</span></div>`).join('');
  const ints = g.interests.length ? g.interests.map((x) => `<div class="int"><span>${esc(x.tag)}</span><div class="bar3"><b style="width:${x.heat}%"></b></div><span>${x.trend > 0 ? UP_SVG : x.trend < 0 ? DN_SVG : ''}</span><small>${esc(x.src || '')}</small></div>`).join('') : '<div class="empty">还没发现她特别爱什么</div>';
  const lean = [g.lean.clingText, g.lean.livelyText].filter(Boolean).join('、');
  return `<div class="her">
    <h4>性格</h4><div class="ptype">${esc(g.type)}${g.prevType ? `<small>从「${esc(g.prevType)}」变过来的</small>` : ''}${lean ? `<small>最近更${esc(lean)}一些</small>` : ''}</div>
    ${g.outgoing ? `<h4>${ICON('door')} 爱不爱出门</h4><div class="ptype" style="font-size:17px">${esc(g.outgoing.label)}<small>${g.outgoing.why.length ? esc(g.outgoing.why.join('、')) + '；' : ''}性格变了，出门习惯也会跟着变</small></div>` : ''}
    <h4>${ICON('heart')} 近 7 天心情</h4>${mood}
    <h4>${ICON('brain')} 五维 <small style="font:11px var(--body);color:var(--mute)">（虚线是出生时，合计 ${g.total}/${capTotal}）</small></h4>${stats}
    <h4>${ICON('sparkle')} 爱好</h4>${ints}
    ${g.ups.length ? `<h4>${ICON('tv')} 记住的 UP 主</h4>${g.ups.map((u) => `<span class="up">${esc(u.name)}</span>`).join('')}` : ''}
    <h4>${ICON('sprout')} 成长日志</h4>${g.log.length ? `<div class="glog">${g.log.map((l) => `<div><i>${esc((l.at || '').slice(5, 10))}</i>${esc(l.text)}</div>`).join('')}</div>` : '<div class="empty">还没有变化，慢慢来～</div>'}
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
const BOOK_TITLE = { letters: '信箱', album: '相册', journal: '见闻', bag: '背包' };
let MAIL = { list: [], i: 0, unread: new Set() }, PHOTOS = { list: [], i: -1 };
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
    const next = MAIL.nextAt && Date.parse(MAIL.nextAt) > Date.now() ? `下一条最早 ${hhmm(MAIL.nextAt)} 发` : '马上就会发';
    return `<div class="drafts"><h4>${ICON('speech')} 她排队想在 B站说的话（${qs.length} 条，${next}）</h4>${qs.map((d) => `<div class="dcard"><b>${draftLabel(d)}</b>${d.target?.url ? ` <a href="${esc(d.target.url)}" target="_blank" rel="noreferrer">看视频</a>` : ''}<p style="margin:6px 0;font:14px/1.6 var(--body)">${esc(d.text)}</p><div class="dacts"><button class="gb plain sm" data-reject="${esc(d.id)}">不发这条</button></div></div>`).join('')}<small class="trust">发言间隔、每天上限、要不要先给你批准，都在设置「她的上网习惯」里。</small></div>`;
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
  return `<div class="drafts"><h4>${ICON('heart')} B站上有人理她${ib.fanCount != null ? `<small style="color:var(--mute);font-weight:400"> · 粉丝 ${ib.fanCount}</small>` : ''}</h4>${ib.items.slice(0, 12).map((x) => `<div class="jentry">${!x.seenBefore ? '<span class="newtag">新</span>' : ''}${ICON(INBOX_ICON[x.kind] || 'sparkle')} ${line(x)}<small style="color:var(--mute)">${esc(String(x.at || x.got || '').slice(5, 10))} ${esc(hhmm(x.at || x.got))}</small>${x.url ? ` <a href="${esc(x.url)}" target="_blank" rel="noreferrer">在 B站看</a>` : ''}</div>`).join('')}</div>`;
}
function renderLetter() {
  const { list, i } = MAIL, l = list[i];
  if (!l) { $('phoneBody').innerHTML = dmsHtml() + inboxHtml() + draftsHtml(); return; }
  $('phoneBody').innerHTML = dmsHtml() + inboxHtml() + draftsHtml() + `<div class="lview"><div class="lpaper"><div class="lhead">${MAIL.unread.has(l.id) ? '<span class="newtag">新</span>' : ''}${esc(l.kindText || '信')} · ${esc(l.day)} ${esc(hhmm(l.at))}</div><p>${esc(l.text)}</p></div>${navBtns(i, list.length, '新一封', '旧一封')}</div>`;
}
function renderPhotoView() {
  const { list, i } = PHOTOS, ph = list[i];
  $('phoneBody').innerHTML = `<div class="pview"><div class="pbig"><img src="${esc(ph.url)}" alt=""></div><div class="pcap">${esc(ph.caption || '')}<br><small style="color:var(--mute)">${esc(ph.at.slice(0, 10))} ${esc(hhmm(ph.at))}</small></div>${navBtns(i, list.length, '上一张', '下一张')}<div style="text-align:center;margin-top:8px"><button class="gb plain sm" data-grid>回到相册</button></div></div>`;
}
async function renderPhone() {
  $('bookTitle').textContent = BOOK_TITLE[APP] || '';
  const body = $('phoneBody');
  body.onclick = null;
  if (APP === 'letters') {
    // 信箱：一封一封看，新的在前；打开时把「新」记下来再标已读
    const [r, dr, ib, dm] = await Promise.all([api('/letters'), api('/drafts').catch(() => ({ pending: [] })), api('/inbox').catch(() => null), api('/dms').catch(() => null)]);
    if (ib) ib.items = (ib.items || []).map((x) => ({ ...x, seenBefore: x.seen }));
    MAIL = { list: r.letters || [], i: 0, unread: new Set((r.letters || []).filter((l) => !l.read).map((l) => l.id)), drafts: dr.pending || [], queued: dr.queued || [], mode: dr.mode, nextAt: dr.nextAt, trust: dr.trust, today: dr.today, limits: dr.limits, inbox: ib, dms: dm };
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
        if (ap) toast(res.ok ? '发出去了！在「见闻」的足迹里' : res.status === 'uncertain' ? `不确定有没有发出去：${res.error || ''}` : `没发出去：${res.error || ''}`);
        else toast('好，这条不发');
        return renderPhone();
      }
      const b = e.target.closest('[data-nav]'); if (!b || b.disabled) return; MAIL.i += b.dataset.nav === 'next' ? 1 : -1; renderLetter();
    };
  } else if (APP === 'album') {
    // 相册：只放照片（她出门时拍的，用生图 API 画）；没配 API 先提示去配
    const r = await api('/album');
    PHOTOS = { list: r.photos || [], i: -1 };
    const grid = () => {
      if (!PHOTOS.list.length) {
        body.innerHTML = r.configured
          ? `<div class="needcfg">${ICON('album')}<div>相册还是空的。<br>她下次出门会拍一张照片带回来。</div></div>`
          : `<div class="needcfg">${ICON('album')}<div>相册里是她出门时拍的照片。<br>先在设置里配好<b>生图 API</b>，她下次出门就会拍照带回来。</div><button class="gb sm" data-gocfg>去设置</button></div>`;
        return;
      }
      body.innerHTML = `${r.configured ? '' : '<div class="cfgnote" style="margin-bottom:10px">生图 API 没配好，新的照片拍不了。<button class="gb plain sm" data-gocfg>去设置</button></div>'}<div class="pgrid">${PHOTOS.list.map((ph, k) => `<div class="ptile" data-ph="${k}"><img src="${esc(ph.url)}" alt="" loading="lazy"><span>${esc(ph.at.slice(5, 10))} ${esc(ph.caption || '')}</span></div>`).join('')}</div>`;
    };
    grid();
    body.onclick = (e) => {
      if (e.target.closest('[data-gocfg]')) { $('phoneM').classList.remove('on'); openCfg(); loadImgApi(); return; }
      const tile = e.target.closest('[data-ph]'); if (tile) { PHOTOS.i = Number(tile.dataset.ph); renderPhotoView(); return; }
      if (e.target.closest('[data-grid]')) { PHOTOS.i = -1; grid(); return; }
      const b = e.target.closest('[data-nav]'); if (b && !b.disabled) { PHOTOS.i += b.dataset.nav === 'next' ? 1 : -1; renderPhotoView(); }
    };
  } else if (APP === 'journal') {
    // 见闻：她在外面看到的新闻 / 视频（标题、链接、她的话）+ 足迹（她在 B站真的留下的）
    const [r, fp, ib] = await Promise.all([api('/journal'), api('/footprints').catch(() => ({ items: [] })), api('/inbox').catch(() => ({ foot: {} }))]);
    const fst = (id) => { const st = ib?.foot?.[id]; return st ? ` · ${[st.likes ? `${st.likes} 个赞` : '', st.replies ? `${st.replies} 条回复` : ''].filter(Boolean).join('、')}` : ''; };
    const foot = (fp.items || []).length ? `<div class="drafts"><h4>${ICON('sprout')} 她在 B站留下的足迹</h4>${fp.items.map((x) => `<div class="jentry"><b>${esc(({ comment: '评论', reply: '回复评论', dyncomment: '评论动态', post: '动态', like: '点赞', unlike: '取消点赞', comment_like: '给评论点赞', collect: '收藏', follow: '关注', unfollow: '取关' })[x.kind] || (x.kind === 'dm' ? `私信 · 回 ${x.target?.who || '网友'}` : '动态'))} · ${esc(x.at.slice(0, 10))} ${esc(hhmm(x.at))}${x.uncertain ? ' · 不确定有没有发出去' : ''}${fst(x.id)}</b><p>${esc(x.text)}</p>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noreferrer">在 B站看</a>` : ''}${x.target?.title ? ` <small style="color:var(--mute)">《${esc(x.target.title)}》</small>` : ''}</div>`).join('')}</div>` : '';
    body.innerHTML = foot + ((r.entries || []).length ? r.entries.map((c) => `<div class="jentry ${c.final ? 'final' : ''}"><b>${ICON(c.final ? 'postcard' : 'magnifier')} ${esc(c.at.slice(0, 10))} ${esc(hhmm(c.at))}${c.final ? ' · 这一趟的总结' : ''}</b><p>${esc(c.text)}</p>${(c.seen || []).map((s) => `<div>· <a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.title)}</a>${s.source ? ` <small style="color:var(--mute)">${esc(s.source)}</small>` : ''}</div>`).join('')}</div>`).join('') : `<div class="needcfg">${ICON('magnifier')}<div>还没有见闻。<br>她出门逛的时候，看到有意思的会记下来。</div></div>`);
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
// 右上角入口：信箱 / 相册 / 见闻 / 背包各自直达
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
    if (!r.ok) toast(r.error || '没拍成'); else { toast('拍好了，在右上角「相册」里'); }
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
