// 留言管理: 列表(状态/用户/笔记筛选) / 行片段 / 通过·拒绝·删除
// 逐条对齐旧站 fastapi/app/admin/comments_admin.py
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { adminLayout } from '../lib/layout.js';
import { emptyRow, listShell, pagerScript } from '../lib/partials.js';
import { applyStatus, statusActions, statusBadgeClass, statusKind, statusLabel } from '../lib/status.js';
import { PER_PAGE, auditLog, buildListUrl, clampPage, firstScreenLimit, intOr, strOf } from '../lib/utils.js';

const MANAGE_URL = '/admin/comments_manage';
const ALLOWED_STATUS = ['approved', 'pending', 'rejected'];
const COLUMNS = ['ID', '留言内容', '用户', '所属笔记', '状态', '时间', '操作'];

function filtersOf(ctx) {
  const status = ALLOWED_STATUS.includes(strOf(ctx.query.status)) ? strOf(ctx.query.status) : 'all';
  const userId = intOr(ctx.query.user_id, 0);
  const newsId = intOr(ctx.query.news_id, 0);
  const clauses = [];
  const args = [];
  if (status !== 'all') {
    clauses.push('c.status = ?');
    args.push(status);
  }
  if (userId > 0) {
    clauses.push('c.user_id = ?');
    args.push(userId);
  }
  if (newsId > 0) {
    clauses.push('c.news_id = ?');
    args.push(newsId);
  }
  return { status, userId, newsId, sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', args };
}

// 列表与片段共用的 JOIN 查询: 留言 + 作者(昵称/用户名/内部测试) + 所属笔记标题
function listSql(where) {
  return 'SELECT c.*, u.username, u.nickname, u.is_trusted, n.title AS news_title '
    + 'FROM news_comments c LEFT JOIN users u ON c.user_id = u.id '
    + 'LEFT JOIN news n ON c.news_id = n.id' + where;
}

function userLabel(row) {
  return strOf(row.nickname) || strOf(row.username) || '未知用户';
}

function actionsCell(row) {
  const kind = statusKind('comment');
  const buttons = statusActions(kind, row.status).map((action) => `<button type="button" class="btn btn-sm btn-${action.btnClass}"`
    + ` data-status-kind="${kind.key}" data-status-id="${row.id}" data-status-action="${escapeHtml(action.value)}"`
    + `${action.visible ? '' : ' hidden'}>${escapeHtml(action.label)}</button>`).join('');
  return `<div class="action-cell justify-content-center">
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=comment_row&amp;id=${row.id}&amp;back=${encodeURIComponent(MANAGE_URL)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

function renderRows(ctx, rows) {
  if (!rows || !rows.length) return emptyRow(COLUMNS, '暂无留言');
  return rows.map((row) => {
    const kind = statusKind('comment');
    const trusted = intOr(row.is_trusted, 0) === 1 ? ' <span class="badge text-bg-danger">内部测试</span>' : '';
    const newsTitle = strOf(row.news_title) || (row.news_id ? `笔记#${row.news_id}` : '-');
    const newsLink = row.news_id
      ? `<a href="/admin/news_preview?id=${row.news_id}">${escapeHtml(newsTitle)}</a>`
      : escapeHtml(newsTitle);
    return `<tr>
  <td class="text-nowrap">${row.id}</td>
  <td><div class="text-truncate clamp-lg" title="${escapeHtml(strOf(row.content))}">${escapeHtml(strOf(row.content))}</div></td>
  <td class="text-nowrap"><a href="${MANAGE_URL}?user_id=${row.user_id}">${escapeHtml(userLabel(row))}</a>${trusted}</td>
  <td>${newsLink}</td>
  <td class="text-nowrap"><span class="badge text-bg-${statusBadgeClass(kind, row.status)}" data-status-badge>${escapeHtml(statusLabel(kind, row.status))}</span></td>
  <td class="text-nowrap small">${escapeHtml(strOf(row.created_at).slice(0, 19))}</td>
  <td class="text-nowrap">${actionsCell(row)}</td>
</tr>`;
  }).join('');
}

function filterHint(filters) {
  if (filters.userId > 0) return `<div class="alert alert-info" role="alert">正在查看用户 #${filters.userId} 的全部留言</div>`;
  if (filters.newsId > 0) return `<div class="alert alert-info" role="alert">正在查看笔记 #${filters.newsId} 下的留言</div>`;
  return '';
}

function statusPills(filters) {
  const items = [['all', '全部'], ['pending', '待审核'], ['approved', '已通过'], ['rejected', '已拒绝']];
  return `<div class="btn-group btn-group-sm" role="group" aria-label="按状态筛选">
    ${items.map(([value, label]) => {
    const params = new URLSearchParams();
    params.set('status', value);
    if (filters.userId > 0) params.set('user_id', String(filters.userId));
    if (filters.newsId > 0) params.set('news_id', String(filters.newsId));
    return `<a class="btn btn-outline-secondary${filters.status === value ? ' active' : ''}" href="${MANAGE_URL}?${params.toString()}">${label}</a>`;
  }).join('')}
  </div>`;
}

