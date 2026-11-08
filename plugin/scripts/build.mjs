#!/usr/bin/env node
// 鱼社 · 构建
//   src/host   → lib/index.js   （Node ESM，宿主端）
//   src/client → lib/client.js  （包进 window.__ModuleLoader__.load，React 由宿主提供）
//   src/game   → game/          （iframe 里的游戏：game.js 打包 Pixi/GSAP/inkjs/共享逻辑；index.html、立绘、字体原样拷）
// 用法：node plugin/scripts/build.mjs [--watch]
import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Compiler } from 'inkjs/full';
import { writeToolsIndex } from './gen-tools.mjs';

// 工具表：每次构建前按 tools/<类别>/*.js 重新生成 _all.js（F-59）
if (writeToolsIndex()) console.log('✓ 已更新 tools/_all.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..');
const watch = process.argv.includes('--watch');
const ID = 'dsh-plugin-yushe'; // ModuleLoader id = npm 包名（和别的 DSH 插件一样）

const host = {
  entryPoints: [join(root, 'src/host/index.js')],
  outfile: join(root, 'lib/index.js'),
  bundle: true,
  preserveSymlinks: true, // worktree 里 node_modules 可能是软链：别把真实绝对路径烘进产物
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  // 打进来的 CommonJS 依赖（qrcode）会 require('fs') 之类的内置模块；ESM 产物里没有 require，补一个
  banner: { js: "// dsh-yushe host bundle — 由 plugin/scripts/build.mjs 生成，勿手改\nimport { createRequire as __yusheCreateRequire } from 'node:module';\nconst require = __yusheCreateRequire(import.meta.url);" },
};

// 浏览器端：IIFE 包在 factory(require) 里。React 标成 external → esbuild 生成 __require("react")，
// 运行时落到 factory 的 require 参数上（宿主 ModuleLoader 提供），所以 React 不会被打进产物。
const client = {
  entryPoints: [join(root, 'src/client/index.js')],
  outfile: join(root, 'lib/client.js'),
  bundle: true,
  preserveSymlinks: true, // worktree 里 node_modules 可能是软链：别把真实绝对路径烘进产物
  platform: 'browser',
  format: 'iife',
  globalName: '__dshYushe',
  target: 'es2020',
  external: ['react', 'react-dom'],
  legalComments: 'none',
  banner: { js: `// dsh-yushe client bundle — 由 plugin/scripts/build.mjs 生成，勿手改\nwindow.__ModuleLoader__.load({ id: '${ID}', factory(require) {` },
  footer: { js: 'return __dshYushe.default;\n} });' },
};

// .ink 剧本：构建时编译成 JSON，编译错误直接让构建失败（带行号）
const inkPlugin = {
  name: 'ink',
  setup(b) {
    b.onLoad({ filter: /\.ink$/ }, (args) => {
      const errors = [];
      const compiler = new Compiler(readFileSync(args.path, 'utf8'), { errorHandler: (msg, type) => { if (type === 2) errors.push(msg); } });
      let json;
      try { json = compiler.Compile().ToJson(); } catch (e) { errors.push(String(e?.message || e)); }
      if (errors.length || !json) return { errors: errors.map((text) => ({ text: `ink: ${text}` })) };
      return { contents: `export default ${json};`, loader: 'js' };
    });
  },
};

const game = {
  entryPoints: [join(root, 'src/game/main.js')],
  outfile: join(root, 'game/game.js'),
  bundle: true,
  preserveSymlinks: true, // worktree 里 node_modules 可能是软链：别把真实绝对路径烘进产物
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  plugins: [inkPlugin],
  banner: { js: '// dsh-yushe game bundle — 由 plugin/scripts/build.mjs 生成，勿手改' },
};

