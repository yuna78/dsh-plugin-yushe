#!/usr/bin/env node
// 鱼社 · 生成 plugin/src/host/tools/_all.js：扫 tools/<类别>/*.js，按路径排好写成静态 import（esbuild 打包要静态 import）。
// build.mjs 每次构建前调用；verify 用 genToolsIndex() 比对，过期就失败。
// 用法：node plugin/scripts/gen-tools.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TOOLS_DIR = join(root, 'src/host/tools');
export const INDEX_FILE = join(TOOLS_DIR, '_all.js');
const CATS = ['self', 'read', 'act', 'speak'];

/** 现在目录里该有的 _all.js 内容。 */
export function genToolsIndex() {
  const files = CATS.flatMap((c) => (existsSync(join(TOOLS_DIR, c)) ? readdirSync(join(TOOLS_DIR, c)).filter((f) => /^[a-z0-9-]+\.js$/.test(f)).sort().map((f) => `${c}/${f}`) : []));
  const lines = files.map((f, i) => `import t${i} from './${f}';`);
  return `// 由 plugin/scripts/gen-tools.mjs 生成，勿手改（npm run build 会重新生成）。加工具 = 在 tools/<类别>/ 下加文件。\n${lines.join('\n')}\n\nexport default [${files.map((_, i) => `t${i}`).join(', ')}];\n`;
}

export function writeToolsIndex() {
  const next = genToolsIndex();
  const cur = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : '';
  if (cur !== next) writeFileSync(INDEX_FILE, next);
  return cur !== next;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(writeToolsIndex() ? '✓ 已更新 tools/_all.js' : '· tools/_all.js 已是最新');
}
