// 受控表 CRUD 工厂: 六个"小配置表"的编辑/删除共用同一套流程(照搬旧站 controlled.py)
//
// 为什么需要它: 首页板块/首页精选/分类/运营文案/我的页菜单/通知公告这六张表的增删改页面结构几乎一样。
// 各写一份的话, 改一处(加幂等键、统一错误文案)极易漏改其它五处 —— 这正是旧站反复出问题的原因。
// 这里把骨架收敛成"声明(字段/校验/渲染/文案) + 统一流程", 模块只写真正不同的部分。
//
// 旧站的 edit_template + template_context 在这里合成一个 renderEdit 函数:
// 这边没有模板引擎, 页面模块直接用 partials 拼 HTML 更直接(等价物, 不是多一层抽象)。
import { one, run } from '../../core/db.js';
import { sanitizeHtml } from '../../core/sanitize.js';
import { auditAction } from './entities.js';
import {
  auditLog, buildListUrl, idemKey, intOr, invalidateEntityCache, isDuplicateSubmit, strOf, textOf
} from './utils.js';

// 新增表单一次性 nonce 的有效期(秒): 够用户慢慢填一张表单, 又不至于很久以后还能再用一次
export const FORM_NONCE_TTL = 600;

// 一个表单字段 ↔ 数据库列
// kind:
//   str     文本(去首尾空白)          text  多行文本(保留原样, 如运营文案正文)
//   html    富文本(先净化再 strip)     int   整数(非法回默认)
//   bool    复选框 → 1/0              enum01 下拉 "1"/"0" → 1/0
// form:false 表示该字段不由表单提供(由 validate 算出来, 如首页板块的名称、公告的跳转类型)
export function col(name, options = {}) {
  return {
    name,
    kind: options.kind || 'str',
    default: options.default === undefined ? '' : options.default,
    form: options.form !== false
  };
}

// 一张受控表的 CRUD 声明(模块唯一要写的东西)
export function spec(options) {
  return Object.assign({
    // 基本: key 必须是 entities.js 里登记过的实体键(决定审计前缀); listUrl 是回列表地址
    key: '', table: '', title: '', currentPage: '', listUrl: '', rowLabel: '',
    fields: [],
    // 文案(默认按"通用"给, 各模块可覆盖)
    notFoundEdit: '找不到该记录',
    notFoundDelete: '找不到该记录',
    createdMessage: '添加成功',
    updatedMessage: '已更新',
    deletedMessage: '已删除',
    // 审计
    auditIdField: 'item_id',
    auditKeyField: '',
    deleteAuditFields: [],
    // 钩子(全部可省)
    validate: null,           // async (env, ctx, values, form, oldItem, isNew) → { error, errorField } | null
    saveOwn: null,            // async (env, session, values, form, isNew, rowId, oldItem) → message
    renderEdit: null,         // ({ item, isNew, error, errorField, formNonce, ctx }) → HTML 字符串
    editRedirectFilters: null, // (values, form, isNew) → 回列表保留的筛选参数
    deleteRedirectFilters: null // (form, row) → 同上
  }, options);
}

