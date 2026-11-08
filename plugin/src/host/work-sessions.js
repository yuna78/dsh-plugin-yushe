/**
 * 她在哪些对话里上工、干了几次活（F-63）。
 *
 * 以前：人设段落每被拼一次就算「干了一次活」——可 DSH 每走一步（每次调工具）、子任务、压缩、别的插件的自动化
 * 都会拼系统提示，刚出生几分钟就记了上百次；人设也被塞进别的插件的自动化里。
 *
 * 现在：听宿主的 `agent/inbox/claimed`（一条消息进入一轮对话时发，带 agent = 那个会话）。
 *   - 浏览器里人打的字：source.kind === 'user' 且带 rpcId → 算一次活，并记下这个会话是「爸妈开的」
 *   - 子任务 / 定时任务 / 压缩 / 别的插件塞的消息：都不是这个样子 → 不算，也不记
 * 人设和近况两段只在记下来的会话里出现（`inUserSession(assembleContext)`）。
 * 绑了工作区（F-64）：只有她那个工作区里的会话才算、才放人设；没绑（null）就所有工作区都算。
 * 宿主太旧、拼装时不带 agent 的话，退回老办法（照样注入），免得她整个消失。
 */
import { inWorkspace, cwdOfAgent } from './workspaces.js';

export const isTypedByUser = (message) => message?.source?.kind === 'user' && typeof message.source.rpcId === 'string' && message.source.rpcId.length > 0;

export function createWorkSessions({ ctx, pond, life, log }) {
  const userSessions = new Set();
  const track = (agent) => { if (agent?.id) { userSessions.add(String(agent.id)); if (userSessions.size > 2000) userSessions.delete(userSessions.values().next().value); } };
  const ws = {
    /** 宿主事件：一条消息进了一轮。人打的字 → 记会话 + 算一次活。 */
    onClaimed(payload) {
      if (!isTypedByUser(payload?.message)) return false;
      track(payload.agent);
      const f = pond.current();
      if (!f || !inWorkspace(cwdOfAgent(payload.agent), f.workspace)) return false; // 别的工作区的对话不算她的活
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
    size: () => userSessions.size,
  };
  if (typeof ctx?.on === 'function') {
    try { ctx.on('agent/inbox/claimed', (payload) => { ws.onClaimed(payload); }); } catch (e) { log?.warn?.(`[dsh-yushe] 听不到对话事件：${e?.message || e}`); }
  }
  return ws;
}
