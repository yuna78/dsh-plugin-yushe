#!/usr/bin/env node
// 鱼社 · 生成 plugin/src/prompts/_all.js：扫 src/prompts/*.md（按文件名排序），把每份去掉开头的 <!-- … --> 说明块
// 和结尾的换行，用 JSON.stringify 写成字符串常量（任何字符都安全），esbuild 打进 lib，运行时不读磁盘。
// build.mjs 每次构建前调用；verify 用 genPromptsIndex() 比对，过期就失败。
// 用法：node plugin/scripts/gen-prompts.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROMPTS_DIR = join(root, 'src/prompts');
export const INDEX_FILE = join(PROMPTS_DIR, '_all.js');

/** md → 提示词正文：去掉开头的 <!-- … --> 说明块（连同后面那个换行）和结尾的换行。 */
const strip = (t) => t.replace(/^<!--[\s\S]*?-->\n/, '').replace(/\n+$/, '');

/** 现在目录里该有的 _all.js 内容（键 = 文件名去掉 .md）。 */
export function genPromptsIndex() {
  const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md')).sort();
  const entries = files.map((f) => `  ${JSON.stringify(f.slice(0, -3))}: ${JSON.stringify(strip(readFileSync(join(PROMPTS_DIR, f), 'utf8')))}`);
  return `// 由 plugin/scripts/gen-prompts.mjs 生成，勿手改（npm run build 会重新生成）。加提示词 = 在 src/prompts/ 下加一份 md。\nexport default {\n${entries.join(',\n')},\n};\n`;
}

export function writePromptsIndex() {
  const next = genPromptsIndex();
  const cur = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : '';
  if (cur !== next) writeFileSync(INDEX_FILE, next);
  return cur !== next;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(writePromptsIndex() ? '✓ 已更新 prompts/_all.js' : '· prompts/_all.js 已是最新');
}