function readCol(field, form) {
  if (!field.form) return field.default;
  const raw = form[field.name];
  if (field.kind === 'int') return intOr(raw, typeof field.default === 'number' ? field.default : 0);
  if (field.kind === 'bool') return raw ? 1 : 0;
  // enum01 不能写成 `raw ? 1 : 0`: 字符串 "0" 也是真值, 会把「未登录可见」存成「登录可见」(旧站踩过这个坑)
  if (field.kind === 'enum01') return strOf(raw || '0') === '1' ? 1 : 0;
  if (field.kind === 'text') return textOf(raw);
  if (field.kind === 'html') return sanitizeHtml(raw || '').trim();
  return strOf(raw);
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

function isIdLike(value) {
  return Boolean(value) && /^\d+$/.test(String(value).replace('-', ''));
}

async function save(specDef, env, session, values, form, isNew, rowId, oldItem) {
  if (specDef.saveOwn) return specDef.saveOwn(env, session, values, form, isNew, rowId, oldItem);
  const cols = specDef.fields.map((field) => field.name);
  const auditExtra = {};
  if (specDef.auditKeyField) auditExtra[specDef.auditKeyField] = values[specDef.auditKeyField];
  if (isNew) {
    const placeholders = cols.map(() => '?').join(', ');
    const result = await run(
      env,
      `INSERT INTO ${specDef.table} (${cols.join(', ')}) VALUES (${placeholders})`,
      ...cols.map((name) => values[name])
    );
    const inserted = (result && result.meta && result.meta.last_row_id) || 0;
    auditLog(auditAction(specDef.key, 'create'),
      Object.assign({ user: session.username }, { [specDef.auditIdField]: inserted }, auditExtra));
    return specDef.createdMessage;
  }
  const setSql = cols.map((name) => `${name} = ?`).join(', ');
  await run(env, `UPDATE ${specDef.table} SET ${setSql} WHERE id = ?`, ...cols.map((name) => values[name]), rowId);
  auditLog(auditAction(specDef.key, 'update'),
    Object.assign({ user: session.username }, { [specDef.auditIdField]: rowId }, auditExtra));
  return specDef.updatedMessage;
}

// GET/POST 共用的编辑流程(唯一实现)
// 返回 HTML 字符串(渲染编辑页) 或 302 Response(保存成功回列表)
export async function runEdit(specDef, ctx) {
  const { env, session } = ctx;
  const form = ctx.form || {};
  const rowId = intOr((ctx.query || {}).id, 0);
  const isNew = rowId <= 0;
  let error = '';
  let errorField = '';
  let oldItem = null;
  // 每次进入本函数都发一枚新的 nonce(渲染时注入成 <input name="form_nonce">);
  // POST 校验失败重渲染时又是新的一枚 —— 它只是防重凭据, 不是安全令牌(鉴权归会话负责)
  const formNonce = (crypto.randomUUID && crypto.randomUUID().replace(/-/g, '')) || String(Date.now());
  let item;

  if (isNew) {
    item = { id: 0 };
    for (const field of specDef.fields) item[field.name] = field.default;
  } else {
    oldItem = await one(env, `SELECT * FROM ${specDef.table} WHERE id = ?`, rowId).catch(() => null);
    if (!oldItem) {
      return specDef.renderEdit({
        item: null, isNew: false, error: specDef.notFoundEdit, errorField: '', formNonce, ctx
      });
    }
    item = oldItem;
  }

  if (ctx.method === 'POST') {
    const values = {};
    for (const field of specDef.fields) values[field.name] = readCol(field, form);
    if (specDef.validate) {
      const verdict = await specDef.validate(env, ctx, values, form, oldItem, isNew);
      if (verdict) {
        error = verdict.error || '';
        errorField = verdict.errorField || '';
      }
    }
    // 没带 nonce 的请求一律放行: 脚本、自动化、旧表单不该因此被拒; 真机表单一定带(由渲染注入)
    const submitted = strOf(form.form_nonce);
    if (!error && isNew && submitted
      && await isDuplicateSubmit(env, idemKey(`${specDef.key}_create`, String(session.id || '-'), submitted), FORM_NONCE_TTL)) {
      error = '该操作刚刚已执行，请勿重复提交';
    }
    if (!error) {
      try {
        const message = await save(specDef, env, session, values, form, isNew, rowId, oldItem);
        invalidateEntityCache(specDef.key);
        const filters = specDef.editRedirectFilters ? specDef.editRedirectFilters(values, form, isNew) : null;
        return redirect(buildListUrl(specDef.listUrl, { message, filters }));
      } catch (err) {
        // 写失败不能让整页 500: 打全量异常(只有"失败"两个字线上没法排障), 页面回填后给一句人话
        console.error(`保存${specDef.rowLabel}失败 id=${rowId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
    // 校验失败/保存失败/重复提交: 回填用户输入, 不让他重填整张表单
    item = Object.assign({ id: rowId }, values);
  }

  return specDef.renderEdit({ item, isNew, error, errorField, formNonce, ctx });
}

function deleteRedirect(specDef, options = {}) {
  const filters = specDef.deleteRedirectFilters
    ? specDef.deleteRedirectFilters(options.form || {}, options.row || {})
    : null;
  return redirect(buildListUrl(specDef.listUrl, {
    message: options.message, error: options.error, filters
  }));
}

// POST 删除流程(唯一实现): 幂等防重 → 查原行 → 删 → 审计 → 回列表
export async function runDelete(specDef, ctx) {
  const { env, session } = ctx;
  const form = ctx.form || {};
  const rawId = form.id;
  if (!isIdLike(rawId)) return deleteRedirect(specDef, { error: '参数错误', form });

  if (await isDuplicateSubmit(env, idemKey(`${specDef.key}_delete`, String(session.id || '-'), String(rawId)))) {
    return deleteRedirect(specDef, { error: '该操作刚刚已执行，请勿重复提交', form });
  }

  let row = null;
  let message = '';
  try {
    row = await one(env, `SELECT * FROM ${specDef.table} WHERE id = ?`, intOr(rawId, 0));
    if (!row) return deleteRedirect(specDef, { error: specDef.notFoundDelete, form });
    await run(env, `DELETE FROM ${specDef.table} WHERE id = ?`, intOr(rawId, 0));
    const auditExtra = {};
    for (const name of specDef.deleteAuditFields) {
      auditExtra[name] = row[name] === undefined || row[name] === null ? '' : row[name];
    }
    auditLog(auditAction(specDef.key, 'delete'),
      Object.assign({ user: session.username }, { [specDef.auditIdField]: intOr(rawId, 0) }, auditExtra));
    message = specDef.deletedMessage;
  } catch (error) {
    console.error(`删除${specDef.rowLabel}失败 id=${rawId}`, error && error.stack ? error.stack : error);
    return deleteRedirect(specDef, { error: '删除失败，请稍后重试', form });
  }
  invalidateEntityCache(specDef.key);
  return deleteRedirect(specDef, { message, form, row });
}

// 供页面模块拼进后台路由表
export function editHandler(specDef) {
  return (ctx) => runEdit(specDef, ctx);
}

export function deleteHandler(specDef) {
  return (ctx) => runDelete(specDef, ctx);
}
