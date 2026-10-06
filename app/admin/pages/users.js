// 用户管理: 列表(搜索 + 内部测试筛选) / 行片段 / 详情 / 设或取消内部测试 / 恢复 / 删除
// 逐条对齐旧站 fastapi/app/admin/users_admin.py
// 两条铁律(旧站注释里写明):
//   ① 昵称与头像**直接读数据库字段**, 展示层不做任何派生/拼接(否则会出现"后台显示的名字和数据库不一样");
//   ② 账号状态徽章按**真实状态**判断(status / deleted_at), 与昵称里有没有后缀是两件事。
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { assetUrl } from '../../core/media_scheme.js';
import { adminLayout } from '../lib/layout.js';
import { backButton, emptyRow, listShell, pagerScript } from '../lib/partials.js';
import {
  PER_PAGE, auditLog, buildListUrl, clampPage, firstScreenLimit, fmtDatetime, idemKey,
  intOr, isDuplicateSubmit, strOf
} from '../lib/utils.js';

const MANAGE_URL = '/admin/users';
const COLUMNS = ['ID', '用户', '昵称', '邮箱', '类型', '注册时间', '最近登录', '操作'];
const TRUSTED_FILTERS = ['all', 'trusted', 'untrusted'];

// 账号状态: status!=0 → 已注销; status=0 且 deleted_at 非空 → 已恢复(曾被注销过)
function accountStateOf(row) {
  if (intOr(row.status, 0) !== 0) return '已注销';
  return row.deleted_at ? '已恢复' : '正常';
}

function typeBadges(row) {
  const badges = [];
  badges.push(intOr(row.is_trusted, 0) === 1
    ? '<span class="badge text-bg-danger">内部测试</span>'
    : '<span class="badge text-bg-secondary">普通</span>');
  if (strOf(row.login_type) === 'wechat') badges.push('<span class="badge text-bg-info">微信</span>');
  const state = accountStateOf(row);
  if (state === '已注销') badges.push('<span class="badge text-bg-dark">已注销</span>');
  if (state === '已恢复') badges.push('<span class="badge text-bg-info">已恢复</span>');
  return badges.join(' ');
}

function actionsCell(ctx, row) {
  const detail = `<a class="btn btn-sm btn-outline-primary" href="/admin/user_detail?id=${row.id}">详情</a>`;
  // 敏感操作仅超管可见(权限口径与分发前拦截、与旧站中间件一致)
  if (!ctx.session.isSuper) return `<div class="action-cell justify-content-center">${detail}</div>`;
  const page = clampPage(ctx.query.page, null);
  // 动作字段走隐藏域: 提交按钮的 name/value 会被"提交时禁用按钮"的脚本丢掉, 隐藏域不受影响。
  const base = `<input type="hidden" name="user_id" value="${row.id}"><input type="hidden" name="page" value="${page}">`;
  // 两个方向都改用户能看到的范围, 与"恢复账号"一样先确认再提交
  const trusted = intOr(row.is_trusted, 0) === 1
    ? `<form method="post" class="d-inline">${base}<input type="hidden" name="action" value="remove_trusted"><button class="btn btn-sm btn-outline-secondary" type="submit"
         onclick="return confirm('取消该用户的内部测试身份？取消后将失去专题视频查看、留言免审与「仅内部测试可见」菜单。')">取消内部测试</button></form>`
    : `<form method="post" class="d-inline">${base}<input type="hidden" name="action" value="set_trusted"><button class="btn btn-sm btn-outline-secondary" type="submit"
         onclick="return confirm('设为内部测试用户？设置后可查看专题视频、留言免审，并看到「仅内部测试可见」的菜单。')">设为内部测试</button></form>`;
  const restore = intOr(row.status, 0) !== 0
    ? `<form method="post" class="d-inline">${base}<input type="hidden" name="action" value="restore_user"><button class="btn btn-sm btn-outline-success" type="submit"
         onclick="return confirm('恢复该账号？恢复后他可以正常登录。')">恢复账号</button></form>`
    : '';
  const remove = `<a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=user&amp;id=${row.id}&amp;back=${encodeURIComponent(MANAGE_URL)}">删除</a>`;
  return `<div class="action-cell justify-content-center">${detail}${trusted}${restore}${remove}</div>`;
}

