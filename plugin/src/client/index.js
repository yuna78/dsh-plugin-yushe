/**
 * 鱼社 dsh-yushe · 浏览器端入口
 *
 * 构建后被包进 `window.__ModuleLoader__.load({ id: 'dsh-plugin-yushe', factory(require) { … } })`
 * （见 plugin/scripts/build.mjs）；React 由宿主提供，不打进产物。
 *
 * - 设置 → 鱼社：当前上工的鱼、打开鱼社、让她歇着；宿主状态；M1 探针。
 * - 新会话起始页 chip「领养一条鱼」。
 * - 整帧浮层（shell.overlay）里用 iframe 打开游戏（/api/dsh-yushe/game/）：游戏自己的 Pixi 和样式与 DSH 完全隔离。
 */
import React from 'react';

const h = React.createElement;
// 鱼社不放 emoji（F-39）：图标用游戏的图标集
const Ic = (n, size = 16) => h('img', { src: `/api/dsh-yushe/game/assets/icons/${n}.webp`, alt: '', style: { width: size, height: size, verticalAlign: '-3px', objectFit: 'contain', marginRight: 3 } });
const STATUS_PATH = '/api/dsh-yushe/status';
const SAY_PATH = '/api/dsh-yushe/probe/say';
const ROAM_PATH = '/api/dsh-yushe/probe/roam';
const GAME_URL = '/api/dsh-yushe/game/';
const CURRENT_PATH = '/api/dsh-yushe/current';

/** 浮层开关：模块级小仓库，chip / 设置页按钮打开，游戏里关。 */
const gameStore = {
  open: false,
  listeners: new Set(),
  set(open) { gameStore.open = open; for (const l of [...gameStore.listeners]) l(); },
  subscribe(l) { gameStore.listeners.add(l); return () => gameStore.listeners.delete(l); },
};
const statusStore = { tick: 0, listeners: new Set(), bump() { statusStore.tick++; for (const l of [...statusStore.listeners]) l(); } };

function GameOverlay() {
  const [open, setOpen] = React.useState(gameStore.open);
  React.useEffect(() => gameStore.subscribe(() => setOpen(gameStore.open)), []);
  React.useEffect(() => {
    if (!open) return undefined;
    const onMsg = (e) => { if (e.origin === location.origin && e.data?.type === 'dsh-yushe:close') { gameStore.set(false); statusStore.bump(); } };
    const onKey = (e) => { if (e.key === 'Escape') gameStore.set(false); };
    window.addEventListener('message', onMsg); window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('message', onMsg); window.removeEventListener('keydown', onKey); };
  }, [open]);
  if (!open) return null;
  return h('div', { 'data-dsh-yushe': 'overlay', style: { position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.45))', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'min(3vw, 28px)' } },
    h('iframe', { title: '鱼社', src: GAME_URL, style: { width: '100%', height: '100%', maxWidth: 1400, border: 0, borderRadius: 18, boxShadow: '0 20px 60px rgba(0,0,0,.35)', background: '#7fd0f2' }, allow: 'clipboard-write' }),
  );
}

const PANEL_KEY = 'dsh-yushe';

/** 左侧栏入口「鱼社」打开的整页面板：同一个游戏，panel 模式（没有鱼走引导，有鱼进房间）。 */
function YushePage() {
  return h('div', { 'data-dsh-yushe': 'page', style: { height: '100%', width: '100%', display: 'flex', background: '#7fd0f2', overflow: 'hidden' } },
    h('iframe', { title: '鱼社', src: `${GAME_URL}?mode=panel`, style: { flex: 1, width: '100%', height: '100%', border: 0 }, allow: 'clipboard-write' }));
}
const FishGlyph = ({ size = 16 } = {}) => h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
  h('path', { d: 'M13.5 8c-1.6-2.6-5.6-3.2-8 0l-3-2.2.9 2.2-.9 2.2 3-2.2c2.4 3.2 6.4 2.6 8 0z', strokeLinejoin: 'round' }),
  h('circle', { cx: 10.6, cy: 7.4, r: 0.6, fill: 'currentColor' }));

