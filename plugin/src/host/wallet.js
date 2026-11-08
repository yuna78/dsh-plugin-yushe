/**
 * 钱包（零花钱，F-32）：她每一次自己的 AI 调用都从这里走——先看钱包，再调宿主模型，最后记账。
 *
 *   wallet.say(kind, prompt, onDelta, timeout)  花钱说话；花光了抛 BrokeError（调用方回落到规则台词）
 *   wallet.chargeTokens(kind, tokens)           记一笔已经花掉的（出门的 headless 一趟回来时记）
 *   wallet.view()                               钱包快照
 *   wallet.busy                                 正在干的事（念新闻 / 写日记 / 想事），给「她在做什么」用
 *
 *   GET  /api/dsh-yushe/allowance   钱包快照
 *   POST /api/dsh-yushe/allowance   {mode?, topUp?, daily?, jar?} 妈妈改设置
 *
 * 存储 <storage>/allowance.json。她在 DSH 里替你干活不算她的钱（那是你主会话的 token）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostSay, hostModel, logProbe } from './probe.js';
import { runToolLoop } from './trip-loop.js';
import { readJsonBody } from './game-routes.js';
import { nowDate } from './clock.js';
import { normalizeAllowance, walletView, charge, configure, usageTokens } from '../shared/allowance.js';

export const ALLOWANCE_PATH = '/api/dsh-yushe/allowance';

export class BrokeError extends Error { constructor() { super('零花钱花光了'); this.broke = true; } }

export function createWallet(ctx, storage) {
  const file = join(storage, 'allowance.json');
  const load = () => { try { return normalizeAllowance(JSON.parse(readFileSync(file, 'utf8'))); } catch { return normalizeAllowance(null); } };
  const save = (a) => { mkdirSync(storage, { recursive: true }); const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify(a, null, 2)); renameSync(tmp, file); };
  const busyNow = new Map(); // kind → 进行中的次数

  const wallet = {
    view: () => walletView(load(), nowDate()),
    get busy() { for (const k of ['news', 'diary', 'chat', 'greet']) if (busyNow.get(k)) return k; return null; },
    chargeTokens(kind, tokens) {
      const before = walletView(load(), nowDate()).level;
      const a = charge(load(), tokens, kind, nowDate()); save(a);
      const v = walletView(a, nowDate());
      if (before === 'ok' && v.level === 'low') { try { wallet.onLow?.(); } catch { /* 写信失败不影响记账 */ } }
      return v;
    },
    onLow: null,
    configure(body) { const a = configure(load(), body, nowDate()); save(a); return walletView(a, nowDate()); },
    /** 花钱说话。force：出生第一句之类不能拦的，照样记账但钱不够也说。 */
    async say(kind, prompt, onDelta, timeoutMs = 60_000, { force = false } = {}) {
      if (!force && wallet.view().broke) throw new BrokeError();
      busyNow.set(kind, (busyNow.get(kind) || 0) + 1);
      try {
        const r = await hostSay(ctx, prompt, onDelta, timeoutMs);
        const tokens = usageTokens(r.usage, prompt.length + r.text.length);
        wallet.chargeTokens(kind, tokens);
        logProbe(storage, { kind, ms: r.ms, usage: r.usage, tokens });
        return { ...r, tokens };
      } finally { busyNow.set(kind, Math.max(0, (busyNow.get(kind) || 1) - 1)); }
    },
    /** F-86 见闻-2：花一条带工具的（房间聊天）：用宿主模型 + tools 跑 runToolLoop，照 say 记账。宿主模型拿不到抛 noLoop（调用方退回老路），花光了照旧 BrokeError。 */
    async loop(kind, { prompt, system = '', tools = [], maxCalls = 4, onDelta = null, beforeCall = null, timeoutMs = 90_000 } = {}) {
      if (wallet.view().broke) throw new BrokeError();
      const { llm, provider, model } = hostModel(ctx);
      if (!llm || !provider || !model) { const e = new Error(llm ? 'DSH 里还没有选择默认模型' : '宿主模型服务 llm 拿不到'); e.noLoop = true; throw e; }
      busyNow.set(kind, (busyNow.get(kind) || 0) + 1);
      try {
        const t0 = Date.now();
        const r = await runToolLoop({ llm, provider, model, system, prompt, tools, maxCalls, timeoutMs, onDelta, beforeCall, overNote: '这句话能翻的次数用完了，别再调工具，按已经翻到的直接回答。' });
        const tokens = usageTokens(r.usage, prompt.length + (r.said?.length || r.text?.length || 0));
        wallet.chargeTokens(kind, tokens); // 每轮的 totalTokens 已在循环里累总，一次记进去
        logProbe(storage, { kind, ms: Date.now() - t0, usage: { totalTokens: r.usage?.totalTokens }, tokens, calls: r.calls.length });
        return { text: String(r.said || r.text || '').trim(), tokens, calls: r.calls, provider, model };
      } finally { busyNow.set(kind, Math.max(0, (busyNow.get(kind) || 1) - 1)); }
    },
  };
  return wallet;
}

export function registerWalletRoutes({ scope, wallet, isLoopbackRequest, writeJson }) {
  scope.effect(() => scope.webServer.register({
    kind: 'exact', path: ALLOWANCE_PATH,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' });
      if (req.method === 'GET') return writeJson(res, 200, { ok: true, ...wallet.view() });
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
      const b = await readJsonBody(req);
      if (!b) return writeJson(res, 400, { ok: false, error: '请求格式不对' });
      writeJson(res, 200, { ok: true, ...wallet.configure(b) });
    },
  }), 'dsh-yushe: allowance route');
}