function renderRows(ctx, users) {
  if (!users || !users.length) return emptyRow(COLUMNS, '没有匹配的用户');
  return users.map((row) => {
    const avatar = strOf(row.avatar);
    const avatarHtml = avatar
      ? `<img src="${escapeHtml(assetUrl(ctx.env, avatar, ''))}" class="rounded-circle" style="width:30px;height:30px;object-fit:cover" alt="" onerror="this.style.visibility='hidden'">`
      : '';
    return `<tr>
  <td class="text-nowrap">${row.id}</td>
  <td class="text-nowrap">${avatarHtml} <a href="/admin/user_detail?id=${row.id}">${escapeHtml(strOf(row.username) || '-')}</a></td>
  <td>${escapeHtml(strOf(row.nickname) || '-')}</td>
  <td class="text-nowrap">${escapeHtml(strOf(row.email) || '-')}</td>
  <td class="text-nowrap">${typeBadges(row)}</td>
  <td class="text-nowrap small">${escapeHtml(fmtDatetime(row.create_time, '') || '-')}</td>
  <td class="text-nowrap small">${escapeHtml(fmtDatetime(row.last_login_time, '') || '未登录')}</td>
  <td class="text-nowrap">${actionsCell(ctx, row)}</td>
</tr>`;
  }).join('');
}

