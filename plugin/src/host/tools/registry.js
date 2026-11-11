/**
 * 工具注册表（F-59）：把 tools/<类别>/*.js 汇总成一张表，再分给两个出口——
 *   出口 A：DSH 主会话（registerYusheTools → ctx.tools.register）
 *   出口 B：她自己的出门循环（toolsFor('trip')，任务 51 接）
 * 同时从表里生成 B站接口白名单（readPaths / writePaths），bili-read / bili-write 只认白名单里的路径。
 *
 * 加一个工具 = 在 tools/<类别>/ 下加一个文件；_all.js 由 `npm run build`（plugin/scripts/gen-tools.mjs）重新生成。
 *
 * 宿主的 tools.register 只收「成品」定义（defineTool 在宿主包里拿不到）：parameters 是 JSON Schema、
 * output 必须有 schema + render；参数不会替我们校验，run 里自己校验。返回值要是无损 JSON。
 */
import ALL from './_all.js';
import { checkTools, EXTERNAL_NOTE } from './define.js';

export const TOOLS = ALL;

const OUTPUT = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: (() => { try { return JSON.stringify(value ?? { ok: false }, null, 2).slice(0, 12000); } catch { return '{"ok":false}'; } })() }],
};
const safe = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch { return { ok: false, error: '结果无法序列化' }; } };

/** 某个出口能用的工具。kinds 给了就只留这几种（梦游只给 read，F-79）。 */
export const toolsFor = (from, tools = TOOLS, kinds = null) => tools.filter((t) => t.expose?.[from] && (!kinds || kinds.includes(t.kind)));

/** 互动 / 说话工具声明的每天上限（并进细配置的「互动上限」组，见 shared/habits.js schemaWith）。 */
export const capsOf = (tools = TOOLS) => tools.filter((t) => t.cap?.key).map((t) => t.cap);

/** 说话工具声明的闸门类型：{ kind: { name, min, max } }（并进 gate 的 KINDS）。 */
export const draftKindsOf = (tools = TOOLS) => Object.fromEntries(tools.filter((t) => t.kind === 'speak' && t.draft?.kind).map((t) => [t.draft.kind, { name: t.draft.name, min: t.draft.min, max: t.draft.max }]));
/** 说话工具的发法：{ kind: (draft, {biliRead, biliWrite}) => bili-write 结果 }（评论 / 动态 / 私信是闸门自带的，不用给）。 */
export const sendersOf = (tools = TOOLS) => Object.fromEntries(tools.filter((t) => t.kind === 'speak' && t.draft?.kind && typeof t.send === 'function').map((t) => [t.draft.kind, t.send]));
/** 说话类型对应的每天上限字段。 */
export const capKeysOf = (tools = TOOLS) => Object.fromEntries(tools.filter((t) => t.kind === 'speak' && t.draft?.kind && t.cap?.key).map((t) => [t.draft.kind, t.cap.key]));

/** 表里所有声明过的 B站接口。 */
export const endpointsOf = (tools = TOOLS) => tools.flatMap((t) => (t.endpoints || []).map((e) => ({ ...e, tool: t.name })));
/** 白名单：{ api: Set(path), vc: Set(path) }，method 过滤。 */
export function pathsOf(method, tools = TOOLS) {
  const out = { api: new Set(), vc: new Set() };
  for (const e of endpointsOf(tools)) if (e.method === method) out[e.host].add(e.path);
  return out;
}

/** 跑一个工具：统一兜错、外部内容加提示、返回无损 JSON。 */
export async function runTool(tool, args, deps, from = 'main') {
  try {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const r = await tool.run(a, deps, { from });
    if (tool.kind === 'read' && deps?.ledger) deps.ledger.note(tool.name, a, r); // G2：读账，写正文时对证据
    return safe(tool.external && r && typeof r === 'object' && r.ok !== false ? { ...r, note: r.note ? `${r.note}；${EXTERNAL_NOTE}` : EXTERNAL_NOTE } : r); // 工具自己的 note 不被盖掉
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 300) }; }
}

/** 给某个出口的「成品」定义（verify 和出门循环用）。 */
export function yusheToolDefs(deps, { from = 'main', tools = TOOLS, kinds = null } = {}) {
  return toolsFor(from, tools, kinds).map((t) => ({
    name: t.name, kind: t.kind, description: from === 'trip' ? (t.tripDescription || t.description) : t.description, parameters: from === 'trip' ? t.tripParameters : t.parameters,
    execute: (args) => runTool(t, args, deps, from),
  }));
}

/** 注册到宿主（没有 tools 服务就不注册，不影响其他功能）。 */
export function registerYusheTools(ctx, deps) {
  if (typeof ctx.inject !== 'function') return false;
  const problems = checkTools(TOOLS);
  if (problems.length) deps.log?.warn?.(`[dsh-yushe] 工具表有问题：${problems.join('；')}`);
  ctx.inject(['tools'], (scope) => {
    const defs = yusheToolDefs(deps, { from: 'main' });
    for (const def of defs) {
      scope.effect(() => scope.tools.register({ name: def.name, description: def.description, parameters: def.parameters, output: OUTPUT, execute: def.execute }), `dsh-yushe: tool ${def.name}`);
    }
    deps.log?.info?.(`[dsh-yushe] 已注册 ${defs.length} 个 DSH 工具：${defs.map((d) => d.name).join(' / ')}`);
  });
  return true;
}
