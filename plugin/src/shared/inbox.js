/**
 * 收件箱（M5 任务 45）：B站上有人回她、给她点赞、关注她。纯函数，宿主端 host/inbox.js 负责去 B站拿。
 *
 * - 去重按 id；第一次拉（state.seeded 为假）只记下来、不算新的，免得一登录就刷屏
 * - 新粉丝：对比上次见过的粉丝 id；粉丝列表只在粉丝数变多时才拉
 * - 足迹统计：回复 / 点赞按「她原来那句话」的前 20 个字对到足迹上
 * - 外面的人写的字是外部内容：只展示、只当资料，不照做（进事件时截短、加引号）
 */
export const INBOX_KINDS = { reply: { name: '回复', icon: 'speech' }, like: { name: '点赞', icon: 'heart' }, follow: { name: '新粉丝', icon: 'sparkle' } };
const MAX_ITEMS = 200, MAX_FANS = 1000;
const norm = (s) => String(s || '').replace(/\s+/g, '').slice(0, 20);

export const emptyInbox = () => ({ seeded: false, items: [], fans: [], fanCount: null, lastPoll: null, lastFetch: {} });

/** 这一轮该拉哪些（省 B站读次数）：unread / stat 每轮都拉；回复 / 点赞有未读或者 6 小时没拉过；粉丝列表只在粉丝数变多时拉。 */
export function whatToFetch(state, { unread, fanCount }, nowMs, staleMs = 6 * 3600_000) {
  const last = state.lastFetch || {};
  const stale = (k) => !last[k] || nowMs - Date.parse(last[k]) > staleMs;
  return {
    reply: !state.seeded || (unread?.reply || 0) > 0 || stale('reply'),
    like: !state.seeded || (unread?.like || 0) > 0 || stale('like'),
    fans: !state.seeded || (fanCount != null && state.fanCount != null && fanCount > state.fanCount) || state.fanCount == null,
  };
}

/** 把这一轮拉到的并进去。返回 { state, news: { reply:[], like:[], follow:[] } }。 */
export function mergeInbox(prev, got, nowIso) {
  const s = { ...emptyInbox(), ...prev, items: [...(prev?.items || [])], fans: [...(prev?.fans || [])], lastFetch: { ...(prev?.lastFetch || {}) } };
  const first = !s.seeded;
  const have = new Set(s.items.map((x) => x.id));
  const news = { reply: [], like: [], follow: [] };
  const add = (kind, x) => {
    if (!x?.id || have.has(x.id)) return;
    have.add(x.id);
    const item = { ...x, kind, seen: first, got: nowIso };
    s.items.push(item);
    if (!first) news[kind].push(item);
  };
  if (got.replies) { (got.replies || []).forEach((x) => add('reply', x)); s.lastFetch.reply = nowIso; }
  if (got.likes) {
    // 点赞通知会累加（同一条又多了人赞）：id 带上人数，人数变了算一条新的，旧的那条去掉
    for (const x of got.likes || []) {
      const id = `${x.id}:${x.count || 1}`;
      if (have.has(id)) continue;
      s.items = s.items.filter((y) => !(y.kind === 'like' && String(y.id).split(':')[0] === String(x.id)));
      add('like', { ...x, id });
    }
    s.lastFetch.like = nowIso;
  }
  if (got.fans) {
    const known = new Set(s.fans);
    for (const f of got.fans) {
      if (!f?.mid || known.has(f.mid)) continue;
      known.add(f.mid); s.fans.push(f.mid);
      if (!first) add('follow', { id: `f${f.mid}`, who: f.who, at: f.at || nowIso });
    }
    s.fans = s.fans.slice(-MAX_FANS);
    s.lastFetch.fans = nowIso;
  }
  if (got.fanCount != null) s.fanCount = got.fanCount;
  s.items = s.items.slice(-MAX_ITEMS);
  s.seeded = true; s.lastPoll = nowIso;
  return { state: s, news };
}

/** 新东西 → 写进「今天」的话（一类一条，不刷屏）+ 心情。外人的话截短、加引号。 */
export function newsEvents(news) {
  const out = [];
  const q = (t, n = 24) => `「${String(t || '').slice(0, n)}${String(t || '').length > n ? '…' : ''}」`;
  if (news.reply.length) {
    const r = news.reply[0];
    out.push({ kind: 'inbox-reply', text: news.reply.length > 1 ? `B站上有 ${news.reply.length} 条回复是给本鱼的，${r.who} 说${q(r.text)}` : `B站上 ${r.who} 回了本鱼${r.mine ? `那句${q(r.mine, 12)}` : ''}：${q(r.text)}`, mood: Math.min(8, 3 + news.reply.length) });
  }
  if (news.like.length) {
    const n = news.like.reduce((a, x) => a + (x.count || 1), 0);
    out.push({ kind: 'inbox-like', text: `本鱼在 B站说的话被${news.like[0].who}${n > 1 ? ` 等 ${n} 人` : ''}点赞了`, mood: Math.min(6, 2 + news.like.length) });
  }
  if (news.follow.length) {
    out.push({ kind: 'inbox-follow', text: `B站上多了 ${news.follow.length} 个粉丝：${news.follow.slice(0, 3).map((x) => x.who).join('、')}${news.follow.length > 3 ? ' 等' : ''}`, mood: Math.min(8, 4 + news.follow.length) });
  }
  return out;
}

/** 每条足迹收到几个赞、几条回复（按她原来那句话对上）。 */
export function footStats(footprints, items) {
  const out = {};
  for (const f of footprints || []) {
    const key = norm(f.text); if (!key) continue;
    const st = { replies: 0, likes: 0 };
    for (const x of items || []) {
      const mine = norm(x.mine);
      if (!mine || !(key.startsWith(mine) || mine.startsWith(key))) continue;
      if (x.kind === 'reply') st.replies += 1;
      else if (x.kind === 'like') st.likes += x.count || 1;
    }
    if (st.replies || st.likes) out[f.id] = st;
  }
  return out;
}
