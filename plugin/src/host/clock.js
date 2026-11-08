/**
 * 开发时钟：宿主里所有「现在」都走这里，方便白天测夜里、夜里测白天。
 *
 * 只有 <storage>/dev.json 存在时才生效（普通用户没有这个文件）：
 *   { "now": "2026-11-07T14:00" }   从写这个文件那一刻起，时间按「这个时刻」继续往前走
 *   { "offsetMinutes": 600 }        直接拨快 / 拨慢多少分钟
 * 删掉文件就回到真实时间。每 2 秒最多读一次文件。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let file = null, offset = 0, checkedAt = 0, mtime = 0;

export function initClock(storageDir) { file = join(storageDir, 'dev.json'); checkedAt = 0; refresh(); }

function refresh() {
  if (!file) return;
  const t = Date.now();
  if (t - checkedAt < 2000) return;
  checkedAt = t;
  try {
    const st = statSync(file);
    if (st.mtimeMs === mtime) return;
    mtime = st.mtimeMs;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j.now && Number.isFinite(Date.parse(j.now))) offset = Date.parse(j.now) - st.mtimeMs;
    else offset = (Number(j.offsetMinutes) || 0) * 60_000;
  } catch { offset = 0; mtime = 0; }
}

export const nowMs = () => { refresh(); return Date.now() + offset; };
export const nowDate = () => new Date(nowMs());
/** 开发时钟有没有在拨（状态路由里告诉游戏，界面上标一下，免得忘了关）。 */
export const clockSkewed = () => { refresh(); return offset !== 0; };
