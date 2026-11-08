// A3 · 收藏进她的收藏夹（默认「她喜欢的」，没有就建一个公开的）
import { defineTool } from '../define.js';
import { writeReadyFor, viewOf, clean, sentReceipt } from '../bili-common.js';

const CAP = { key: 'collectsPerDay', label: '每天最多收藏几个', levels: { 少: 2, 适中: 5, 多: 10 }, max: 20 };
export const FAV_TITLE = '她喜欢的';

/** 找到 / 建好「她喜欢的」收藏夹，返回 id。 */
async function favFolderId({ biliRead, biliWrite, acts }) {
  const cached = acts.favFolder(); if (cached) return cached;
  const mid = biliRead.myMid();
  const list = await biliRead.raw('/x/v3/fav/folder/created/list-all', { up_mid: mid });
  const found = (list?.list || []).find((f) => f.title === FAV_TITLE);
  if (found) { acts.setFavFolder(found.id); return String(found.id); }
  const r = await biliWrite.raw('/x/v3/fav/folder/add', { title: FAV_TITLE, intro: '鱼社里的小鱼收藏的视频', privacy: 0 });
  if (r.status !== 'sent' || !r.data?.id) throw new Error(`建收藏夹没成功：${r.reason || '没拿到 id'}`);
  acts.setFavFolder(r.data.id);
  return String(r.data.id);
}

export default defineTool({
  name: 'bili_collect',
  kind: 'act',
  description: `把一个视频收藏进你自己 B站号的收藏夹（默认放进「${FAV_TITLE}」，没有就自动建一个公开的）。想以后再看、或者特别喜欢时用；每天有上限，同一个视频不会重复收。给 BV 号。`,
  params: { bvid: { type: 'string', description: 'BV 号', required: true }, folder: { type: 'string', description: '收藏夹 id（不给 = 「她喜欢的」）' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/view' }, { host: 'api', method: 'GET', path: '/x/v3/fav/folder/created/list-all', login: true }, { host: 'api', method: 'POST', path: '/x/v3/fav/folder/add', login: true, csrf: true }, { host: 'api', method: 'POST', path: '/x/v3/fav/resource/deal', login: true, csrf: true }],
  readCost: 2,
  cap: CAP,
  receipt: sentReceipt,
  footprint: true,
  async run(a, deps) {
    const no = writeReadyFor(deps); if (no) return no;
    const { biliRead, biliWrite, acts } = deps;
    const v = await viewOf(biliRead, String(a.bvid || ''));
    if (acts.done(`collect:${v.bvid}`)) return { ok: true, already: true, hint: '之前已经收藏过了' };
    const lim = deps.habits.get().collectsPerDay ?? 0, used = acts.countToday('collect');
    if (used >= lim) return { ok: false, capped: true, error: lim ? `今天收藏已经 ${used} 次了（每天最多 ${lim}）` : `上网配置里「${CAP.label}」是 0` }; // 到上限就别去建收藏夹了
    const folder = /^\d{1,20}$/.test(String(a.folder || '')) ? String(a.folder) : await favFolderId(deps);
    return acts.act('collect', {
      cap: CAP, key: `collect:${v.bvid}`, receipt: sentReceipt,
      run: () => biliWrite.raw('/x/v3/fav/resource/deal', { rid: v.aid, type: 2, add_media_ids: folder, del_media_ids: '' }, { referer: `https://www.bilibili.com/video/${v.bvid}` }),
      footprint: { text: clean(v.title, 60), url: `https://www.bilibili.com/video/${v.bvid}`, target: { bvid: v.bvid, title: clean(v.title, 60), folder } },
    });
  },
});