/** 输入框上方的鱼小条：只在鱼社的鱼正在上工时出现；点一下打开她的房间。 */
function FishDock() {
  const [st, setSt] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    const load = () => fetch(STATUS_PATH, { headers: { accept: 'application/json' } }).then((r) => r.json()).then((d) => { if (alive) setSt(d); }).catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    const l = () => load(); statusStore.listeners.add(l);
    return () => { alive = false; clearInterval(timer); statusStore.listeners.delete(l); };
  }, []);
  const f = st?.fish;
  if (!f) return null;
  const n = f.now || {};
  const sleeping = n.where === 'sleep';
  return h('button', {
    type: 'button', 'data-dsh-yushe': 'dock', onClick: () => gameStore.set(true),
    title: `${f.name}（${f.rarity} · ${f.personality}）${f.workspace ? `在「${f.workspace.title}」里替你干活` : '正在替你干活'}，点我去鱼社看她`,
    style: { display: 'inline-flex', alignItems: 'center', gap: 6, margin: '0 0 6px', padding: '2px 10px 2px 3px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-default, #ddd)', background: 'var(--dsw-alias-bg-default, #fff)', cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-text-default, inherit)' },
  },
    h('img', { src: `/api/dsh-yushe/game/assets/head-${f.proto}.webp`, alt: '', style: { width: 20, height: 20, borderRadius: '50%', objectFit: 'cover' } }),
    h('b', { style: { fontWeight: 600 } }, f.name),
    // 这一条在所有对话的输入框上都会出现（插槽不告诉我们当前对话在哪个工作区），所以写清楚她在哪儿上工（F-64）
    h('span', { style: { opacity: 0.75 } }, Ic(sleeping ? 'moon' : 'work', 14), f.workspace ? `${sleeping ? '睡着了，' : ''}在「${f.workspace.title}」上工` : (sleeping ? '睡着了也在上工' : '上工中')),
    n.moodIcon && h('span', { title: `心情${n.moodWord} · 精力 ${n.energy}` }, Ic(n.moodIcon, 16)),
  );
}

function HeroChip() {
  return h('button', { type: 'button', onClick: () => gameStore.set(true), title: '去鱼社领养一条 AI 鱼', style: { padding: '4px 12px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-default, #ddd)', background: 'var(--dsw-alias-bg-default, #fff)', cursor: 'pointer', fontSize: 13 } }, Ic('rod', 16), '领养一条鱼');
}

/** 设置页顶部：当前上工的鱼 + 打开鱼社 + 让她歇着 / 回来上工。 */
function FishCard({ status, reload }) {
  const f = status?.fish;
  const rest = async (on) => {
    await fetch(CURRENT_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: on ? status.lastFish : null }) });
    reload();
  };
  return h('div', { style: box },
    h('div', { style: { fontSize: 18, fontWeight: 700, marginBottom: 4 } }, Ic('fish', 20), '鱼社'),
    f
      ? h('div', { style: { fontSize: 14 } }, `正在上工：`, h('b', null, f.name), `（${f.rarity} · ${f.personality}），她叫你「${f.parentCall}」。下一条消息起就是她在回答。`)
      : h('div', { style: { ...dim, fontSize: 13.5 } }, status?.lastFish ? '她在歇着，DSH 里现在没有鱼社的人设。' : '还没有领养过鱼。去鱼社撒一把谷子，孵一条属于你的 AI 鱼吧。'),
    h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
      h('button', { type: 'button', onClick: () => gameStore.set(true), style: { ...btn, marginTop: 0, fontWeight: 600 } }, f ? '回鱼社看看' : '去领养一条鱼'),
      f && h('button', { type: 'button', onClick: () => rest(false), style: { ...btn, marginTop: 0 } }, '让她歇着'),
      !f && status?.lastFish && h('button', { type: 'button', onClick: () => rest(true), style: { ...btn, marginTop: 0 } }, '叫她回来上工'),
    ),
  );
}
const fmtTok = (u) => (u ? `输入 ${u.inputTokens ?? 0} · 输出 ${u.outputTokens ?? 0}${u.reasoningTokens ? ` · 思考 ${u.reasoningTokens}` : ''} · 合计 ${u.totalTokens ?? (u.inputTokens || 0) + (u.outputTokens || 0)} tokens` : 'token 未知');
const btn = { marginTop: 10, padding: '5px 14px', borderRadius: 8, cursor: 'pointer' };

