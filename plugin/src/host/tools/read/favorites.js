// R19 · 她的收藏夹
import { defineTool } from '../define.js';
import { readyFor, limitOf, clean, okBv } from '../bili-common.js';

export default defineTool({
  name: 'bili_favorites',
  kind: 'read',
  external: true,
  description: '看你（她的 B站号）的收藏夹：不给 folder 就列出所有收藏夹（id、名字、几个）；给 folder（收藏夹 id）就看里面收了哪些视频。只读。',
  params: { folder: { type: 'string', description: '收藏夹 id（不给 = 列出收藏夹）' }, limit: { type: 'integer', description: '最多几条（默认 10，最多 20）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/v3/fav/folder/created/list-all', login: true }, { host: 'api', method: 'GET', path: '/x/v3/fav/resource/list', login: true }],
  readCost: 1,
  async run(a, { biliRead }) {
    const no = readyFor(biliRead); if (no) return no;
    const mid = biliRead.myMid(); if (!mid) return { ok: false, error: '拿不到她的 B站号' };
    if (!a.folder) {
      const d = await biliRead.raw('/x/v3/fav/folder/created/list-all', { up_mid: mid });
      return { ok: true, folders: (d?.list || []).map((f) => ({ id: String(f.id), name: clean(f.title, 30), count: f.media_count || 0 })), usage: biliRead.usage() };
    }
    if (!/^\d{1,20}$/.test(String(a.folder))) return { ok: false, error: '收藏夹 id 要是一串数字' };
    const n = limitOf(a.limit, 10, 20);
    const d = await biliRead.raw('/x/v3/fav/resource/list', { media_id: a.folder, ps: n, pn: 1 });
    return { ok: true, folder: clean(d?.info?.title, 30), videos: (d?.medias || []).filter((m) => okBv(m.bvid)).map((m) => ({ title: clean(m.title), bvid: m.bvid, up: clean(m.upper?.name, 30), url: `https://www.bilibili.com/video/${m.bvid}` })), usage: biliRead.usage() };
  },
});
