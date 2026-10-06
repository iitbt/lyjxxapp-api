// D1 访问薄封装: 只三件事 —— 多行、单行、写入; 不做 ORM, 不做连接管理
export async function all(env, sql, ...args) {
  const result = await env.DB.prepare(sql).bind(...args).all();
  return result.results || [];
}

export async function one(env, sql, ...args) {
  return await env.DB.prepare(sql).bind(...args).first();
}

export function run(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).run();
}

// 与旧站 helpers.intval 同语义: int(float(v)), 非法值回退, 结果夹在 ±2^31-1
// (不用 parseInt: 旧站能认 "3.7" 与 "1e3", parseInt 会把它们当成 3 / 1)
const INT32_MAX = 2147483647;

export function intOf(value, fallback = 0) {
  let num = NaN;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    num = Number(value.trim());
  }
  if (!Number.isFinite(num)) return fallback;
  const truncated = Math.trunc(num);
  if (truncated > INT32_MAX) return INT32_MAX;
  if (truncated < -INT32_MAX) return -INT32_MAX;
  return truncated;
}

// 逗号分隔的 id 串 → 正整数数组(批量接口用)
export function idList(value) {
  return String(value === undefined || value === null ? '' : value)
    .split(',')
    .map((item) => intOf(item.trim()))
    .filter((item) => item > 0);
}

export function str(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}
