// 用户笔记审核: 列表(状态/用户筛选) / 行片段 / 通过·驳回·移入回收站(仅超管)
// 逐条对齐旧站 fastapi/app/admin/users_admin.py 的 user_news_manage 那部分
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { assetUrl } from '../../core/media_scheme.js';
import { beijingNow } from '../../core/timeutil.js';
import { adminLayout } from '../lib/layout.js';
import { getNameMap, nameFor } from '../lib/categorySource.js';
import { emptyRow, listShell, pagerScript } from '../lib/partials.js';
import { applyStatus, statusActions, statusBadgeClass, statusKind, statusLabel } from '../lib/status.js';
import {
  PER_PAGE, auditLog, buildListUrl, clampPage, firstScreenLimit, intOr, invalidateEntityCache, strOf
} from '../lib/utils.js';

const MANAGE_URL = '/admin/user_news_manage';
const STATUS_VALUES = ['pending', 'approved', 'rejected'];
const COLUMNS = ['ID', '作者', '标题', '分类', '图片', '状态', '发布时间', '操作'];
// 列清单: 不要 SELECT n.* —— 正文每行 20KB 而列表根本不显示它
const LIST_COLUMNS = 'n.id, n.user_id, n.title, n.category, n.image, n.publish_time, n.status, n.type, '
  + 'n.view_count, n.likes, n.favorites';

function filtersOf(source) {
  const status = STATUS_VALUES.includes(strOf(source.status)) ? strOf(source.status) : 'all';
  const userId = intOr(source.user_id, 0);
  const clauses = ["n.type = 'users'", 'n.deleted_at IS NULL'];
  const args = [];
  if (status !== 'all') {
    clauses.push('n.status = ?');
    args.push(status);
  }
  if (userId > 0) {
    clauses.push('n.user_id = ?');
    args.push(userId);
  }
  return { status, userId, sql: clauses.join(' AND '), args };
}

function renderRows(ctx, rows) {
  if (!rows || !rows.length) return emptyRow(COLUMNS, '该分类下暂无用户笔记');
  const kind = statusKind('user_news');
  return rows.map((row) => {
    const image = strOf(row.image);
    const cover = image
      ? `<img src="${escapeHtml(assetUrl(ctx.env, image, ''))}" class="cover-thumb" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '-';
    const buttons = statusActions(kind, row.status).map((action) => `<button type="button" class="btn btn-sm btn-${action.btnClass}"`
      + ` data-status-kind="${kind.key}" data-status-id="${row.id}" data-status-action="${escapeHtml(action.value)}"`
      + `${action.visible ? '' : ' hidden'}>${escapeHtml(action.label)}</button>`).join('');
    const author = strOf(row.user_nickname) || strOf(row.user_username) || `用户#${row.user_id}`;
    return `<tr>
  <td class="text-nowrap">${row.id}</td>
  <td class="text-nowrap"><a href="${MANAGE_URL}?user_id=${row.user_id}">${escapeHtml(author)}</a></td>
  <td><a href="/admin/news_preview?id=${row.id}" target="_blank" rel="noopener">${escapeHtml(strOf(row.title) || '(无标题)')}</a></td>
  <td class="text-nowrap">${escapeHtml(nameFor(ctx.nameMap || {}, row.category, strOf(row.category)) || '-')}</td>
  <td>${cover}</td>
  <td class="text-nowrap"><span class="badge text-bg-${statusBadgeClass(kind, row.status)}" data-status-badge>${escapeHtml(statusLabel(kind, row.status))}</span></td>
  <td class="text-nowrap small">${escapeHtml(strOf(row.publish_time).slice(0, 16))}</td>
  <td class="text-nowrap">
    <div class="action-cell justify-content-center">
      ${buttons}
      <form method="post" class="d-inline">
        <input type="hidden" name="action" value="delete">
        <input type="hidden" name="news_id" value="${row.id}">
        <input type="hidden" name="status" value="${escapeHtml(strOf(ctx.query.status) || 'all')}">
        <input type="hidden" name="user_id" value="${escapeHtml(strOf(ctx.query.user_id))}">
        <input type="hidden" name="page" value="${clampPage(ctx.query.page, null)}">
        <button class="btn btn-sm btn-outline-danger" type="submit"
                onclick="return confirm('把这条用户笔记移入回收站？')"><i class="bi bi-trash" aria-hidden="true"></i> 删除</button>
      </form>
    </div>
  </td>
</tr>`;
  }).join('');
}

function statusPills(filters) {
  const items = [['all', '全部'], ['pending', '待审核'], ['approved', '已通过'], ['rejected', '已驳回']];
  return `<div class="btn-group btn-group-sm" role="group" aria-label="按状态筛选">
    ${items.map(([value, label]) => {
    const params = new URLSearchParams({ status: value });
    if (filters.userId > 0) params.set('user_id', String(filters.userId));
    return `<a class="btn btn-outline-secondary${filters.status === value ? ' active' : ''}" href="${MANAGE_URL}?${params.toString()}">${label}</a>`;
  }).join('')}
  </div>`;
}

