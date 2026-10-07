// 通知公告: 列表(搜索 + 触底分页) / 行片段 / 新增编辑 / 删除
// 逐条对齐旧站 fastapi/app/admin/notices.py
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { beijingNow } from '../../core/timeutil.js';
import { adminLayout } from '../lib/layout.js';
import {
  editShell, emptyRow, hiddenField, listShell, numberField, pagerScript, selectField,
  switchField, textareaField, textField
} from '../lib/partials.js';
import { statusActions, statusBadgeClass, statusKind, statusLabel } from '../lib/status.js';
import {
  PER_PAGE, auditLog, buildListUrl, clampPage, firstScreenLimit, intOr,
  invalidateEntityCache, strOf, textOf
} from '../lib/utils.js';

const MANAGE_URL = '/admin/notice_manage';
const LEVELS = [['info', '公告'], ['warning', '提醒'], ['important', '重要']];
const LEVEL_LABELS = Object.fromEntries(LEVELS);
const LEVEL_BADGES = { important: 'danger', warning: 'warning', info: 'secondary' };
const DEFAULT_LEVEL = 'info';
const COLUMNS = ['ID', '标题', '类型', '生效时间', '排序', '状态', '操作'];

// 页面路径前缀: 公告的"跳转页面"只接受小程序页面, 与旧站 catalog.is_page_path 同口径
const PAGE_PREFIXES = ['/pages/', '/subpackages/'];
const isPagePath = (value) => PAGE_PREFIXES.some((prefix) => strOf(value).startsWith(prefix));