async function managePage(ctx) {
  const filters = filtersOf(ctx);
  let total = 0;
  let totalPages = 1;
  let page = 1;
  let rows = [];
  let error = '';
  try {
    total = intOr((await one(ctx.env, `SELECT COUNT(*) AS total FROM news_comments c${filters.sql}`, ...filters.args)).total, 0);
    totalPages = Math.max(Math.ceil(total / PER_PAGE), 1);
    const limited = firstScreenLimit(ctx.query.page, PER_PAGE, totalPages);
    page = limited[0];
    rows = await all(ctx.env, `${listSql(filters.sql)} ORDER BY c.created_at DESC LIMIT ?`, ...filters.args, limited[1]);
  } catch (err) {
    console.error('获取留言列表失败', err && err.message);
    rows = [];
    error = '读取数据失败，请稍后重试';
  }
  const content = filterHint(filters) + listShell({
    title: '留言管理', columns: COLUMNS, rows: renderRows(ctx, rows), actions: statusPills(filters),
    tbodyId: 'commentTbody', sentinelId: 'commentLoadMore', textId: 'commentLoadMoreText',
    hintId: 'commentLoadedHint', total, perPage: PER_PAGE, currentPage: page, totalPages,
    unit: '条', backTopId: 'commentBackTopBtn', jumpBtnId: 'commentJumpBtn', jumpInputId: 'commentJumpInput'
  });
  const query = new URLSearchParams(ctx.query).toString();
  return adminLayout({
    title: '留言管理', currentPage: 'comments_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content,
    scripts: pagerScript({
      tbodyId: 'commentTbody', sentinelId: 'commentLoadMore', textId: 'commentLoadMoreText',
      rowsUrl: `/admin/comments_rows${query ? `?${query}` : ''}`, currentPage: page, totalPages, total,
      perPage: PER_PAGE, unit: '条', hintId: 'commentLoadedHint', announceLabel: '留言',
      baseUrl: MANAGE_URL, backTopId: 'commentBackTopBtn', jumpBtnId: 'commentJumpBtn',
      jumpInputId: 'commentJumpInput', version: ctx.version
    })
  });
}

async function rowsFragment(ctx) {
  const filters = filtersOf(ctx);
  const page = clampPage(ctx.query.page, null);
  let rows = [];
  try {
    rows = await all(ctx.env,
      `${listSql(filters.sql)} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
      ...filters.args, PER_PAGE + 1, (page - 1) * PER_PAGE);
  } catch (err) {
    console.error('获取留言分页数据失败', err && err.message);
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

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

// 写操作: 通过/拒绝走统一状态接口(comment 是 superOnly), 删除是**物理删除、没有回收站**
async function writeSubmit(ctx) {
  const form = ctx.form;
  const action = strOf(form.action);
  const rawId = form.id || form.news_id || form.comment_id;
  if (action === 'delete') {
    if (!rawId || !/^\d+$/.test(String(rawId).replace('-', ''))) {
      return redirect(buildListUrl(MANAGE_URL, { error: '参数错误' }));
    }
    try {
      await run(ctx.env, 'DELETE FROM news_comments WHERE id = ?', intOr(rawId, 0));
      auditLog('admin.comment.delete', { user: ctx.session.username, comment_id: intOr(rawId, 0) });
      return redirect(buildListUrl(MANAGE_URL, { message: '留言已删除（不可恢复）' }));
    } catch (err) {
      console.error(`删除留言失败 id=${rawId}`, err && err.message);
      return redirect(buildListUrl(MANAGE_URL, { error: '操作失败，请稍后重试' }));
    }
  }
  if (action === 'approve' || action === 'reject') {
    const kind = statusKind('comment');
    const payload = await applyStatus(ctx.env, ctx.session, kind, rawId,
      action === 'approve' ? 'approved' : 'rejected');
    if (payload.success) return redirect(buildListUrl(MANAGE_URL, { message: payload.message }));
    return redirect(buildListUrl(MANAGE_URL, { error: payload.message || '操作失败，请稍后重试' }));
  }
  return redirect(buildListUrl(MANAGE_URL, { error: '未识别的操作' }));
}

export const routes = [
  { methods: ['GET', 'POST'], path: MANAGE_URL, handler: (ctx) => (ctx.method === 'POST' ? writeSubmit(ctx) : managePage(ctx)) },
  { methods: ['GET', 'HEAD'], path: '/admin/comments_rows', handler: rowsFragment }
];
