// R11 · 分区表（静态）
import { defineTool } from '../define.js';
import { ZONES } from '../bili-common.js';

export default defineTool({
  name: 'bili_zones',
  kind: 'read',
  description: '列出 B站的主分区（名字和 id），给 bili_rank 选分区、给配置里「多看 / 少看的分区」用。不联网、不占读次数。',
  async run() { return { ok: true, zones: ZONES.map(([name, rid]) => ({ name, rid })) }; },
});