function filtersOf(source) {
  const search = strOf(source.search);
  const trusted = TRUSTED_FILTERS.includes(strOf(source.trusted)) ? strOf(source.trusted) : 'all';
  const clauses = [];
  const args = [];
  if (search) {
    clauses.push('(username LIKE ? OR email LIKE ?)');
    args.push(`%${search}%`, `%${search}%`);
  }
  if (trusted === 'trusted') clauses.push('is_trusted = 1');
  if (trusted === 'untrusted') clauses.push('is_trusted = 0');
  return { search, trusted, sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', args };
}

const LIST_COLUMNS = 'id, username, nickname, email, avatar, login_type, is_trusted, status, '
  + 'create_time, last_login_time, deleted_at, orig_nickname, orig_avatar, nickname_modified';

async function managePage(ctx) {
  const filters = filtersOf(ctx.query);
  let total = 0;
  let totalPages = 1;
  let page = 1;
  let users = [];
  let error = '';
  try {
    total = intOr((await one(ctx.env, `SELECT COUNT(*) AS total FROM users${filters.sql}`, ...filters.args)).total, 0);
    totalPages = Math.max(Math.ceil(total / PER_PAGE), 1);
    const limited = firstScreenLimit(ctx.query.page, PER_PAGE, totalPages);
    page = limited[0];
    users = await all(ctx.env, `SELECT ${LIST_COLUMNS} FROM users${filters.sql} ORDER BY id ASC LIMIT ?`, ...filters.args, limited[1]);
  } catch (err) {
    console.error('获取用户列表失败', err && err.message);
    users = [];
    error = '获取用户列表失败，请稍后重试';
  }
  const searchForm = `<form class="d-flex flex-wrap gap-2" method="get" action="${MANAGE_URL}">
    <input type="search" class="form-control form-control-sm" name="search" value="${escapeHtml(filters.search)}"
           placeholder="按用户名或邮箱搜索" style="max-width:220px">
    <select class="form-select form-select-sm" name="trusted" style="max-width:150px">
      <option value="all"${filters.trusted === 'all' ? ' selected' : ''}>全部用户</option>
      <option value="trusted"${filters.trusted === 'trusted' ? ' selected' : ''}>仅内部测试</option>
      <option value="untrusted"${filters.trusted === 'untrusted' ? ' selected' : ''}>仅普通用户</option>
    </select>
    <button class="btn btn-sm btn-outline-secondary" type="submit"><i class="bi bi-search" aria-hidden="true"></i> 搜索</button>
  </form>`;
  const query = new URLSearchParams(ctx.query).toString();
  const content = listShell({
    title: '用户', columns: COLUMNS, rows: renderRows(ctx, users), actions: searchForm,
    tbodyId: 'userTbody', sentinelId: 'userLoadMore', textId: 'userLoadMoreText',
    hintId: 'userLoadedHint', total, perPage: PER_PAGE, currentPage: page, totalPages,
    unit: '位用户', backTopId: 'userBackTopBtn', jumpBtnId: 'userJumpBtn', jumpInputId: 'userJumpInput'
  });
  return adminLayout({
    title: '用户管理', currentPage: 'users', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content,
    scripts: pagerScript({
      tbodyId: 'userTbody', sentinelId: 'userLoadMore', textId: 'userLoadMoreText',
      rowsUrl: `/admin/users_rows${query ? `?${query}` : ''}`, currentPage: page, totalPages, total,
      perPage: PER_PAGE, unit: '位用户', hintId: 'userLoadedHint', announceLabel: '用户',
      baseUrl: MANAGE_URL, backTopId: 'userBackTopBtn', jumpBtnId: 'userJumpBtn',
      jumpInputId: 'userJumpInput', version: ctx.version
    })
  });
}

async function rowsFragment(ctx) {
  const filters = filtersOf(ctx.query);
  const page = clampPage(ctx.query.page, null);
  let users = [];
  try {
    users = await all(ctx.env,
      `SELECT ${LIST_COLUMNS} FROM users${filters.sql} ORDER BY id ASC LIMIT ? OFFSET ?`,
      ...filters.args, PER_PAGE + 1, (page - 1) * PER_PAGE);
  } catch (err) {
    console.error('获取用户分页数据失败', err && err.message);
    return json({ success: false, message: '加载失败，请稍后重试' });
  }
  const hasMore = users.length > PER_PAGE;
  users = users.slice(0, PER_PAGE);
  if (!users.length) return json({ success: true, rows: '', has_more: false });
  return json({ success: true, rows: renderRows(ctx, users), has_more: hasMore });
}

function json(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

async function detailPage(ctx) {
  const userId = intOr(ctx.query.id, 0);
  const fail = (message) => adminLayout({
    title: '用户详情', currentPage: 'users', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error: message,
    content: `<div class="card"><div class="card-body">${escapeHtml(message)}<div class="mt-3">${backButton(MANAGE_URL, '返回用户列表')}</div></div></div>`
  });
  if (userId <= 0) return fail('缺少有效的用户ID参数');

  const user = await one(ctx.env, 'SELECT * FROM users WHERE id = ?', userId).catch(() => null);
  if (!user) return fail('用户不存在或已被删除');

  // 三个统计一次 UNION ALL 取回(少两次往返)
  const counts = await all(ctx.env,
    "SELECT 'news' AS k, COUNT(*) AS c FROM news WHERE user_id = ? "
    + "UNION ALL SELECT 'comments', COUNT(*) FROM news_comments WHERE user_id = ? "
    + "UNION ALL SELECT 'likes', COUNT(*) FROM news_likes WHERE user_id = ?",
    userId, userId, userId).catch(() => []);
  const tally = {};
  for (const row of counts) tally[strOf(row.k)] = intOr(row.c, 0);

  const state = accountStateOf(user);
  const stateBadge = state === '已注销' ? 'text-bg-dark' : (state === '已恢复' ? 'text-bg-info' : 'text-bg-success');
  const avatar = strOf(user.avatar);
  const content = `<div class="card"><div class="card-body">
  <div class="d-flex align-items-center gap-3 mb-3">
    ${avatar ? `<img src="${escapeHtml(assetUrl(ctx.env, avatar, ''))}" class="rounded-circle" style="width:64px;height:64px;object-fit:cover" alt="" onerror="this.style.visibility='hidden'">` : ''}
    <div>
      <h4 class="mb-1">${escapeHtml(strOf(user.nickname) || strOf(user.username) || '-')}</h4>
      <div class="d-flex flex-wrap gap-1">
        <span class="badge text-bg-${intOr(user.is_trusted, 0) === 1 ? 'danger' : 'secondary'}">${intOr(user.is_trusted, 0) === 1 ? '内部测试用户' : '普通用户'}</span>
        <span class="badge text-bg-secondary">${strOf(user.login_type) === 'wechat' ? '微信登录' : '账号登录'}</span>
        <span class="badge ${stateBadge}">${escapeHtml(state)}</span>
      </div>
    </div>
  </div>
  <div class="row g-3">
    <div class="col-md-4"><div class="card-stat"><div class="num">${tally.news || 0}</div><div class="lbl">发布笔记</div></div></div>
    <div class="col-md-4"><div class="card-stat"><div class="num">${tally.comments || 0}</div><div class="lbl">发表留言</div>
      <a class="small" href="/admin/comments_manage?user_id=${user.id}">查看</a></div></div>
    <div class="col-md-4"><div class="card-stat"><div class="num">${tally.likes || 0}</div><div class="lbl">点赞次数</div></div></div>
  </div>
  <div class="table-responsive mt-3">
    <table class="table table-sm align-middle"><tbody>
      <tr><th scope="row">用户名</th><td>${escapeHtml(strOf(user.username) || '-')}</td></tr>
      <tr><th scope="row">邮箱</th><td>${escapeHtml(strOf(user.email) || '-')}</td></tr>
      <tr><th scope="row">注册时间</th><td>${escapeHtml(fmtDatetime(user.create_time, '') || '未知')}</td></tr>
      <tr><th scope="row">最近登录</th><td>${escapeHtml(fmtDatetime(user.last_login_time, '') || '从未登录')}</td></tr>
    </tbody></table>
  </div>
  <div class="mt-3">${backButton(MANAGE_URL, '返回用户列表')}</div>
</div></div>`;
  return adminLayout({
    title: '用户详情', currentPage: 'users', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, content
  });
}

// 后台"恢复账号": 与旧站一致 —— status 置 0、昵称按**真实原昵称 + (已恢复)** 重算、头像不动、
// deleted_at **保留**(它是"曾被注销过"的标记, 列表据此显示"已恢复")。
// 不复用对外接口的 restoreUser: 那个是给小程序端用的, 会换 token 并清 deleted_at。
async function restoreUser(env, row) {
  const raw = strOf(row.raw_nickname) || strOf(row.nickname.replace(/\((已注销|已恢复)\)\s*$/, '')) || strOf(row.username);
  await run(env, 'UPDATE users SET status=0, nickname=?, raw_nickname=? WHERE id=?',
    `${raw}(已恢复)`, raw, row.id);
}

// 彻底删除: 与对外接口同一份口径(表清单与顺序一致), 全库无外键, 必须按依赖顺序清
async function purgeUser(env, row) {
  const notes = await all(env, 'SELECT id FROM news WHERE user_id=?', row.id).catch(() => []);
  const newsIds = notes.map((item) => intOr(item.id, 0)).filter((id) => id > 0);
  const statements = [];
  for (const table of ['news_likes', 'news_favorites', 'news_view_history', 'news_shares', 'news_comments']) {
    if (newsIds.length) {
      const marks = newsIds.map(() => '?').join(',');
      statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE news_id IN (${marks})`).bind(...newsIds));
    }
    statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE user_id=?`).bind(row.id));
  }
  if (newsIds.length) {
    const marks = newsIds.map(() => '?').join(',');
    statements.push(env.DB.prepare(`DELETE FROM news WHERE id IN (${marks})`).bind(...newsIds));
  }
  statements.push(env.DB.prepare('DELETE FROM app_notice_reads WHERE user_id=?').bind(row.id));
  statements.push(env.DB.prepare('DELETE FROM users WHERE id=?').bind(row.id));
  await env.DB.batch(statements);
  return { newsCount: newsIds.length };
}

async function writeSubmit(ctx) {
  const form = ctx.form;
  const page = strOf(form.page) || '1';
  const action = strOf(form.action) || (form.delete_user !== undefined ? 'delete_user' : '');
  const rawId = strOf(form.user_id);
  const base = { page };

  if (!ctx.session.isSuper) {
    return redirect(buildListUrl(MANAGE_URL, Object.assign({ error: '该操作仅超级管理员可执行' }, base)));
  }
  if (!/^\d+$/.test(rawId) || intOr(rawId, 0) <= 0) {
    return redirect(buildListUrl(MANAGE_URL, Object.assign({ error: '无效的用户ID' }, base)));
  }
  const userId = intOr(rawId, 0);
  let message = '';
  let error = '';
  try {
    const row = await one(ctx.env, 'SELECT * FROM users WHERE id = ?', userId);
    if (!row) {
      error = '用户不存在或已被删除';
    } else if (action === 'set_trusted') {
      await run(ctx.env, 'UPDATE users SET is_trusted = 1 WHERE id = ?', userId);
      auditLog('admin.user.set_trusted', { user: ctx.session.username, user_id: userId });
      message = '已成功设置为内部测试用户';
    } else if (action === 'remove_trusted') {
      await run(ctx.env, 'UPDATE users SET is_trusted = 0 WHERE id = ?', userId);
      auditLog('admin.user.remove_trusted', { user: ctx.session.username, user_id: userId });
      message = '已取消内部测试用户设置';
    } else if (action === 'restore_user') {
      await restoreUser(ctx.env, row);
      auditLog('admin.user.restore', { user: ctx.session.username, user_id: userId });
      message = '账号已恢复：该用户现可正常登录，昵称已还原为原昵称(已恢复)，原头像保持不变';
    } else if (action === 'delete_user') {
      // 物理删除 + 级联清子表, 后台最不可逆的操作: 必须幂等(双击/刷新不会二次执行)
      if (await isDuplicateSubmit(ctx.env, idemKey('user_delete', String(ctx.session.id || '-'), rawId))) {
        error = '该操作刚刚已执行，请勿重复提交';
      } else {
        const outcome = await purgeUser(ctx.env, row);
        auditLog('admin.user.delete', { user: ctx.session.username, user_id: userId, news_count: outcome.newsCount });
        message = '用户及其发布的笔记、评论与互动记录已全部删除';
      }
    } else {
      error = '未识别的操作';
    }
  } catch (err) {
    console.error(`用户操作失败 action=${action} user_id=${rawId}`, err && err.message);
    error = '操作失败，请稍后重试';
  }
  if (error) {
    // 失败尝试也留痕: 这类记录在安全审计里同样有价值
    auditLog('admin.user.action.rejected', { user: ctx.session.username, op: action, target: rawId, reason: error });
  }
  return redirect(buildListUrl(MANAGE_URL, { message, error, page }));
}

export const routes = [
  { methods: ['GET', 'POST'], path: MANAGE_URL, handler: (ctx) => (ctx.method === 'POST' ? writeSubmit(ctx) : managePage(ctx)) },
  { methods: ['GET', 'HEAD'], path: '/admin/users_rows', handler: rowsFragment },
  { methods: ['GET', 'HEAD'], path: '/admin/user_detail', handler: detailPage }
];
