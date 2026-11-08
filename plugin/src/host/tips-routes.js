/**
 * 小贴士（F-42）：记住你看过哪几条、来过几次房间。
 *   GET  /api/dsh-yushe/tips          {seen, visits, chats, tips:[{id,text,pose}], kb:[[标题, 内容]]}
 *   POST /api/dsh-yushe/tips          {seen: id} 标记看过 / {visit: true} 进房间一次 / {reset: true} 全部重新显示
 * 存储 <storage>/tips.json。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonBody } from './game-routes.js';
import { nowDate } from './clock.js';
import { TIPS, KB } from '../shared/tips.js';

export const TIPS_PATH = '/api/dsh-yushe/tips';

export function registerTipsRoutes({ scope, pond, life, storage, isLoopbackRequest, writeJson }) {
  const file = join(storage, 'tips.json');
  const load = () => { try { const j = JSON.parse(readFileSync(file, 'utf8')); return { seen: Array.isArray(j.seen) ? j.seen : [], visits: Number(j.visits) || 0 }; } catch { return { seen: [], visits: 0 }; } };
  const save = (s) => { mkdirSync(storage, { recursive: true }); const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify({ ...s, at: nowDate().toISOString() }, null, 2)); renameSync(tmp, file); };
  const ids = new Set(TIPS.map((t) => t.id));
  scope.effect(() => scope.webServer.register({
    kind: 'exact', path: TIPS_PATH,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
      const s = load();
      if (req.method === 'GET') {
        const f = pond.current() || pond.list().fish.at(-1);
        const chats = f ? (life.state(f).events || []).filter((e) => e.kind === 'chat').length : 0;
        return writeJson(res, 200, { ok: true, ...s, chats, tips: TIPS.map(({ id, text, pose }) => ({ id, text, pose })), kb: KB });
      }
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
      const b = await readJsonBody(req);
      if (!b) return writeJson(res, 400, { ok: false, error: '请求格式不对' });
      if (b.reset) s.seen = [];
      if (b.visit) s.visits += 1;
      if (b.seen && ids.has(b.seen) && !s.seen.includes(b.seen)) s.seen.push(b.seen);
      save(s);
      writeJson(res, 200, { ok: true, ...s });
    },
  }), 'dsh-yushe: tips route');
}
