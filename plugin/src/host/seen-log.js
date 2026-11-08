/**
 * 见闻流水账的宿主端（F-86 一期-1，docs/设计/14-见闻流水与聊天翻找.md）：每条鱼一个 JSON 文件，唯一的落地点。
 *
 *   createSeenLog({ storage, log }) →
 *     add(fish, entries)   合并一摊行（shared/seen.js 的 mergeSeen 管「取最深 / 30 天 / 每天 800 行」）
 *     query(fish, opts)    querySeen：按词 / 时间词 / 深度翻，能翻页
 *     stats(fish, opts)    seenStats：统计
 *     overview(fish, opts) seenOverview：今天的一小段文字
 *
 * 文件 <storage>/seen-<fish.id>.json（原子写：先写 tmp 再 rename，照 wallet.js）；坏文件当空账。
 * 「现在」一律用宿主时钟 clock.js 的 nowMs()；算日子 / 排序这些纯函数都在 shared/seen.js。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowMs } from './clock.js';
import { emptySeenLog, mergeSeen, querySeen, seenOverview, seenStats } from '../shared/seen.js';

export function createSeenLog({ storage, log = null } = {}) {
  const file = (id) => join(storage, `seen-${String(id ?? '').replace(/[^\w-]/g, '')}.json`);
  const load = (fish) => {
    try {
      const raw = JSON.parse(readFileSync(file(fish?.id), 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.items) ? raw : emptySeenLog(); // 坏的当空账
    } catch { return emptySeenLog(); } // 还没存过也算空账
  };
  const save = (fish, data) => {
    mkdirSync(storage, { recursive: true });
    const f = file(fish?.id);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, f);
  };
  return {
    /** 合并一摊行；返回账里现在有多少行（调用方自己 try/catch，写失败别影响回家 / 做梦）。 */
    add(fish, entries) {
      const data = mergeSeen(load(fish), entries, { now: nowMs() });
      save(fish, data);
      return data.items.length;
    },
    query(fish, opts = {}) { return querySeen(load(fish), { ...opts, now: opts.now ?? nowMs() }); },
    stats(fish, opts = {}) { return seenStats(load(fish), { ...opts, now: opts.now ?? nowMs() }); },
    overview(fish, opts = {}) { return seenOverview(load(fish), { ...opts, now: opts.now ?? nowMs() }); },
  };
}
