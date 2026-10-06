// 数据库工具的安全内核与元信息 —— 对照旧站 app/admin/maint.py(唯一安全内核) + app/admin/dbadmin.py(元信息/分页)
//
// 旧站头注释点名的三条纪律, 这里原样继承(它们不是"额外加的约束", 是既有口径):
//   ① **只读浏览**范围 = 本库全部表: 表结构 + 数据分页, 表名必须是安全标识符且确实存在于本库;
//   ② **执行 SQL**范围 = 白名单业务表 —— 与浏览范围是两件事, 不随浏览放开
//      (防误删, 也防绕过公告标题/分类标识这些业务校验直接写表);
//   ③ 危险语句一律拒绝(DDL / 多语句 / 事务与 PRAGMA), 错误详情只进日志, 回给用户统一文案。
//
// 平台差异: 旧站是 _SqliteMeta/_MysqlMeta 两套驱动, 这里只有 D1 —— 但表结构优先 PRAGMA,
// PRAGMA 不可用时回退解析 sqlite_master.sql(旧站解析 CREATE TABLE 取列注释的同一路数)。
import { all, one } from '../../core/db.js';
import { tableNames } from '../../core/overview.js';
import { logWarn } from '../../core/logging.js';

//: 允许执行的业务表(旧站 maint._SAFE_TOOL_TABLES 同口径: 只放业务表, 不放 admin_users / token 表)
export const SAFE_TABLES = [
  'users', 'news', 'news_likes', 'news_favorites', 'news_view_history', 'news_shares',
  'news_comments', 'banner_images', 'motorcycle_trips', 'outdoor_activities', 'app_notices'
];

//: 数据浏览单页上限(与前台 MAX_PAGE_SIZE 口径一致)
export const MAX_PAGE_SIZE = 50;

//: 表名只允许安全标识符(不接受任意输入)
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

//: 敏感列脱敏(旧站 _mask_rows_sensitive 同口径): 值一律变成 ***
const SENSITIVE_COLUMNS = new Set([
  'token', 'password', 'passwd', 'pwd', 'secret', 'access_token', 'session_key',
  'openid', 'appid', 'appsecret', 'authorization', 'cookie'
]);

export function isSafeIdentifier(name) {
  return IDENTIFIER_RE.test(String(name || ''));
}

export async function tableExists(env, name) {
  if (!isSafeIdentifier(name)) return false;
  try {
    return (await tableNames(env)).includes(name);
  } catch (error) {
    // 读不到表清单时按"不存在"处理(调用方会回一句"表不存在或表名不合法"并进日志), 不把异常抛到页面
    return false;
  }
}

/** 敏感列脱敏: 只处理结果集(不改库), 列名命中即打码。 */
export function maskRows(rows) {
  return (rows || []).map((row) => {
    const out = {};
    Object.keys(row || {}).forEach((key) => {
      out[key] = SENSITIVE_COLUMNS.has(String(key).toLowerCase()) ? '***' : row[key];
    });
    return out;
  });
}

/**
 * 语句分类 —— 唯一判定入口(前端"需要二次确认"的提示与后端拦截共用同一套规则)。
 *
 * 返回 { kind: 'read' | 'write' | 'reject', reason, tables: [] }
 */
export function classifyStatement(sql) {
  const text = String(sql || '').trim();
  if (!text) return { kind: 'reject', reason: '请输入要执行的 SQL', tables: [] };

  // 多语句: 去掉结尾分号后还有分号 → 拒绝(旧站也只在单条语句上做保护)
  const body = text.replace(/;+\s*$/, '');
  if (body.includes(';')) {
    return { kind: 'reject', reason: '一次只能执行一条语句（请去掉中间的分号）', tables: [] };
  }

  const upper = body.toUpperCase().replace(/\s+/g, ' ');
  const first = upper.split(' ')[0];
  const write = /^(INSERT|UPDATE|DELETE)$/.test(first);
  const read = first === 'SELECT' || upper.startsWith('EXPLAIN ');
  if (!write && !read) {
    return {
      kind: 'reject',
      reason: '只允许 SELECT / INSERT / UPDATE / DELETE（不接受建表、改表、删表等结构变更）',
      tables: []
    };
  }

  // 抽取被引用的表名: 三处写法覆盖 INSERT/UPDATE/DELETE 与 FROM/JOIN
  const tables = new Set();
  const patterns = [
    /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi,
    /\b(?:FROM|JOIN)\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) tables.add(match[1]);
  }
  const list = Array.from(tables);
  const outside = list.filter((name) => !SAFE_TABLES.includes(name));
  if (outside.length) {
    return {
      kind: 'reject',
      reason: `只允许操作这些业务表：${SAFE_TABLES.join('、')}`,
      tables: list
    };
  }
  return { kind: write ? 'write' : 'read', reason: '', tables: list };
}

/** 写语句必须带 confirm（前端二次确认 + 后端再验，防绕过前端直接 POST）。 */
export function needsConfirm(sql) {
  return classifyStatement(sql).kind === 'write';
}

