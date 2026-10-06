// 限流: D1 计数表(免费套餐无 Durable Objects), 见 notes/limits-design.md
// 流程: 先读当前窗口计数 → 超限直接拒 → 未超限时把计数自增与业务写入放进同一批 batch()
import { one } from './db.js';
import { windowStart } from './timeutil.js';

// 与旧站一致的配额(每分钟): core/ratelimit.py:114-115 与头像 5/60
export const QUOTAS = {
  like: { limit: 60, windowSec: 60 },
  favorite: { limit: 60, windowSec: 60 },
  share: { limit: 30, windowSec: 60 },
  comment: { limit: 20, windowSec: 60 },
  view_history: { limit: 120, windowSec: 60 },
  avatar: { limit: 5, windowSec: 60 }
};

const OVER_LIMIT_MESSAGE = '操作过于频繁，请稍后再试';
const AVATAR_OVER_LIMIT_MESSAGE = '上传过于频繁，请稍后再试';

export const LOGIN_LIMIT = { limit: 5, windowSec: 900 };

export function userKey(userId) {
  return `w:${userId}`;
}

export function ipKey(request) {
  return `ip:${(request.headers.get('cf-connecting-ip') || 'unknown').trim()}`;
}

export function overLimitMessage(scope) {
  return scope === 'avatar' ? AVATAR_OVER_LIMIT_MESSAGE : OVER_LIMIT_MESSAGE;
}

// 只读判断; 命中上限返回 { allowed:false, message }
export async function checkQuota(env, scope, bucketKey, quota = QUOTAS[scope]) {
  if (!quota) return { allowed: true };
  const start = windowStart(quota.windowSec);
  const row = await one(
    env,
    'SELECT count FROM rate_limit_counters WHERE scope=? AND bucket_key=? AND window_start=?',
    scope, bucketKey, start
  );
  const used = Number(row && row.count) || 0;
  return { allowed: used < quota.limit, used, limit: quota.limit, message: overLimitMessage(scope) };
}

// 计数自增语句: 放进业务同一批, 保证"计数与写入一起成功或一起失败"
export function quotaStatement(env, scope, bucketKey, quota = QUOTAS[scope]) {
  const start = windowStart(quota ? quota.windowSec : 60);
  return env.DB.prepare(
    'INSERT INTO rate_limit_counters (scope, bucket_key, window_start, count) VALUES (?,?,?,1) '
    + 'ON CONFLICT(scope, bucket_key, window_start) DO UPDATE SET count = count + 1'
  ).bind(scope, bucketKey, start);
}

// 登录失败计数(按 IP): 达到上限即锁定
export async function loginLockState(env, request) {
  const start = windowStart(LOGIN_LIMIT.windowSec);
  const row = await one(
    env,
    'SELECT count FROM rate_limit_counters WHERE scope=? AND bucket_key=? AND window_start=?',
    'login', ipKey(request), start
  );
  const used = Number(row && row.count) || 0;
  return { locked: used >= LOGIN_LIMIT.limit, used };
}

export function loginFailStatement(env, request) {
  return quotaStatement(env, 'login', ipKey(request), LOGIN_LIMIT);
}

export function loginClearStatement(env, request) {
  return env.DB.prepare('DELETE FROM rate_limit_counters WHERE scope=? AND bucket_key=?')
    .bind('login', ipKey(request));
}

// 过期窗口清理(Cron Trigger 每天调一次)
export function cleanupSql() {
  return 'DELETE FROM rate_limit_counters WHERE window_start < strftime(\'%s\',\'now\') - 86400';
}
