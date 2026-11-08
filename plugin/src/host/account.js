/**
 * 换号不继承（规矩 G5，08 工具明细 0.5 节）：和「她的 B站号」有关的账本按 mid 分开存在 <storage>/bili/<mid>/。
 * 私信进度、收件箱进度，以后还有她自己关注的名单、回执、发言账本、读账。性格、爱好、日记这些「她自己的」不在这里。
 *
 * 换号 / 退出后旧号的账本留在原处不用；新号从零开始。
 * 老存档（还放在 <storage>/<name>）第一次读时搬进当前号的目录（那时候登录的就是这个号）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** 现在登录的是哪个号（凭证里的 DedeUserID），没登录 = null。 */
export function accountMid(storage) {
  try { const c = JSON.parse(readFileSync(join(storage, 'bili_credential.json'), 'utf8')); return /^\d{1,20}$/.test(String(c.dedeuserid || '')) ? String(c.dedeuserid) : null; } catch { return null; }
}

/** 当前号的账本文件路径；没登录就用老位置（没登录时这些账本也不会被用到）。 */
export function accountFile(storage, name) {
  const mid = accountMid(storage);
  const legacy = join(storage, name);
  if (!mid) return legacy;
  const dir = join(storage, 'bili', mid);
  const f = join(dir, name);
  if (!existsSync(f) && existsSync(legacy)) { try { mkdirSync(dir, { recursive: true }); renameSync(legacy, f); } catch { /* 搬不动就当新号 */ } }
  return f;
}