// 只按标题搜: 正文几百字, 全表 LIKE 慢(旧站也是这个取舍)
function noticeWhere(keyword, status) {
  const clauses = [];
  const args = [];
  if (keyword) {
    clauses.push('title LIKE ?');
    args.push(`%${keyword}%`);
  }
  if (status === '1' || status === '0') {
    clauses.push('status = ?');
    args.push(intOr(status, 0));
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', args };
}

// datetime-local 提交带 "T": SQLite 里该列是 TEXT 且按字符串比较,
// 'T'(0x54) > ' '(0x20) 会让"设了开始时间的公告"永不展示(旧站踩过), 这里统一成 "YYYY-MM-DD HH:MM:SS"
function normalizeDatetime(value) {
  const text = strOf(value);
  if (!text) return '';
  const normalized = text.replace('T', ' ');
  return normalized.length === 16 ? `${normalized}:00` : normalized.slice(0, 19);
}

function fmtTime(value) {
  const text = strOf(value);
  return text ? text.slice(0, 16) : '不限';
}

function statusCell(ctx, row) {
  const kind = statusKind('app_notice');
  const notes = [];
  const now = beijingNow();
  if (intOr(row.status, 0) !== 1) notes.push('<span class="text-danger">已停用，小程序不显示</span>');
  else if (strOf(row.start_at) && strOf(row.start_at) > now) notes.push('<span class="text-muted">未到生效时间</span>');
  else if (strOf(row.end_at) && strOf(row.end_at) < now) notes.push('<span class="text-muted">已过生效时间</span>');
  const badge = `<span class="badge text-bg-${statusBadgeClass(kind, row.status)}" data-status-badge>${escapeHtml(statusLabel(kind, row.status))}</span>`;
  return badge + (notes.length ? '<div class="small mt-1">' + notes.join('<br>') + '</div>' : '');
}

function actionsCell(ctx, row) {
  const kind = statusKind('app_notice');
  const page = clampPage(ctx.query.page, null);
  const buttons = statusActions(kind, row.status).map((action) => `<button type="button" class="btn btn-sm btn-${action.btnClass}"`
    + ` data-status-kind="${kind.key}" data-status-id="${row.id}" data-status-action="${escapeHtml(action.value)}"`
    + `${action.visible ? '' : ' hidden'}>${escapeHtml(action.label)}</button>`).join('');
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="/admin/notice_edit?id=${row.id}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=notice&amp;id=${row.id}&amp;page=${page}&amp;back=${encodeURIComponent(MANAGE_URL)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

export function renderRows(ctx, rows) {
  if (!rows || !rows.length) return emptyRow(COLUMNS, '暂无公告');
  return rows.map((row) => {
    const level = LEVEL_LABELS[strOf(row.level)] ? strOf(row.level) : DEFAULT_LEVEL;
    const link = strOf(row.link_value);
    const title = escapeHtml(row.title || '-');
    const linkHtml = link
      ? `<div class="small text-muted text-truncate"><code>${escapeHtml(link)}</code> <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></div>`
      : '';
    return `<tr>
  <td class="text-nowrap">${row.id}</td>
  <td><div class="text-truncate clamp-lg" title="${escapeHtml(row.title || '')}">${title}</div>${linkHtml}</td>
  <td class="text-nowrap"><span class="badge text-bg-${LEVEL_BADGES[level]}">${escapeHtml(LEVEL_LABELS[level])}</span></td>
  <td class="text-nowrap small">${escapeHtml(fmtTime(row.start_at))} ~ ${escapeHtml(fmtTime(row.end_at))}</td>
  <td class="text-nowrap">${row.sort_order}</td>
  <td class="text-nowrap">${statusCell(ctx, row)}</td>
  <td class="text-nowrap">${actionsCell(ctx, row)}</td>
</tr>`;
  }).join('');
}

async function managePage(ctx) {
  const keyword = strOf(ctx.query.keyword);
  const status = strOf(ctx.query.status);
  const where = noticeWhere(keyword, status);
  let total = 0;
  let totalPages = 1;
  let page = 1;
  let rows = [];
  let error = '';
  try {
    const counted = await one(ctx.env, `SELECT COUNT(*) AS total FROM app_notices${where.sql}`, ...where.args);
    total = intOr(counted && counted.total, 0);
    totalPages = Math.max(Math.ceil(total / PER_PAGE), 1);
    const limited = firstScreenLimit(ctx.query.page, PER_PAGE, totalPages);
    page = limited[0];
    rows = await all(ctx.env,
      `SELECT * FROM app_notices${where.sql} ORDER BY sort_order ASC, id DESC LIMIT ?`,
      ...where.args, limited[1]);
  } catch (err) {
    console.error('获取公告列表失败', err && err.message);
    rows = [];
    error = '读取数据失败，请稍后重试';
  }
  const searchForm = `<form class="d-flex flex-wrap gap-2" method="get" action="${MANAGE_URL}">
    <input type="search" class="form-control form-control-sm" name="keyword" value="${escapeHtml(keyword)}" placeholder="按标题搜索" style="max-width:200px">
    <select class="form-select form-select-sm" name="status" style="max-width:120px">
      <option value="all">全部状态</option>
      <option value="1"${status === '1' ? ' selected' : ''}>启用</option>
      <option value="0"${status === '0' ? ' selected' : ''}>停用</option>
    </select>
    <button class="btn btn-sm btn-outline-secondary" type="submit"><i class="bi bi-search" aria-hidden="true"></i> 搜索</button>
  </form>`;
  const content = listShell({
    title: '通知公告', columns: COLUMNS, rows: renderRows(ctx, rows),
  tableAttrs: ' data-status-filter-param="status"',
    actions: `<a class="btn btn-primary" href="/admin/notice_edit?id=0"><i aria-hidden="true" class="bi bi-plus-lg"></i> 添加公告</a>${searchForm}`,
    tbodyId: 'noticeTbody', sentinelId: 'noticeLoadMore', textId: 'noticeLoadMoreText',
    hintId: 'noticeLoadedHint', total, perPage: PER_PAGE, currentPage: page, totalPages,
    unit: '条', backTopId: 'noticeBackTopBtn', jumpBtnId: 'noticeJumpBtn', jumpInputId: 'noticeJumpInput'
  });
  return adminLayout({
    title: '通知公告管理', currentPage: 'notice_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content,
    scripts: pagerScript({
      tbodyId: 'noticeTbody', sentinelId: 'noticeLoadMore', textId: 'noticeLoadMoreText',
      rowsUrl: '/admin/notice_rows', currentPage: page, totalPages, total, perPage: PER_PAGE,
      unit: '条', hintId: 'noticeLoadedHint', announceLabel: '公告', baseUrl: MANAGE_URL,
      backTopId: 'noticeBackTopBtn', jumpBtnId: 'noticeJumpBtn', jumpInputId: 'noticeJumpInput',
      version: ctx.version
    })
  });
}

async function rowsFragment(ctx) {
  const keyword = strOf(ctx.query.keyword);
  const status = strOf(ctx.query.status);
  const where = noticeWhere(keyword, status);
  const page = clampPage(ctx.query.page, null);
  let rows = [];
  try {
    rows = await all(ctx.env,
      `SELECT * FROM app_notices${where.sql} ORDER BY sort_order ASC, id DESC LIMIT ? OFFSET ?`,
      ...where.args, PER_PAGE + 1, (page - 1) * PER_PAGE);
  } catch (err) {
    console.error('获取公告分页数据失败', err && err.message);
    return json({ success: false, message: '加载失败，请稍后重试' });
  }
  const hasMore = rows.length > PER_PAGE;
  rows = rows.slice(0, PER_PAGE);
  if (!rows.length) return json({ success: true, rows: '', has_more: false });
  return json({ success: true, rows: renderRows(ctx, rows), has_more: hasMore });
}

function json(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function editPage(ctx) {
  const noticeId = intOr(ctx.query.id, 0);
  const isNew = noticeId <= 0;
  let error = ctx.error || '';
  let errorField = '';
  let row;
  if (isNew) {
    row = {
      id: 0, title: '', content: '', level: DEFAULT_LEVEL, link_type: '', link_value: '',
      start_at: '', end_at: '', sort_order: 0, status: 1
    };
  } else {
    row = await one(ctx.env, 'SELECT * FROM app_notices WHERE id = ?', noticeId).catch(() => null);
    if (!row) return editView(ctx, { isNew: false, row: null, error: '找不到该公告', errorField: '' });
  }

  if (ctx.method === 'POST') {
    const form = ctx.form;
    const title = strOf(form.title);
    const content = textOf(form.content);
    const level = strOf(form.level) || DEFAULT_LEVEL;
    const linkValue = strOf(form.link_value);
    const startAt = normalizeDatetime(form.start_at);
    const endAt = normalizeDatetime(form.end_at);
    const sortOrder = intOr(form.sort_order, 0);
    const status = form.status ? 1 : 0;
    // link_type 由 link_value 派生(不是表单字段)
    const linkType = isPagePath(linkValue) ? 'page' : '';
    row = { id: noticeId, title, content, level, link_type: linkType, link_value: linkValue, start_at: startAt, end_at: endAt, sort_order: sortOrder, status };

    if (!title) {
      error = '请填写公告标题';
      errorField = 'title';
    } else if (!LEVEL_LABELS[level]) {
      error = '公告类型不正确';
      errorField = 'level';
    } else if (linkValue && !linkType) {
      error = '跳转页面必须以 /pages/ 或 /subpackages/ 开头, 或留空表示不跳转';
      errorField = 'link_value';
    } else if (startAt && endAt && startAt > endAt) {
      error = '生效开始时间不能晚于结束时间';
      errorField = 'end_at';
    }

    if (!error) {
      try {
        if (isNew) {
          await run(ctx.env,
            'INSERT INTO app_notices (title, content, level, link_type, link_value, start_at, end_at, sort_order, status, create_time) VALUES (?,?,?,?,?,?,?,?,?,?)',
            title, content, level, linkType, linkValue, startAt, endAt, sortOrder, status, beijingNow());
        } else {
          await run(ctx.env,
            'UPDATE app_notices SET title=?, content=?, level=?, link_type=?, link_value=?, start_at=?, end_at=?, sort_order=?, status=? WHERE id=?',
            title, content, level, linkType, linkValue, startAt, endAt, sortOrder, status, noticeId);
        }
        invalidateEntityCache('notice');
        auditLog(`admin.app_notice.${isNew ? 'create' : 'update'}`, { user: ctx.session.username, notice_id: noticeId, title });
        return redirect(buildListUrl(MANAGE_URL, { message: isNew ? '公告已添加' : '公告已更新' }));
      } catch (err) {
        console.error(`保存公告失败 id=${noticeId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }
  return editView(ctx, { isNew, row, error, errorField });
}

function editView(ctx, { isNew, row, error, errorField }) {
  if (!row) {
    return adminLayout({
      title: '编辑公告', currentPage: 'notice_manage', admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: error || '找不到该公告',
      content: '<div class="card"><div class="card-body">找不到该公告，可能已被删除。</div></div>'
    });
  }
  const main = textField({
    name: 'title', label: '公告标题', value: row.title, required: true, maxlength: 100,
    placeholder: '如 系统维护通知', errorField
  }) + textareaField({
    name: 'content', label: '公告正文', value: row.content, rows: 8, errorField
  }) + textField({
    name: 'link_value', label: '跳转页面', value: row.link_value, maxlength: 500, errorField,
    placeholder: '小程序页面路径，如 /pages/notice/notice?id=1（留空表示不跳转）'
  });
  const side = selectField({ name: 'level', label: '公告类型', options: LEVELS, value: row.level, errorField })
    + textField({ name: 'start_at', label: '生效开始时间', value: row.start_at, errorField, placeholder: 'YYYY-MM-DD HH:MM' })
    + textField({ name: 'end_at', label: '生效结束时间', value: row.end_at, errorField, placeholder: 'YYYY-MM-DD HH:MM' })
    + numberField({ name: 'sort_order', label: '排序 (小在前)', value: row.sort_order, errorField })
    + switchField({ name: 'status', label: '立即启用', checked: intOr(row.status, 0) === 1 });
  const content = editShell({
    action: `/admin/notice_edit${isNew ? '' : `?id=${row.id}`}`,
    main, side, backUrl: MANAGE_URL, backLabel: '返回列表',
    primaryLabel: isNew ? '添加公告' : '保存修改'
  });
  return adminLayout({
    title: '编辑公告', currentPage: 'notice_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error, content
  });
}

async function deleteSubmit(ctx) {
  const rawId = ctx.form.id;
  if (!rawId || !/^\d+$/.test(String(rawId).replace('-', ''))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '参数错误' }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, 'SELECT title FROM app_notices WHERE id = ?', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该公告' }));
    await run(ctx.env, 'DELETE FROM app_notices WHERE id = ?', intOr(rawId, 0));
    auditLog('admin.app_notice.delete', { user: ctx.session.username, notice_id: intOr(rawId, 0), title: row.title || '' });
    invalidateEntityCache('notice');
    message = '公告已删除';
  } catch (err) {
    console.error(`删除公告失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试' }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message }));
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['GET', 'HEAD'], path: '/admin/notice_rows', handler: rowsFragment },
  { methods: ['GET', 'POST'], path: '/admin/notice_edit', handler: editPage },
  { methods: ['POST'], path: '/admin/notice_delete', handler: deleteSubmit }
];
