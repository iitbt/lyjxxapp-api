// 后台通用小工具(照搬旧站 fastapi/app/admin/utils.py 的口径)
// 这些常量与函数是"各页面长得一样"的前提, 只在这里定义一份, 页面模块不要各写各的
import { beijingNow, windowStart } from '../../core/timeutil.js';
import { CACHE_PREFIX_BY_ENTITY } from './entities.js';

// 列表页统一每页条数(笔记/用户/轮播/专题/留言/管理员一致)
export const PER_PAGE = 10;

// 首屏"累积渲染"的页码上限: 首屏按 page*PER_PAGE 一次渲染前 N 页, 更深的页码由触底加载追加
// 不设上限时 ?page=999 会一次查/渲染 9990 行
export const MAX_FIRST_SCREEN_PAGES = 3;

// 受控小表(分类/文案/菜单)列表的展示上限: 它们一次全量展示更直观, 但异常数据灌进几千行时不能全画
export const CONTROLLED_LIST_LIMIT = 200;

// 页码硬上界: 与对外接口 app/api/helpers.py 的 PAGE_MAX 取同一个数
export const PAGE_MAX = 1000;

// 宽松取整数(非法/空值回退默认)
export function intOr(value, fallback = 0) {
  const parsed = parseInt(String(value === undefined || value === null ? '' : value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// 多行文本原样保留(不 trim), 与旧站 text 类型一致
export function textOf(value) {
  return value === undefined || value === null ? '' : String(value);
}

export function strOf(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

// page 参数防呆: 非法回 1; 传了 totalPages 时越界夹到最后一页; 无论如何不超过 PAGE_MAX
export function clampPage(value, totalPages) {
  let page = Number.isFinite(intOr(value, 0)) ? Math.max(intOr(value, 1), 1) : 1;
  page = Math.min(page, PAGE_MAX);
  if (totalPages === undefined || totalPages === null) return page;
  return Math.min(page, Math.max(intOr(totalPages, 1), 1));
}

// 首屏分页的唯一入口: 返回 [页码, LIMIT 行数]
// 两件事一起做, 避免各模块只做一半: 页码防呆 + 首屏页数上限
export function firstScreenLimit(value, perPage, totalPages) {
  let page = clampPage(value, totalPages);
  page = Math.min(page, MAX_FIRST_SCREEN_PAGES);
  return [page, page * perPage];
}

// 幂等防重键的唯一构造入口: <action>:<part1>:<part2>…
// 以前各模块手拼格式各不相同, 拼错了在日志里看不出来
export function idemKey(action, ...parts) {
  const tail = parts.filter((part) => part !== undefined && part !== null).map((part) => String(part));
  return [String(action || '-'), ...tail].join(':');
}

// URL 参数编码
export function urlenc(value) {
  return encodeURIComponent(String(value === undefined || value === null ? '' : value));
}

// 把数据库时间字段统一格式化为展示文本(%Y-%m-%d %H:%M)
// 库内是 "YYYY-MM-DD HH:MM:SS" 字符串, 只截不解析(D1 与旧站口径一致, 不涉及时区换算)
export function fmtDatetime(value, empty = '') {
  if (!value) return empty;
  const text = String(value);
  if (text.length < 19) return text;
  return text.slice(0, 16);
}

// datetime-local 提交带 "T": 库里该列是 TEXT 且按**字符串**比较, 而 'T'(0x54) > ' '(0x20),
// 于是"设了开始时间的公告/带时间的笔记"在 `<= now` 判断里永远不成立 —— 旧站踩过这个坑。
// 统一归一化: "2026-10-05T10:30" → "2026-10-05 10:30:00"
export function normalizeDatetime(value) {
  const text = strOf(value);
  if (!text) return '';
  const normalized = text.replace('T', ' ');
  return normalized.length === 16 ? `${normalized}:00` : normalized.slice(0, 19);
}

// 回显用: "2026-10-05 10:30:00" → "2026-10-05T10:30"(datetime-local 的 value 格式)
export function datetimeLocalValue(value) {
  const text = strOf(value);
  return text ? text.slice(0, 16).replace(' ', 'T') : '';
}

// 新建时的默认值: 当前北京时间到分钟(datetime-local 形态)
export function nowLocalMinute() {
  return beijingNow().slice(0, 16).replace(' ', 'T');
}

// "操作完成回列表并保留筛选/页码"的跳转 URL 构造
// filters: {参数名: 值}; 值为空或 'all' 时忽略; page 只在 >1 时带上
export function buildListUrl(base, options = {}) {
  const params = [];
  if (options.message) params.push(`message=${urlenc(options.message)}`);
  if (options.error) params.push(`error=${urlenc(options.error)}`);
  for (const [key, value] of Object.entries(options.filters || {})) {
    const raw = String(value === undefined || value === null ? '' : value).trim();
    if (raw && raw !== 'all') params.push(`${urlenc(key)}=${urlenc(raw)}`);
  }
  const page = options.page;
  if (page !== undefined && page !== null && String(page).replace('-', '').match(/^\d+$/) && intOr(page, 0) > 1) {
    params.push(`page=${intOr(page, 1)}`);
  }
  if (!params.length) return base;
  return base + (base.includes('?') ? '&' : '?') + params.join('&');
}

// 幂等防重(D1 版): 同一 key 在 ttl 秒内只允许通过一次
// 旧站用进程内 cache.add_if_absent 做原子抢键; Workers 没有进程内状态, 于是落到 rate_limit_counters:
// 该表主键 (scope, bucket_key, window_start) 天然唯一, INSERT OR IGNORE 抢到就是首次。
// window_start 取 "当前时间按 ttl 对齐" 的窗口, 因此同一 key 在 ttl 秒内落在同一个窗口里。
export async function claimOnce(env, key, ttl = 10) {
  const bucket = `admin:${key}`;
  const start = windowStart(ttl);
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO rate_limit_counters (scope, bucket_key, window_start, count) VALUES (?,?,?,1)'
  ).bind('idem', bucket, start).run();
  return Number((result && result.meta && result.meta.changes) || 0) > 0;
}

// 返回 true 表示"这是重复提交", 调用方应直接拒绝
// 计数表不可用时放行而不是拒绝 —— 与旧站"缓存坏了也不误挡正常操作"同口径
export async function isDuplicateSubmit(env, key, ttl = 10) {
  try {
    return !(await claimOnce(env, key, ttl));
  } catch (error) {
    console.error('idem claim failed', error && error.message);
    return false;
  }
}

// 实体写操作后的缓存清理。Workers 无进程内缓存、对外接口层也未加缓存(先不加),
// 所以这里是**有意的空实现** —— 保留同名入口与调用点, 将来上 Cache API 时只改这一处。
export function invalidateEntityCache(entityKey) {
  const prefixes = CACHE_PREFIX_BY_ENTITY[entityKey];
  if (!prefixes) return;
  // 目前无需清理任何东西; 这里显式什么都不做, 避免读者以为"忘了写"
}

// 审计: 旧站写日志文件(audit_log), 这边进 Workers Logs(控制台可见)
// 统一走 core/logging.js 的实现(那里有键名与文本双重脱敏); 这里只保留后台侧的历史入口
export { auditLog } from '../../core/logging.js';
