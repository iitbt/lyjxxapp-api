// 全站统计口径的唯一实现 —— 对照旧站 app/core/overview.py
//
// 旧站 count_tables() 是控制面板 / 系统信息 / 数据表状态 / 数据库管理**共用**的一份实现
// (dbadmin.py 头注释专门强调"每张表行数的唯一实现"), 这里保持同一纪律:
// 行数、核心计数、体积格式化都只在这一处定义, 页面只负责展示。
import { all, one } from './db.js';

//: 物料扫描上限(与旧站 _MAX_SCAN_FILES 同口径): 超过就标注"至少这么多", 不假装数得清
export const MAX_SCAN_OBJECTS = 1000;

//: 应有数据表清单(旧站 maint.py 的 _DB_EXPECTED_TABLES): 缺表要在系统信息里点名
export const EXPECTED_TABLES = [
  'admin_users', 'users', 'news', 'banner_images', 'news_likes', 'news_favorites',
  'news_view_history', 'news_shares', 'news_comments', 'motorcycle_trips', 'outdoor_activities'
];

//: 统计行数时每批几条 COUNT 语句: D1 的 batch 一次往返执行多条, 这里给一个保守分片
const COUNT_BATCH = 20;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 把异常压成一行可显示的原因(页面排障用; 完整堆栈进日志)。 */
function short(error) {
  const text = String((error && error.message) || error || '未知错误');
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** 人类可读体积(与旧站 storage/系统信息同一套显示口径)。 */
export function fmtBytes(size) {
  const value = num(size);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 库里的业务表名(排除 sqlite_ 内部表), 按名称排序。
 *
 * 注意: **失败就抛**。调用方必须区分"读不到表清单"和"库里确实没有表" ——
 * 早先这里 catch 掉异常返回空数组, 于是 D1 报错时页面显示成"业务表数量 0 张 + 应有表缺失 N 张",
 * 看起来像数据全丢了(2026-10-06 线上就是这么误导的)。
 */
export async function tableNames(env) {
  const rows = await all(
    env,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  );
  return rows
    .map((row) => String(row.name || ''))
    // 排除 SQLite 与 D1 自己维护的表: `sqlite_%` 是内部表, `_cf_%` 是 Cloudflare 的内部表
    // (`_cf_KV` 是 D1 自带的 KV 影子表, 对它 COUNT(*) 会让整条统计查询失败 —— 2026-10-06 线上就是这么挂的),
    // `d1_migrations` 是 wrangler 的迁移台账, 都不是业务数据。
    .filter((name) => name && !/^(sqlite_|_cf_)/i.test(name) && name !== 'd1_migrations');
}

/**
 * 逐表行数 → { rows: [[表名, 行数], …](按行数降序), total, failed, reason?, empty? }
 *
 * 实现方式(2026-10-06 修): 用 D1 原生的 **batch** 一次往返跑 N 条独立 COUNT。
 * 为什么不用"一条 UNION ALL 拼所有表": 线上实测**复合 SELECT 在 D1 上会失败**(表名读得到,
 * 拼起来的那条直接报错), 本地 SQLite 同样语句却正常 —— 属平台差异, 不再赌它。
 * batch 的另一个好处是每条语句独立, 一条表出错不会让整页统计全废。
 */
export async function countTables(env) {
  let names = [];
  try {
    names = await tableNames(env);
  } catch (error) {
    console.error('统计表行数失败(读表清单)', error && error.message);
    return { rows: [], total: 0, failed: true, reason: `读取表清单失败：${short(error)}` };
  }
  if (!names.length) {
    // 表清单读到了但确实是空的: 这本身就是异常状态(至少该有业务表), 交给页面提示去建表
    return { rows: [], total: 0, failed: false, empty: true };
  }

  const rows = [];
  try {
    for (let start = 0; start < names.length; start += COUNT_BATCH) {
      const chunk = names.slice(start, start + COUNT_BATCH);
      const statements = chunk.map((name) => env.DB.prepare(`SELECT COUNT(*) AS c FROM "${name}"`));
      const results = await env.DB.batch(statements);
      chunk.forEach((name, index) => {
        const result = results[index] || {};
        const first = (result.results && result.results[0]) || result;
        rows.push([name, num(first && first.c)]);
      });
    }
  } catch (error) {
    console.error('统计表行数失败(批量 COUNT)', error && error.message);
    return { rows: [], total: 0, failed: true, reason: `统计行数失败：${short(error)}` };
  }

  let total = 0;
  for (const [, count] of rows) total += count;
  return {
    rows: rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    total,
    failed: false
  };
}

/** 控制面板口径的核心计数(可见笔记 / 回收站 / 用户 / 留言)。 */
export async function coreCounts(env) {
  const row = await one(env,
    'SELECT (SELECT COUNT(*) FROM news WHERE deleted_at IS NULL) AS visible_news, '
    + '(SELECT COUNT(*) FROM news WHERE deleted_at IS NOT NULL) AS recycled_news, '
    + '(SELECT COUNT(*) FROM users) AS users, '
    + '(SELECT COUNT(*) FROM news_comments) AS comments').catch(() => null);
  const counts = row || {};
  return {
    visibleNews: num(counts.visible_news),
    recycledNews: num(counts.recycled_news),
    users: num(counts.users),
    comments: num(counts.comments)
  };
}
