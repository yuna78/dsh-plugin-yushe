/**
 * 她说的话要有证据（规矩 G2，08 工具明细 0.5 节）。纯函数。
 *
 * 读账：她这一趟 / 这一次读到了什么（工具名 → 读到了哪一层）。宿主每次读工具成功后记一笔（tools/registry.js runTool），
 * 写正文之前拿来对：
 *   - 只读了标题简介 / 评论，就不能说「看完了」「视频里说」「听了这首」——这些要读过字幕才算数
 *   - 正文里出现的 BV 号必须是读账里有的（闸门本来就不让带链接，这里再兜一层）
 */
export const CLAIM = /(看完|看了全程|全程看|从头看到尾|视频里(说|讲|提到)|里面(说|讲|提到)|UP ?主(说|讲|提到)|听完|听了这首|听着这首|边听边)/i;

export function createLedger() {
  const seen = new Map(); // bvid → Set(层)
  const add = (bvid, layer) => { if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ''))) return; if (!seen.has(bvid)) seen.set(bvid, new Set()); seen.get(bvid).add(layer); };
  return {
    /** 读工具成功后记一笔。 */
    note(tool, args = {}, result = {}) {
      if (!result || result.ok === false) return;
      const bvid = args.bvid || result.bvid || result.video?.bvid;
      if (tool === 'bili_subtitle' && result.has) add(bvid, 'subtitle');
      else if (tool === 'bili_danmaku') add(bvid, 'danmaku');
      else if (tool === 'bili_comments' || tool === 'bili_comment_thread') add(bvid, 'comments');
      else if (tool === 'bili_video' && bvid) { add(bvid, 'meta'); add(bvid, 'detail'); } // 点进详情（F-74：照片打动分要分清「扫过标题」和「点进去了」）
      else if (bvid) add(bvid, 'meta');
      for (const v of [...(result.videos || []), ...(result.items || []).map((x) => x.video).filter(Boolean)]) add(v.bvid, 'meta');
    },
    has: (bvid, layer) => Boolean(seen.get(bvid)?.has(layer)),
    knows: (bvid) => seen.has(bvid),
    /** 给人 / 测试看的。 */
    dump: () => Object.fromEntries([...seen.entries()].map(([k, v]) => [k, [...v]])),
  };
}

/** 正文对读账：返回 { ok, why }。bvid：这条话针对的视频（没有就只查 BV 号）。 */
export function evidenceCheck(text, ledger, { bvid = null } = {}) {
  const t = String(text || '');
  if (CLAIM.test(t) && !(bvid && ledger?.has(bvid, 'subtitle'))) return { ok: false, why: '没读过字幕，不能说「看完了 / 视频里说 / 听了」，只能说看到了标题、简介和评论' };
  for (const m of t.matchAll(/BV[0-9A-Za-z]{10}/g)) if (!ledger?.knows(m[0])) return { ok: false, why: `提到的 ${m[0]} 不是这次真的看过的` };
  return { ok: true };
}
