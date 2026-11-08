/**
 * 明信片（F-84，docs/设计/13-笔记本.md 第 12 节）：出门**途中**从外面寄回家的。纯函数，verify 直接测。
 *
 *   正面：她拍的照片（F-74 规则挑中、生图画好的）；没拍成就是一张邮票风格的文字卡（她写给爸妈的话 + 邮戳）
 *   背面：她写给爸妈的话 + 那条视频 / 新闻的链接 + 她在笔记本上写的那张便利贴（讲了啥 / 一句话）
 *   什么时候到：这一趟走到一半多一点寄出第一张（55%），第二张 75%——都在回家之前
 *   几张：拍了几张就几张（小相机最多 2 张）；一张都没拍也寄一张文字卡。这趟什么都没看成就不寄
 */
const CLEAN = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * shots / missed：pickShots 的结果（[{ item, moment, caption, frame }]）；notes：这趟验收过的便利贴；seen：这趟的见闻；text：她游记里写给爸妈的明信片话。
 * 返回 [{ id, trip, deliverAt, ref, text, back, moment, frame, wantPhoto, photo: null }]（photo 由生图回来再挂上）。
 */
export function planPostcards({ tripId = '', startedAt = 0, durationMs = 3600e3, shots = [], missed = [], notes = [], seen = [], text = '' } = {}) {
  const noteOf = (url) => notes.find((n) => n.url === url);
  const pick = shots.length
    ? shots.slice(0, 2).map((x) => ({ item: x.item, moment: x.moment, caption: x.caption, frame: x.frame, wantPhoto: true }))
    : (() => { const m = missed[0]; const item = m?.item || notes[0] || seen[0]; return item?.url ? [{ item, moment: m?.moment || null, caption: m?.caption || '', frame: null, wantPhoto: false }] : []; })();
  return pick.map((x, i) => {
    const n = noteOf(x.item.url);
    return {
      id: `${tripId}-pc${i}`, trip: tripId,
      deliverAt: startedAt + Math.round(durationMs * (0.55 + 0.2 * i)),
      ref: { title: CLEAN(x.item.title, 80), url: x.item.url, source: x.item.source || null },
      text: CLEAN(i === 0 ? (text || x.caption) : (x.caption || text), 240), // 她写给爸妈的话
      back: n ? { tag: n.note?.tag || null, line: n.line || '', gist: n.note?.gist || '' } : null, // 她那张便利贴
      moment: x.moment ? CLEAN(x.moment, 120) : null, frame: x.frame || null,
      wantPhoto: x.wantPhoto, // 规则挑中要拍：生图回来挂上照片；没挑中 / 失败就是文字卡
      photo: null,
    };
  });
}

/** 到时间了还没寄出的明信片。 */
export const postcardsDue = (pcs, now) => (pcs || []).filter((p) => !p.sent && p.deliverAt <= now);

/** 寄到家的那一刻 → 明信片册（album）里的一条。kind：photo（正面是照片）/ text（文字卡）。 */
export const albumEntry = (p) => ({
  at: new Date(p.deliverAt).toISOString(), pc: p.id, trip: p.trip, kind: p.photo ? 'photo' : 'text',
  ...(p.photo ? { photo: p.photo } : {}), text: p.text || '', caption: p.text ? String(p.text).split(/[。！!？?\n]/)[0].slice(0, 60) : '',
  ref: p.ref, back: p.back || null, moment: p.moment || null, frame: p.frame || null,
});
