/**
 * 她在哪个工作区上工（F-64）。领养时挑一个；设置里能换；null = 所有工作区（老鱼没选过就是这样）。
 *
 * 绑了工作区以后：那个工作区里爸妈发的每一句都算她干的活，人设和近况只放进那个工作区的对话；
 * 别的工作区里她不出现。「找她干活」直接在她的工作区开新对话。
 *
 *   GET  /api/dsh-yushe/workspaces   { list:[{id,title,path}]（最近用过的在前）, current: 当前鱼的工作区 | null }
 *   POST /api/dsh-yushe/workspaces   { workspaceId | null }  换当前鱼的工作区（id 必须是 DSH 里真有的）
 *
 * 工作区来自宿主的 workspaceRegistry（path 是 realpath）；会话属于哪个工作区看 agent.session.header.cwd。
 */
import { readJsonBody } from './game-routes.js';

export const WORKSPACES_PATH = '/api/dsh-yushe/workspaces';

/** 会话的工作目录在不在她的工作区里（null = 所有工作区都算）。 */
export function inWorkspace(cwd, ws) {
  if (!ws) return true;
  const p = String(ws.path || '').replace(/\/+$/, '');
  const c = String(cwd || '');
  if (!p || !c) return false;
  return c === p || c.startsWith(`${p}/`);
}

/** 从会话里拿工作目录。 */
export const cwdOfAgent = (agent) => agent?.session?.header?.cwd || agent?.session?.header?.meta?.cwd || null;

export function createWorkspaces({ getRegistry }) {
  const list = () => {
    let reg; try { reg = getRegistry(); } catch { reg = null; }
    if (!reg?.list) return [];
    try {
      return reg.list().filter((w) => w?.id && w.path)
        .map((w) => ({ id: String(w.id), title: String(w.title || w.path.split('/').pop() || w.path).slice(0, 40), path: String(w.path), updatedAt: String(w.updatedAt || '') }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch { return []; }
  };
  return {
    list,
    /** 按 id 找；找不到返回 null。存进鱼里的只留 id / 标题 / 路径。 */
    resolve(id) { const w = list().find((x) => x.id === String(id)); return w ? { id: w.id, title: w.title, path: w.path } : null; },
  };
}

export function registerWorkspaceRoutes({ scope, pond, workspaces, isLoopbackRequest, writeJson }) {
  scope.effect(() => scope.webServer.register({ kind: 'exact', path: WORKSPACES_PATH, handler: async (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
    const f = pond.current();
    if (req.method === 'GET') return writeJson(res, 200, { ok: true, list: workspaces.list().map(({ id, title, path }) => ({ id, title, path })), current: f?.workspace || null });
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    const b = await readJsonBody(req);
    if (!f) return writeJson(res, 200, { ok: false, error: '现在没有鱼在上工' });
    if (b?.workspaceId === null) return writeJson(res, 200, { ok: true, current: pond.setWorkspace(f.id, null).workspace || null });
    const ws = workspaces.resolve(b?.workspaceId);
    if (!ws) return writeJson(res, 200, { ok: false, error: '没有这个工作区' });
    writeJson(res, 200, { ok: true, current: pond.setWorkspace(f.id, ws).workspace });
  } }), 'dsh-yushe: workspaces route');
}