/** 表结构 + 索引: 优先 PRAGMA, 失败则解析 sqlite_master.sql(旧站同路数)。 */
export async function tableMeta(env, name) {
  if (!(await tableExists(env, name))) {
    return { ok: false, reason: '表不存在或表名不合法' };
  }
  let columns = [];
  let indexes = [];
  let viaPragma = true;
  try {
    const info = await all(env, `PRAGMA table_info("${name}")`);
    columns = (info || []).map((row) => ({
      name: String(row.name || ''),
      type: String(row.type || ''),
      notnull: Number(row.notnull) || 0,
      pk: Number(row.pk) || 0,
      default: row.dflt_value === undefined || row.dflt_value === null ? '' : String(row.dflt_value),
      comment: ''
    }));
    const list = await all(env, `PRAGMA index_list("${name}")`).catch(() => []);
    indexes = (list || []).map((row) => ({
      name: String(row.name || ''),
      unique: Number(row.unique) || 0,
      columns: []
    }));
  } catch (error) {
    viaPragma = false;
  }
  if (!columns.length) {
    const row = await one(env, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", name).catch(() => null);
    const createSql = String((row && row.sql) || '');
    if (!createSql) return { ok: false, reason: '读取表结构失败' };
    columns = parseCreateSql(createSql);
    viaPragma = false;
  }
  return { ok: true, name, columns, indexes, viaPragma };
}

/** 从 CREATE TABLE 语句里解析列(PRAGMA 不可用时的回退): 取行内 `--` 注释当列说明。 */
export function parseCreateSql(createSql) {
  const lines = String(createSql || '').split('\n').slice(1);
  const columns = [];
  const skip = new Set(['primary', 'unique', 'key', 'index', 'constraint', 'foreign', 'check']);
  for (const raw of lines) {
    const [codePart, commentPart] = String(raw).split('--', 2);
    const code = codePart.trim().replace(/,$/, '');
    if (!code || code.startsWith(')')) continue;
    const head = code.split(/\s+/)[0].replace(/["'`[\]]/g, '');
    if (!head || skip.has(head.toLowerCase())) continue;
    const type = (code.split(/\s+/)[1] || '').replace(/,$/, '');
    columns.push({
      name: head,
      type,
      notnull: /not\s+null/i.test(code) ? 1 : 0,
      pk: /primary\s+key/i.test(code) ? 1 : 0,
      default: '',
      comment: commentPart ? commentPart.trim() : ''
    });
  }
  return columns;
}

/** 数据分页(只读): 单页上限 50, 敏感列脱敏。 */
export async function tablePage(env, name, page = 1, pageSize = 20) {
  if (!(await tableExists(env, name))) return { ok: false, reason: '表不存在或表名不合法' };
  const size = Math.min(Math.max(1, Number(pageSize) || 20), MAX_PAGE_SIZE);
  const current = Math.max(1, Number(page) || 1);
  const totalRow = await one(env, `SELECT COUNT(*) AS c FROM "${name}"`);
  const total = Number((totalRow && totalRow.c) || 0);
  const pages = Math.max(1, Math.ceil(total / size));
  const offset = (Math.min(current, pages) - 1) * size;
  const raw = await all(env, `SELECT * FROM "${name}" LIMIT ? OFFSET ?`, size, offset);
  const rows = maskRows(raw);
  return {
    ok: true,
    name,
    rows,
    rowKeys: rows.length ? Object.keys(rows[0]) : [],
    total,
    page: Math.min(current, pages),
    pages,
    page_size: size
  };
}

/**
 * 执行一条 SQL —— 与浏览能力分开的第二道闸(classifyStatement 已保证单语句 + 白名单表)。
 * 返回 { ran, rows, rowKeys, affected, message } 或 { error }。
 */
export async function runStatement(env, sql) {
  const verdict = classifyStatement(sql);
  if (verdict.kind === 'reject') return { error: verdict.reason };
  const started = Date.now();
  try {
    if (verdict.kind === 'read') {
      const result = await env.DB.prepare(String(sql).trim().replace(/;+\s*$/, '')).all();
      const rows = maskRows(result.results || []);
      return {
        ran: true,
        rows,
        rowKeys: rows.length ? Object.keys(rows[0]) : [],
        affected: 0,
        message: `查询成功，返回 ${rows.length} 行`,
        costMs: Date.now() - started
      };
    }
    const result = await env.DB.prepare(String(sql).trim().replace(/;+\s*$/, '')).run();
    const affected = Number((result && result.meta && result.meta.changes) || 0);
    return { ran: false, rows: [], rowKeys: [], affected, message: `执行成功，影响 ${affected} 行`, costMs: Date.now() - started };
  } catch (error) {
    // 错误详情只进日志, 回给页面统一文案(旧站同口径)
    logWarn('admin.db_manage_failed', { sql: String(sql).slice(0, 200), reason: error && error.message });
    return { error: '执行失败，请检查语句（详情见服务端日志）' };
  }
}