/** S2：让本鱼说一句（宿主模型，流式） */
function SayProbe() {
  const [s, setS] = React.useState({ text: '' });
  const run = React.useCallback(async () => {
    setS({ text: '', busy: true });
    try {
      const r = await fetch(SAY_PATH, { method: 'POST' });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '', text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line) continue;
          const m = JSON.parse(line);
          if (m.type === 'delta') { text += m.text; setS({ text, busy: true }); }
          else if (m.type === 'done') setS({ text: m.text, done: m });
          else if (m.type === 'error') setS({ text, error: m.error });
        }
      }
    } catch (e) { setS((p) => ({ ...p, busy: false, error: String(e?.message || e) })); }
  }, []);
  return h('div', { style: box },
    h('div', { style: { fontWeight: 600 } }, '探针 S2 · 让本鱼说一句'),
    h('div', { style: { ...dim, fontSize: 12.5 } }, '通道 A：宿主模型服务 + 你的默认模型，不挂任何工具，流式返回。'),
    (s.text || s.busy) && h('div', { style: { margin: '10px 0 4px', fontSize: 15 } }, Ic('fish', 16), s.text || '…'),
    s.done && h('div', { style: { ...dim, fontSize: 12.5 } }, `${s.done.provider}/${s.done.model} · ${s.done.ms} ms · ${fmtTok(s.done.usage)}`),
    s.error && h('div', { style: { color: 'var(--dsw-alias-text-danger, #c0392b)', fontSize: 13 } }, `失败：${s.error}`),
    h('button', { type: 'button', onClick: run, disabled: s.busy, style: btn }, s.busy ? '她在想…' : '让本鱼说一句'),
  );
}

/** S3：试着出门一次（headless 只读） */
function RoamProbe() {
  const [s, setS] = React.useState({});
  const poll = React.useRef(null);
  React.useEffect(() => () => clearInterval(poll.current), []);
  const run = React.useCallback(async () => {
    clearInterval(poll.current);
    setS({ busy: true });
    try {
      const { id, error } = await (await fetch(ROAM_PATH, { method: 'POST' })).json();
      if (!id) throw new Error(error || '没拿到任务 id');
      poll.current = setInterval(async () => {
        const j = await (await fetch(`${ROAM_PATH}?id=${encodeURIComponent(id)}`)).json();
        if (j.state === 'running') setS({ busy: true, elapsed: j.elapsedMs });
        else { clearInterval(poll.current); setS({ job: j }); }
      }, 3000);
    } catch (e) { setS({ error: String(e?.message || e) }); }
  }, []);
  const j = s.job;
  return h('div', { style: box },
    h('div', { style: { fontWeight: 600 } }, '探针 S3 · 试着出门一次'),
    h('div', { style: { ...dim, fontSize: 12.5 } }, '通道 B：宿主先取好今天的新闻和 B站热门，她起一轮 headless 挑喜欢的、最多读 3 页；只看不说。大约 1 分钟。'),
    s.busy && h('div', { style: { marginTop: 8 } }, Ic('bag', 16), `她出门了… ${s.elapsed ? Math.round(s.elapsed / 1000) + ' 秒' : ''}`),
    s.error && h('div', { style: { color: 'var(--dsw-alias-text-danger, #c0392b)', fontSize: 13, marginTop: 8 } }, `失败：${s.error}`),
    j && h('div', { style: { marginTop: 8, fontSize: 13.5 } },
      h('div', null, `${j.state === 'done' ? '回家了' : j.state === 'timeout' ? '超时了' : '出错了'} · ${Math.round((j.ms || 0) / 1000)} 秒 · ${fmtTok(j.usage)}${j.usage ? ` · 调了 ${j.usage.calls} 次模型` : ''}`),
      j.usage?.toolCalls && Object.keys(j.usage.toolCalls).length > 0 && h('div', { style: dim }, `用到的工具：${Object.entries(j.usage.toolCalls).map(([k, v]) => `${k}×${v}`).join('、')}`),
      j.error && h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, ...dim } }, j.error),
      j.result?.seen && h('ul', { style: { margin: '8px 0', paddingLeft: 18 } }, j.result.seen.map((x, i) => h('li', { key: i }, `${x.verified ? '已核实' : '未核实'} [${x.source || x.kind}] `, h('a', { href: x.url, target: '_blank', rel: 'noreferrer' }, x.title), ` —— ${x.why}`))),
      j.result?.postcard && h('div', { style: { padding: '8px 12px', borderRadius: 10, background: 'var(--dsw-alias-bg-subtle, #f6f3ee)' } }, Ic('postcard', 16), j.result.postcard),
      !j.result && j.rawTail && h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, ...dim } }, j.rawTail),
    ),
    h('button', { type: 'button', onClick: run, disabled: s.busy, style: btn }, s.busy ? '在外面…' : '试着出门一次'),
  );
}

const box = { border: '1px solid var(--dsw-alias-border-default, #ddd)', borderRadius: 12, padding: '14px 16px', marginBottom: 12, lineHeight: 1.7 };
const row = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 };
const dim = { color: 'var(--dsw-alias-text-secondary, #888)' };

function Flag({ ok, yes, no }) {
  return h('span', { style: { color: ok ? 'var(--dsw-alias-text-success, #2e7d5b)' : 'var(--dsw-alias-text-warning, #b4502a)', fontWeight: 600 } }, ok ? yes : no);
}

