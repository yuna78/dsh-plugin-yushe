#!/usr/bin/env node
// 鱼社 · npm run smoke：打本机运行中 DSH 实例的 /api/dsh-yushe/status。
// 端口：环境变量 YUSHE_URL（如 http://127.0.0.1:3000），否则读 AGENTS.local.md 里的 `YUSHE_URL=`，再否则 http://127.0.0.1:3000
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let base = process.env.YUSHE_URL;
const local = join(root, 'AGENTS.local.md');
if (!base && existsSync(local)) base = readFileSync(local, 'utf8').match(/YUSHE_URL=(\S+)/)?.[1];
base = (base || 'http://127.0.0.1:3000').replace(/\/$/, '');

try {
  const r = await fetch(`${base}/api/dsh-yushe/status`, { headers: { accept: 'application/json' } });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`不是 JSON（HTTP ${r.status}）——插件可能没加载，返回的是宿主页面：${text.slice(0, 80)}`); }
  if (!j.ok) throw new Error(JSON.stringify(j));
  console.log(`✓ ${base} → ${j.plugin} ${j.version}`);
  console.log(`  宿主模型服务：${j.host.llm ? '可用' : '拿不到'} · 默认模型：${j.host.defaultModel ? `${j.host.defaultModel.provider}/${j.host.defaultModel.model}` : '未选择'} · agents：${j.host.agents ? '可用' : '拿不到'} · B站：${j.bili.loggedIn ? '已登录' : '未登录'}`);
} catch (e) {
  console.error(`✗ smoke 失败（${base}）：${e.message}`);
  process.exit(1);
}