async function managePage(ctx) {
  const filters = filtersOf(ctx.query);
  let total = 0;
  let totalPages = 1;
  let page = 1;
  let rows = [];
  let error = '';
  let nameMap = {};
  try {
    total = intOr((await one(ctx.env, `SELECT COUNT(*) AS total FROM news n WHERE ${filters.sql}`, ...filters.args)).total, 0);
    totalPages = Math.max(Math.ceil(total / PER_PAGE), 1);
    const limited = firstScreenLimit(ctx.query.page, PER_PAGE, totalPages);
    page = limited[0];
    rows = await all(ctx.env,
      `SELECT ${LIST_COLUMNS}, u.nickname AS user_nickname, u.username AS user_username `
      + `FROM news n LEFT JOIN users u ON n.user_id = u.id WHERE ${filters.sql} `
      + 'ORDER BY n.publish_time DESC, n.id DESC LIMIT ?',
      ...filters.args, limited[1]);
    nameMap = await getNameMap(ctx.env);
  } catch (err) {
    // 异常时也要把渲染要用的变量赋好, 避免渲染阶段再次报错
    console.error('获取用户笔记列表失败', err && err.message);
    rows = [];
    total = 0;
    totalPages = 1;
    page = 1;
    error = '获取用户笔记失败，请稍后重试';
  }
  ctx.nameMap = nameMap;
  const hint = filters.userId > 0
    ? `<div class="alert alert-info" role="alert">正在查看用户 #${filters.userId} 的笔记</div>` : '';
  const query = new URLSearchParams(ctx.query).toString();
  const content = hint + listShell({
    title: '用户笔记', columns: COLUMNS, rows: renderRows(ctx, rows), actions: statusPills(filters),
    tbodyId: 'userNewsTbody', sentinelId: 'userNewsLoadMore', textId: 'userNewsLoadMoreText',
    hintId: 'userNewsLoadedHint', total, perPage: PER_PAGE, currentPage: page, totalPages,
    unit: '条', backTopId: 'userNewsBackTopBtn', jumpBtnId: 'userNewsJumpBtn', jumpInputId: 'userNewsJumpInput'
  });
  return adminLayout({
    title: '用户笔记审核', currentPage: 'user_news_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content,
    scripts: pagerScript({
      tbodyId: 'userNewsTbody', sentinelId: 'userNewsLoadMore', textId: 'userNewsLoadMoreText',
      rowsUrl: `/admin/user_news_rows${query ? `?${query}` : ''}`, currentPage: page, totalPages,
      total, perPage: PER_PAGE, unit: '条', hintId: 'userNewsLoadedHint', announceLabel: '用户笔记',
      baseUrl: MANAGE_URL, backTopId: 'userNewsBackTopBtn', jumpBtnId: 'userNewsJumpBtn',
      jumpInputId: 'userNewsJumpInput', version: ctx.version
    })
  });
}

async function rowsFragment(ctx) {
  const filters = filtersOf(ctx.query);
  const page = clampPage(ctx.query.page, null);
  let rows = [];
  let nameMap = {};
  try {
    rows = await all(ctx.env,
      `SELECT ${LIST_COLUMNS}, u.nickname AS user_nickname, u.username AS user_username `
      + `FROM news n LEFT JOIN users u ON n.user_id = u.id WHERE ${filters.sql} `
      + 'ORDER BY n.publish_time DESC, n.id DESC LIMIT ? OFFSET ?',
      ...filters.args, PER_PAGE + 1, (page - 1) * PER_PAGE);
    nameMap = await getNameMap(ctx.env);
  } catch (err) {
    console.error('获取用户笔记分页数据失败', err && err.message);
    return json({ success: false, message: '加载失败，请稍后重试' });
  }
  const hasMore = rows.length > PER_PAGE;
  rows = rows.slice(0, PER_PAGE);
  if (!rows.length) return json({ success: true, rows: '', has_more: false });
  ctx.nameMap = nameMap;
  return json({ success: true, rows: renderRows(ctx, rows), has_more: hasMore });
}

function json(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

async function writeSubmit(ctx) {
  const form = ctx.form;
  const action = strOf(form.action);
  const rawId = strOf(form.news_id);
  const filters = { user_id: strOf(form.user_id), status: strOf(form.status) || 'all' };
  const page = strOf(form.page) || null;
  let message = '';
  let error = '';

  if (!/^\d+$/.test(rawId.replace('-', ''))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '参数错误', filters, page }));
  }
  const newsId = intOr(rawId, 0);
  try {
    if (action === 'approve' || action === 'reject') {
      // 统一状态接口: user_news 是 superOnly, 权限与文案都只有一份真值
      const payload = await applyStatus(ctx.env, ctx.session, statusKind('user_news'), newsId,
        action === 'approve' ? 'approved' : 'rejected');
      if (payload.success) message = payload.message;
      else error = payload.message || '操作失败，请稍后重试';
    } else if (action === 'delete') {
      // 软删除进回收站(可恢复); 必须校验影响行数, 否则会谎报"已移入回收站"
      const result = await run(ctx.env,
        "UPDATE news SET deleted_at = ? WHERE id = ? AND type = 'users' AND deleted_at IS NULL",
        beijingNow(), newsId);
      const affected = intOr(result && result.meta && result.meta.changes, 0);
      if (!affected) {
        error = '笔记不存在或已被删除';
      } else {
        invalidateEntityCache('news');
        auditLog('admin.user_news.delete', { user: ctx.session.username, news_id: newsId });
        message = '笔记已移入回收站';
      }
    } else {
      error = '未识别的操作';
    }
  } catch (err) {
    console.error('审核操作失败', err && err.message);
    error = '操作失败，请稍后再试';
  }
  return redirect(buildListUrl(MANAGE_URL, { message, error, filters, page }));
}

export const routes = [
  { methods: ['GET', 'POST'], path: MANAGE_URL, handler: (ctx) => (ctx.method === 'POST' ? writeSubmit(ctx) : managePage(ctx)) },
  { methods: ['GET', 'HEAD'], path: '/admin/user_news_rows', handler: rowsFragment }
];