/** 拷游戏的静态文件：页面、立绘（渔娘 + 本鱼姿势）、字体（只拷 woff2，改写样式表路径）。 */
function copyGameStatic() {
  const out = join(root, 'game');
  const assets = join(out, 'assets');
  rmSync(assets, { recursive: true, force: true });
  mkdirSync(join(assets, 'benyu'), { recursive: true });
  mkdirSync(join(assets, 'font'), { recursive: true });
  // 缓存：index.html 不缓存，game.js 带内容哈希，改了就换地址（不会吃到旧版本）
  const gameJs = join(out, 'game.js');
  const v = existsSync(gameJs) ? createHash('sha1').update(readFileSync(gameJs)).digest('hex').slice(0, 10) : String(Date.now());
  writeFileSync(join(out, 'index.html'), readFileSync(join(root, 'src/game/index.html'), 'utf8').replace('src="./game.js"', `src="./game.js?v=${v}"`));
  const art = join(repo, '美术/assets');
  for (const f of readdirSync(art)) if (/^(girl|head|sleep)-\w+\.webp$/.test(f)) copyFileSync(join(art, f), join(assets, f));
  // 动作库（F-67）：assets/pose/<鱼种>/<姿势>.webp + 一份清单，游戏按清单知道每位角色有哪些姿势（没有的回落站姿）
  const poseManifest = {};
  if (existsSync(join(art, 'pose'))) {
    for (const id of readdirSync(join(art, 'pose'))) {
      const dir = join(art, 'pose', id);
      if (!/^[a-z]+$/.test(id)) continue;
      const files = readdirSync(dir).filter((f) => /^[a-z]+\.webp$/.test(f));
      if (!files.length) continue;
      mkdirSync(join(assets, 'pose', id), { recursive: true });
      for (const f of files) copyFileSync(join(dir, f), join(assets, 'pose', id, f));
      poseManifest[id] = files.map((f) => f.replace('.webp', '')).sort();
    }
  }
  mkdirSync(join(assets, 'pose'), { recursive: true });
  writeFileSync(join(assets, 'pose', 'manifest.json'), JSON.stringify(poseManifest));
  mkdirSync(join(assets, 'icons'), { recursive: true });
  for (const f of readdirSync(join(art, 'icons'))) if (f.endsWith('.webp')) copyFileSync(join(art, 'icons', f), join(assets, 'icons', f));
  mkdirSync(join(assets, 'prop'), { recursive: true });
  for (const f of readdirSync(join(art, 'prop'))) if (f.endsWith('.webp')) copyFileSync(join(art, 'prop', f), join(assets, 'prop', f));
  for (const f of readdirSync(join(art, 'benyu'))) if (f.endsWith('.webp')) copyFileSync(join(art, 'benyu', f), join(assets, 'benyu', f));
  mkdirSync(join(assets, 'bg'), { recursive: true });
  for (const f of readdirSync(join(art, 'bg'))) if (f.endsWith('.webp')) copyFileSync(join(art, 'bg', f), join(assets, 'bg', f));
  const fontPkg = join(repo, 'node_modules/@fontsource/zcool-kuaile');
  if (existsSync(fontPkg)) {
    const css = readFileSync(join(fontPkg, 'index.css'), 'utf8')
      .replace(/,\s*url\(\.\/files\/[^)]+\.woff\)\s*format\('woff'\)/g, '')
      .replaceAll('./files/', './font/');
    writeFileSync(join(assets, 'font.css'), css);
    for (const f of readdirSync(join(fontPkg, 'files'))) if (f.endsWith('.woff2')) copyFileSync(join(fontPkg, 'files', f), join(assets, 'font', f));
  }
}

if (watch) {
  copyGameStatic();
  const ctxs = await Promise.all([esbuild.context(host), esbuild.context(client), esbuild.context(game)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('👀 watching plugin/src …（改 index.html / 立绘后重跑一次 build 拷静态文件）');
} else {
  const t = Date.now();
  await Promise.all([esbuild.build(host), esbuild.build(client), esbuild.build(game)]);
  copyGameStatic();
  console.log(`✓ built plugin/lib/{index,client}.js + plugin/game/ in ${Date.now() - t}ms`);
}
