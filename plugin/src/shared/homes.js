/**
 * 她的家（F-49）：诞生时先挑一间，之后在设置里能换。10 间同一卡通画风（美术/assets/bg/<id>.webp）。
 * mote：房间里飘的小光点颜色（scene.js 用）。
 */
export const HOMES = [
  { id: 'cyberroom', name: '赛博鱼缸房', desc: '霓虹城市窗景、大鱼缸和电脑桌，科技少女的房间', mote: 0xd9b8ff },
  { id: 'dollhouse', name: '娃娃小屋', desc: '一屋子玩偶和公主床，粉粉软软', mote: 0xffc4dc },
  { id: 'study', name: '书香书房', desc: '满墙的书、毛笔和台灯，窗外是竹子', mote: 0xffe2a8 },
  { id: 'coral', name: '珊瑚海底屋', desc: '住在海底的玻璃泡泡里，窗外是珊瑚和小鱼', mote: 0x9fe8ff },
  { id: 'washitsu', name: '樱花和室', desc: '榻榻米、纸灯笼，拉门外樱花在飘', mote: 0xffc4dc },
  { id: 'treehouse', name: '森林树屋', desc: '大树里的小屋，吊床、蘑菇凳和小灯串', mote: 0xd8ffb0 },
  { id: 'starattic', name: '星空阁楼', desc: '天窗外全是星星，有望远镜和月亮灯', mote: 0xfff1c2 },
  { id: 'bakery', name: '甜品小屋', desc: '蛋糕柜、马卡龙和糖果罐，甜甜的', mote: 0xffd6e8 },
  { id: 'seaside', name: '海边小屋', desc: '窗外就是阳光沙滩和大海，墙边靠着冲浪板', mote: 0xfff1c2 },
  { id: 'arcade', name: '电玩房', desc: '街机、游戏机和懒人沙发，打游戏的好地方', mote: 0xb8e0ff },
];
export const DEFAULT_HOME = 'cyberroom';
export const isHome = (id) => HOMES.some((h) => h.id === id);
export const homeOf = (id) => HOMES.find((h) => h.id === id) || HOMES[0];
