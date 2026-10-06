// 全站固定东八区: 不用运行环境时区, 统一 UTC+8 计算, 避免 Worker 区域不同结果不同
export const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

const pad = (value, size = 2) => String(value).padStart(size, '0');

// 东八区 "YYYY-MM-DD HH:MM:SS", 与旧站 local_now() 同格式
export function beijingNow(date = new Date()) {
  const shifted = new Date(date.getTime() + CHINA_OFFSET_MS);
  const ymd = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const hms = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  return `${ymd} ${hms}`;
}

// 当前 Unix 秒
export function nowEpoch(date = new Date()) {
  return Math.floor(date.getTime() / 1000);
}

// 固定窗口起点: 按 windowSec 向下取整
export function windowStart(windowSec, date = new Date()) {
  return Math.floor(nowEpoch(date) / windowSec) * windowSec;
}

// 库内时间字符串 → Unix 秒; 空值或无法解析时回 0(旧站口径)
export function toEpoch(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Math.floor(value);
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Math.floor(Number(text));
  const normalized = text.replace('T', ' ').replace(/\.\d+$/, '');
  const parsed = Date.parse(`${normalized.replace(' ', 'T')}+08:00`);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

// 取日期部分(公告 published_at 用)
export function datePart(value) {
  const text = String(value || '').trim();
  return text.slice(0, 10);
}

// 墙钟毫秒: 把业务时区的墙上时间当 UTC 读出来的毫秒数, 状态页用它写 data-live-anchor
export function wallClockMs(date = new Date()) {
  return date.getTime() + CHINA_OFFSET_MS;
}

// 业务时区当天 00:00:00(统计窗口下界)
export function beijingMidnight(date = new Date()) {
  const shifted = new Date(date.getTime() + CHINA_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} 00:00:00`;
}

// 相对当前时刻往前 N 天的业务时区时间戳(统计窗口用: 7 天 / 30 天)
export function beijingDaysAgo(days, date = new Date()) {
  return beijingNow(new Date(date.getTime() - days * 86400000));
}
