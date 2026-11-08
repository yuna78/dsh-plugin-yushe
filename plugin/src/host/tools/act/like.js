// A1 · 给视频点赞 / 取消
import { defineTool } from '../define.js';
import { writeReadyFor, viewOf, clean, sentReceipt } from '../bili-common.js';

const CAP = { key: 'likesPerDay', label: '每天最多点赞几个视频', levels: { 少: 5, 适中: 15, 多: 30 }, max: 50 };

export default defineTool({
  name: 'bili_like',
  kind: 'act',
  description: '用你自己的 B站号给一个视频点赞（undo=true 是取消点赞）。真心喜欢才点；每天有上限，同一个视频不会重复点。点了会记进你的足迹，B站上真的看得到。给 BV 号。',
  params: { bvid: { type: 'string', description: 'BV 号', required: true }, undo: { type: 'boolean', description: '取消点赞' } },
  endpoints: [{ host: 'api', method: 'GET', path: '/x/web-interface/view' }, { host: 'api', method: 'POST', path: '/x/web-interface/archive/like', login: true, csrf: true }],
  readCost: 1,
  cap: CAP,
  receipt: sentReceipt,
  footprint: true,
  async run(a, deps) {
    const no = writeReadyFor(deps); if (no) return no;
    const { biliRead, biliWrite, acts } = deps;
    const v = await viewOf(biliRead, String(a.bvid || ''));
    const undo = a.undo === true;
    return acts.act(undo ? 'unlike' : 'like', {
      cap: undo ? null : CAP, key: undo ? null : `like:${v.bvid}`, undoKey: undo ? `like:${v.bvid}` : null, receipt: sentReceipt, already: undo ? [65004] : [65006],
      run: () => biliWrite.raw('/x/web-interface/archive/like', { bvid: v.bvid, like: undo ? 2 : 1 }, { referer: `https://www.bilibili.com/video/${v.bvid}` }),
      footprint: undo ? null : { text: clean(v.title, 60), url: `https://www.bilibili.com/video/${v.bvid}`, target: { bvid: v.bvid, title: clean(v.title, 60) } },
    });
  },
});
