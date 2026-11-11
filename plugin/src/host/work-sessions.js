/**
 * 她在哪些对话里上工、干了几次活（F-63）。
 *
 * 以前：人设段落每被拼一次就算「干了一次活」——可 DSH 每走一步（每次调工具）、子任务、压缩、别的插件的自动化
 * 都会拼系统提示，刚出生几分钟就记了上百次；人设也被塞进别的插件的自动化里。
 *
 * 现在：听宿主的 `agent/inbox/claimed`（一条消息进入一轮对话时发，带 agent = 那个会话）。
 *   - 浏览器里人打的字：source.kind === 'user' 且带 rpcId → 算一次活，并记下这个会话是「爸妈开的」
 *   - 从外部聊天渠道私聊进来的人话：source.kind === 'user' 且声明了 channel（比如 QQ 私聊）→ 同上。
 *     群聊（chatType === 'group'）不算：一个会话里混着别人，家里的记忆不能进去
 *   - 子任务 / 定时任务 / 压缩 / 别的插件塞的消息：都不是这个样子 → 不算，也不记。
 *     注意只看 kind 不够：任务板、做 PPT 的审稿子任务发的就是光秃秃的 { kind: 'user' }
 * 人设和近况两段只在记下来的会话里出现（`inUserSession(assembleContext)`）。
 * 绑了工作区（F-64）：只有她那个工作区里的会话才算、才放人设；没绑（null）就所有工作区都算。
 * 宿主太旧、拼装时不带 agent 的话，退回老办法（照样注入），免得她整个消失。
 */
import { inWorkspace, cwdOfAgent } from './workspaces.js';
import { nowMs } from './clock.js';

const filled = (v) => typeof v === 'string' && v.length > 0;
export const isTypedByUser = (message) => {
  const s = message?.source;
  if (s?.kind !== 'user') return false;
  return filled(s.rpcId) || (filled(s.channel) && s.chatType !== 'group');
};

/* 五期-1（F-95）：爸妈这一句只在内存里存一份，只当检索词用一次——不写文件、不进日志、不进档案、不打印。
 * 主会话的 context 每一步都会重算，但那句拿不到（探针结果），只能在这里从 agent/inbox/claimed 顺手记下；
 * 用完即丢的意思：不落任何盘，实例重启就没了。 */
const LAST_TYPED_MAX = 200; // 最多记 200 个会话，满了丢最老的

export function createWorkSessions({ ctx, pond, life, log }) {
  const userSessions = new Set();
  const track = (agent) => { if (agent?.id) { userSessions.add(String(agent.id)); if (userSessions.size > 2000) userSessions.delete(userSessions.values().next().value); } };
  const lastTypedMap = new Map(); // agentId → { text, at }
  /** 记下这个会话里爸妈最新亲手打的一句（text 块拼起来，截前 200 字）。 */
  const rememberTyped = (agentId, message) => {
    const text = (Array.isArray(message?.content) ? message.content : [])
      .filter((b) => b?.type === 'text')
      .map((b) => String(b?.text ?? ''))
      .join('')
      .slice(0, 200);
    if (!text) return;
    const id = String(agentId);
    lastTypedMap.delete(id); // 重新插到队尾：最近还在说话的会话不算最老
    lastTypedMap.set(id, { text, at: nowMs() });
    if (lastTypedMap.size > LAST_TYPED_MAX) lastTypedMap.delete(lastTypedMap.keys().next().value);
  };
  const ws = {
    /** 宿主事件：一条消息进了一轮。人打的字 → 记会话 + 算一次活。 */
    onClaimed(payload) {
      if (!isTypedByUser(payload?.message)) return false;
      track(payload.agent);
      const f = pond.current();
      if (!f || !inWorkspace(cwdOfAgent(payload.agent), f.workspace)) return false; // 别的工作区的对话不算她的活
      if (payload.agent?.id) rememberTyped(payload.agent.id, payload.message); // 和 bumpWork 同一道关：工作区不对的也不记这一句
      try { life.bumpWork(f); } catch { /* 记账失败不影响对话 */ }
      return true;
    },
    /** 这次拼系统提示是不是爸妈开的对话里的（不是就不放人设）。 */
    inUserSession(context) {
      const agent = context?.agent;
      if (!agent) return !context?.scope; // 老宿主：拼装不带 agent → 照旧注入；带了 scope 却没有 agent 的（别的东西）不注入
      if (!userSessions.has(String(agent.id))) return false;
      return inWorkspace(cwdOfAgent(agent), pond.current()?.workspace || null);
    },
    /** 五期-1：这个会话里爸妈最新亲手打的一句（没有 / 不是这个会话 → null）。子任务、任务板、别的插件塞的话不会在这里。 */
    lastTyped(agentId) {
      if (agentId == null) return null;
      const x = lastTypedMap.get(String(agentId));
      return x ? { ...x } : null;
    },
    size: () => userSessions.size,
  };
  if (typeof ctx?.on === 'function') {
    try { ctx.on('agent/inbox/claimed', (payload) => { ws.onClaimed(payload); }); } catch (e) { log?.warn?.(`[dsh-yushe] 听不到对话事件：${e?.message || e}`); }
  }
  return ws;
}
