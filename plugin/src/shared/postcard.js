/**
 * 明信片（F-84/F-85，docs/设计/13-笔记本.md 第 12–13 节）：出门**途中**从外面寄回家的。纯函数，verify 直接测。
 *
 *   正面：她拍的照片（F-74 规则挑中、生图画好的）；没拍成就是一张风景明信片（POSTCARD_SCENES 里的一张现成图，按趟掷骰挑、可复现）
 *   背面：她写给爸妈的话，她自己选写哪种：见闻（看到了什么）/ 想你（对爸妈的爱）/ 口信（一句叮嘱或悄悄话）
 *   什么时候到：这一趟走到一半多一点寄出第一张（55%），第二张 75%——都在回家之前
 *   几张：拍了几张就几张（小相机最多 2 张）；一张都没拍也寄一张。这趟什么都没看成就不寄
 */
const CLEAN = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** 背面三种（她说哪种是哪种，规则只认这三个词）。 */
export const POSTCARD_SAYS = ['见闻', '想你', '口信'];
/** 风景图（都没有生图）：鱼社自己的画，寄不到自己住的那间（这批图也是「选一个家」，寄自己家不像在外面）。 */
export const POSTCARD_SCENES = ['lagoon', 'sakura', 'seaside', 'coral']; // 户外的 4 张（这 10 张也是「选一个家」的房间；水族馆、阁楼这种是屋里，不像在外面寄的）

/** 稳定的小哈希：同样的输入永远同一张（不用 Math.random）。 */
const sceneHash = (s) => { let h = 0x811c9dc5; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; return h >>> 0; }; // FNV-1a + 末尾搅拌（只用 FNV 取模时低位不匀，seaside 40 趟一次都挑不到）

/** 这一趟的第几张用哪张风景图：tripId + 第几张掷骰，从 POSTCARD_SCENES 去掉她现在的家（home 可能是 undefined）之后挑。 */
export const sceneOf = (tripId = '', i = 0, home = '') => {
  const list = home ? POSTCARD_SCENES.filter((s) => s !== home) : POSTCARD_SCENES;
  return list[sceneHash(`${tripId}#${i}`) % list.length];
};

/**
 * shots / missed：pickShots 的结果（[{ item, moment, caption, frame }]）；notes：这趟验收过的便利贴；seen：这趟的见闻；
 * text：她游记里写给爸妈的明信片话；say：她选写哪种（见闻 / 想你 / 口信，不在三种里当见闻）；home：她现在住的房间 id（可能是 undefined）。
 * 返回 [{ id, trip, deliverAt, ref, text, say, scene, back, moment, frame, wantPhoto, photo: null }]（photo 由生图回来再挂上）。
 */
export function planPostcards({ tripId = '', startedAt = 0, durationMs = 3600e3, shots = [], missed = [], notes = [], seen = [], text = '', say = '见闻', home = '' } = {}) {
  const which = POSTCARD_SAYS.includes(say) ? say : '见闻';
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
      say: which, // 她选写哪种：每张都用同一种（这趟的心情一致）
      scene: sceneOf(tripId, i, home), // 每张都备着一张风景图：没拍到就是正面，照片生图失败也退回它，不会是空的
      back: n ? { tag: n.note?.tag || null, line: n.line || '', gist: n.note?.gist || '' } : null, // 她那张便利贴
      moment: x.moment ? CLEAN(x.moment, 120) : null, frame: x.frame || null,
      wantPhoto: x.wantPhoto, // 规则挑中要拍：生图回来挂上照片；没挑中 / 失败就是风景明信片
      photo: null,
    };
  });
}

/** 到时间了还没寄出的明信片。 */
export const postcardsDue = (pcs, now) => (pcs || []).filter((p) => !p.sent && p.deliverAt <= now);

/** 寄到家的那一刻 → 明信片册（album）里的一条。kind：photo（正面是照片）/ scene（风景明信片）；0.35.0 的老条目 kind 还是 text，页面照旧画文字卡。 */
export const albumEntry = (p) => ({
  at: new Date(p.deliverAt).toISOString(), pc: p.id, trip: p.trip, kind: p.photo ? 'photo' : 'scene',
  ...(p.photo ? { photo: p.photo } : {}), ...(p.scene ? { scene: p.scene } : {}), say: p.say || '见闻',
  text: p.text || '', caption: p.text ? String(p.text).split(/[。！!？?\n]/)[0].slice(0, 60) : '',
  ref: p.ref, back: p.back || null, moment: p.moment || null, frame: p.frame || null,
});
