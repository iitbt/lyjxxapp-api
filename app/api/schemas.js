// 请求参数的口径与校验常量 —— 对照旧站 app/api/schemas.py
//
// 旧站用 Pydantic 声明请求模型(schemas.py) + helpers.py 里的 intval/strval 做宽松转换;
// Worker 里没有 Pydantic, 参数一律走 core/db.js 的 intOf/str/idList(与旧站 intval/strval 同语义),
// 所以这里只保留**跨接口共享的口径常量与夹取函数** —— 值必须与旧站逐条一致, 改这里等于改对外契约。
import { intOf } from '../core/db.js';

//: 分页上限(PAGE_MAX)与单页上限, 与旧站 helpers.py 的 PAGE_MAX=1000、schemas.py 的 MAX_PAGE_SIZE=50 一致
export const PAGE_MAX = 1000;
export const MAX_PAGE_SIZE = 50;
//: 留言正文长度(旧站 schemas.py MAX_COMMENT_LENGTH)
export const MAX_COMMENT_LENGTH = 500;
//: 批量点赞查询的 id 数上限(旧站 schemas.py 同值)
export const MAX_BATCH_NEWS_IDS = 200;
//: 昵称长度(旧站 user.py 的 _MAX_NICKNAME_LEN)
export const MAX_NICKNAME_LEN = 16;

/**
 * 页码夹取: 与旧站 pageval() 同语义 —— 非法值回退, 结果夹到 [1, max]。
 * 注意 news/list 的 page=0 表"不分页", 属特例, 不走这个函数。
 */
export function clampPage(value, fallback = 1, max = PAGE_MAX) {
  const num = intOf(value, fallback) || fallback;
  return Math.min(Math.max(1, num), max);
}

/**
 * 每页条数: 非法或小于 1 → fallback, 超过 max → max(旧站各接口的默认/上限不同, 故都作参数)。
 */
export function pageSize(value, fallback = 10, max = MAX_PAGE_SIZE) {
  const num = intOf(value, fallback) || fallback;
  if (num < 1) return fallback;
  return Math.min(num, max);
}