function YusheSettings() {
  const [state, setState] = React.useState({ loading: true });
  const load = React.useCallback(() => {
    setState({ loading: true });
    fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
      .then((r) => r.json())
      .then((data) => setState({ data }))
      .catch((error) => setState({ error: String(error?.message || error) }));
  }, []);
  React.useEffect(load, [load]);
  React.useEffect(() => { const l = () => load(); statusStore.listeners.add(l); return () => statusStore.listeners.delete(l); }, [load]);

  const d = state.data;
  return h('div', { 'data-dsh-yushe': 'settings', style: { maxWidth: 640 } },
    h(FishCard, { status: d, reload: load }),
    h('div', { style: box },
      h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '宿主状态'),
      state.loading && h('div', { style: dim }, '读取中…'),
      state.error && h('div', { style: { color: 'var(--dsw-alias-text-danger, #c0392b)' } }, `读取失败：${state.error}`),
      d && h(React.Fragment, null,
        h('div', { style: row }, h('span', null, '插件版本'), h('span', null, `${d.plugin} ${d.version}`)),
        h('div', { style: row }, h('span', null, '宿主模型服务（通道 A）'), h(Flag, { ok: d.host?.llm, yes: '可用', no: '拿不到' })),
        h('div', { style: row }, h('span', null, '默认模型'), h('span', null, d.host?.defaultModel ? `${d.host.defaultModel.provider} / ${d.host.defaultModel.model}` : '未选择')),
        h('div', { style: row }, h('span', null, '会话服务 agents'), h(Flag, { ok: d.host?.agents, yes: '可用', no: '拿不到' })),
        h('div', { style: row }, h('span', null, '鱼的 B站号'), h(Flag, { ok: d.bili?.loggedIn, yes: '已登录', no: '未登录（运行 tools/bili-login.mjs）' })),
        h('div', { style: { ...row, ...dim, marginTop: 6 } }, h('span', null, '宿主端启动于'), h('span', null, d.startedAt)),
      ),
      h('button', { type: 'button', onClick: load, style: { marginTop: 10, padding: '4px 12px', borderRadius: 8, cursor: 'pointer' } }, '刷新'),
    ),
    h(SayProbe),
    h(RoamProbe),
  );
}

export default {
  inject: ['slots'],
  apply(ctx) {
    // 游戏里「找她干活」：在最近用过的工作区新开一个原生 DSH 会话并打开（她是当前人设，会话里就是她）
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessions', 'uiWorkspace'], (scope) => {
        scope.effect(() => {
          const onMsg = async (e) => {
            if (e.origin !== location.origin || e.data?.type !== 'dsh-yushe:work') return;
            gameStore.set(false);
            try {
              const ws = scope.uiWorkspace ?? scope.get('uiWorkspace');
              const name = typeof e.data.name === 'string' ? e.data.name.slice(0, 20) : '';
              // 她绑了工作区（F-64）就在那个工作区开；工作区没了就退回最近用过的
              const wsId = typeof e.data.workspaceId === 'string' && e.data.workspaceId ? e.data.workspaceId : undefined;
              // startSession：不给 workspaceId 就沿用当前 / 最近用过的工作区；草稿先填一句开场白，用户改了再发
              if (typeof ws?.startSession === 'function') {
                try { ws.startSession(wsId, { prompt: name ? `${name}，帮我个忙：` : '', clearPreviousDraft: false }); }
                catch { ws.startSession(undefined, { prompt: name ? `${name}，帮我个忙：` : '', clearPreviousDraft: false }); }
              } else {
                const sessions = scope.sessions ?? scope.get('sessions');
                await ws.openSession(await sessions.create({}));
              }
            } catch (err) {
              // 打不开就退一步：至少回到对话区，让用户自己点 New Session
              console.warn('[dsh-yushe] open work session failed:', err);
            }
          };
          window.addEventListener('message', onMsg);
          return () => window.removeEventListener('message', onMsg);
        }, 'dsh-yushe: work session bridge');
      });
    }
    // 左侧栏「鱼社」入口 + 整页面板（主入口，装好就看得见）
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_KEY }, YushePage));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 4, label: () => '鱼社' }, FishGlyph));
    // 次入口：起始页 chip / 设置页按钮 → 浮层
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-yushe-game', order: 60 }, GameOverlay));
    ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({ name: 'conversation.hero.options', id: 'dsh-yushe-hero', order: 45 }, HeroChip));
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'dsh-yushe-dock', order: 61 }, FishDock));
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'dsh-yushe',
      order: 19,
      label: () => '鱼社',
    }, YusheSettings));
  },
};
