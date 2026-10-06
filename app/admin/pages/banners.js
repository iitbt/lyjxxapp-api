// 轮播图管理: 列表(触底分页) / 行片段 / 新增编辑 / 删除 / 复制
// 逐条对齐旧站 fastapi/app/admin/banners.py: 同样的筛选/排序/分页口径、文案与幂等键
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { assetUrl } from '../../core/media_scheme.js';
import { adminLayout } from '../lib/layout.js';
import {
  emptyRow, imageUploadField, imageUploadModal, listShell, mediaLibraryModal, numberField,
  pagerScript, selectField, switchField, textField, editShell
} from '../lib/partials.js';
import { statusActions, statusBadgeClass, statusKind, statusLabel } from '../lib/status.js';
import {
  PER_PAGE, auditLog, buildListUrl, clampPage, firstScreenLimit, idemKey,
  invalidateEntityCache, isDuplicateSubmit, intOr, strOf
} from '../lib/utils.js';

const MANAGE_URL = '/admin/banner_manage';
// 展示位置的中文名(唯一维护点): 列表里不显示 news/index 这类英文原值
const POSITIONS = [['news', '笔记页'], ['index', '首页'], ['outdoor', '户外'], ['motorcycle', '摩旅']];
const POSITION_LABELS = Object.fromEntries(POSITIONS);
const COLUMNS = ['ID', '预览', '标题', '位置', '排序', '状态', '操作'];

function enrichPositions(rows) {
  for (const row of rows || []) {
    const value = String(row.position || '');
    row.position_text = POSITION_LABELS[value] || value || '-';
  }
  return rows || [];
}

// 搜索: 标题 / 跳转链接模糊匹配
function bannerWhere(keyword) {
  if (!keyword) return { sql: '', args: [] };
  return { sql: ' WHERE (title LIKE ? OR link_url LIKE ?)', args: [`%${keyword}%`, `%${keyword}%`] };
}

function statusCell(row) {
  const kind = statusKind('banner');
  return `<span class="badge text-bg-${statusBadgeClass(kind, row.status)}" data-status-badge>${escapeHtml(statusLabel(kind, row.status))}</span>`;
}

function actionsCell(ctx, row) {
  const kind = statusKind('banner');
  const buttons = statusActions(kind, row.status).map((action) => `<button type="button" class="btn btn-sm btn-${action.btnClass}"`
    + ` data-status-kind="${kind.key}" data-status-id="${row.id}" data-status-action="${escapeHtml(action.value)}"`
    + `${action.visible ? '' : ' hidden'}>${escapeHtml(action.label)}</button>`).join('');
  const page = Number(ctx.query.page) || 1;
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="/admin/banner_edit?id=${row.id}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    <form method="post" action="/admin/banner_copy">
      <input type="hidden" name="id" value="${row.id}">
      <input type="hidden" name="page" value="${page}">
      <button class="btn btn-sm btn-outline-secondary" type="submit" onclick="return confirm('复制该轮播图？')"><i class="bi bi-copy" aria-hidden="true"></i> 复制</button>
    </form>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=banner&amp;id=${row.id}&amp;page=${page}&amp;back=${encodeURIComponent(MANAGE_URL)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

// 行片段渲染(列表页首屏与触底加载共用同一份)
export function renderRows(ctx, banners, page) {
  if (!banners || !banners.length) return emptyRow(COLUMNS, '暂无轮播图');
  return banners.map((row) => `<tr>
  <td class="text-nowrap">${row.id}</td>
  <td><img src="${escapeHtml(assetUrl(ctx.env, row.image_url, ''))}" class="cover-thumb" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'"></td>
  <td><div class="text-truncate clamp-lg" title="${escapeHtml(row.title || '')}">${escapeHtml(row.title || '-')}</div></td>
  <td class="text-nowrap">${escapeHtml(row.position_text || row.position || '-')}</td>
  <td class="text-nowrap">${row.sort_order}</td>
  <td class="text-nowrap">${statusCell(row)}</td>
  <td class="text-nowrap">${actionsCell(ctx, row)}</td>
</tr>`).join('');
}

async function managePage(ctx) {
  const keyword = strOf(ctx.query.keyword);
  const where = bannerWhere(keyword);
  let total = 0;
  let totalPages = 1;
  let page = 1;
  let banners = [];
  let error = '';
  try {
    const row = await one(ctx.env, `SELECT COUNT(*) AS total FROM banner_images${where.sql}`, ...where.args);
    total = intOr(row && row.total, 0);
    totalPages = Math.max(Math.ceil(total / PER_PAGE), 1);
    const limited = firstScreenLimit(ctx.query.page, PER_PAGE, totalPages);
    page = limited[0];
    banners = await all(ctx.env,
      `SELECT * FROM banner_images${where.sql} ORDER BY sort_order ASC, id DESC LIMIT ?`,
      ...where.args, limited[1]);
  } catch (err) {
    // 查询失败要明说, 不能渲染成"暂无数据"(运营会以为数据被删了)
    console.error('获取轮播图列表失败', err && err.message);
    banners = [];
    error = '读取数据失败，请稍后重试';
  }
  const rows = renderRows(ctx, enrichPositions(banners), page);
  const content = listShell({
    title: '轮播图', columns: COLUMNS, rows,
    actions: '<a class="btn btn-primary" href="/admin/banner_edit?id=0"><i aria-hidden="true" class="bi bi-plus-lg"></i> 添加轮播图</a>',
    tbodyId: 'bannerTbody', sentinelId: 'bannerLoadMore', textId: 'bannerLoadMoreText',
    hintId: 'bannerLoadedHint', total, perPage: PER_PAGE, currentPage: page, totalPages,
    unit: '张', backTopId: 'bannerBackTopBtn', jumpBtnId: 'bannerJumpBtn', jumpInputId: 'bannerJumpInput'
  });
  return adminLayout({
    title: '轮播图管理', currentPage: 'banner_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content,
    scripts: pagerScript({
      tbodyId: 'bannerTbody', sentinelId: 'bannerLoadMore', textId: 'bannerLoadMoreText',
      rowsUrl: '/admin/banner_rows', currentPage: page, totalPages, total, perPage: PER_PAGE,
      unit: '张', hintId: 'bannerLoadedHint', announceLabel: '轮播图', baseUrl: MANAGE_URL,
      backTopId: 'bannerBackTopBtn', jumpBtnId: 'bannerJumpBtn', jumpInputId: 'bannerJumpInput',
      version: ctx.version
    })
  });
}

// 触底加载的下一页行片段: 只返回 <tr> 或空串(空串表示没有更多, 前端据此停手)
async function rowsFragment(ctx) {
  const keyword = strOf(ctx.query.keyword);
  const where = bannerWhere(keyword);
  const page = clampPage(ctx.query.page, null);
  let banners = [];
  try {
    banners = await all(ctx.env,
      `SELECT * FROM banner_images${where.sql} ORDER BY sort_order ASC, id DESC LIMIT ? OFFSET ?`,
      ...where.args, PER_PAGE + 1, (page - 1) * PER_PAGE);
  } catch (err) {
    console.error('获取轮播图分页数据失败', err && err.message);
    return json({ success: false, message: '加载失败，请稍后重试' });
  }
  const hasMore = banners.length > PER_PAGE;
  banners = enrichPositions(banners.slice(0, PER_PAGE));
  // 越界时返回空串: 以前返回"暂无内容"行, 前端会当数据插入并继续翻页
  if (!banners.length) return json({ success: true, rows: '', has_more: false });
  return json({ success: true, rows: renderRows(ctx, banners, page), has_more: hasMore });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function editPage(ctx) {
  const bannerId = intOr(ctx.query.id, 0);
  const isNew = bannerId <= 0;
  let error = ctx.error || '';
  let errorField = '';
  let banner;
  if (isNew) {
    banner = { id: 0, title: '', image_url: '', link_url: '', position: 'news', sort_order: 0, status: 1 };
  } else {
    banner = await one(ctx.env, 'SELECT * FROM banner_images WHERE id = ?', bannerId).catch(() => null);
    if (!banner) {
      return editView(ctx, { isNew: false, banner: null, error: '找不到该轮播图', errorField: '' });
    }
  }

  if (ctx.method === 'POST') {
    const form = ctx.form;
    const title = strOf(form.title);
    const imageUrl = strOf(form.image_url);
    const linkUrl = strOf(form.link_url);
    const position = strOf(form.position) || 'news';
    const sortOrder = intOr(form.sort_order, 0);
    const status = form.status ? 1 : 0;
    banner = { id: bannerId, title, image_url: imageUrl, link_url: linkUrl, position, sort_order: sortOrder, status };
    if (!imageUrl) {
      error = '请填写必填项: 图片地址';
      errorField = 'image_url';
    }
    if (!error) {
      try {
        let message = '';
        if (isNew && await isDuplicateSubmit(ctx.env,
          idemKey('banner_create', String(ctx.session.id || '-'), title, imageUrl, linkUrl, position))) {
          // 新增补一次性防重: 双击/刷新重发会插入两条一模一样的轮播图
          error = '该操作刚刚已执行，请勿重复提交';
        } else if (isNew) {
          await run(ctx.env, 'INSERT INTO banner_images (title, image_url, link_url, position, sort_order, status) VALUES (?,?,?,?,?,?)',
            title, imageUrl, linkUrl, position, sortOrder, status);
          message = '轮播图添加成功';
        } else {
          await run(ctx.env, 'UPDATE banner_images SET title=?, image_url=?, link_url=?, position=?, sort_order=?, status=? WHERE id=?',
            title, imageUrl, linkUrl, position, sortOrder, status, bannerId);
          message = '轮播图更新成功';
        }
        if (!error) {
          invalidateEntityCache('banner');
          auditLog(`admin.banner.${isNew ? 'create' : 'update'}`,
            { user: ctx.session.username, banner_id: bannerId, title });
          return redirect(buildListUrl(MANAGE_URL, { message }));
        }
      } catch (err) {
        console.error(`保存轮播图失败 id=${bannerId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }
  return editView(ctx, { isNew, banner, error, errorField });
}

function editView(ctx, { isNew, banner, error, errorField }) {
  if (!banner) {
    return adminLayout({
      title: '编辑轮播图', currentPage: 'banner_manage', admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: error || '找不到该轮播图',
      content: '<div class="card"><div class="card-body">找不到该轮播图，可能已被删除。</div></div>'
    });
  }
  const main = textField({ name: 'title', label: '标题', value: banner.title, errorField })
    + imageUploadField({
      env: ctx.env, name: 'image_url', label: '图片 URL', value: banner.image_url,
      required: true, mediaPicker: true, errorField,
      hint: '轮播图建议使用 16:9 横版图片（如 1280×720），后台统一按 16:9 居中裁剪显示。也可点右侧「图片素材库」从服务器已有图片里选择。'
    })
    + textField({
      name: 'link_url', label: '跳转链接', value: banner.link_url, errorField,
      placeholder: '小程序页面路径，如 /pages/detail/detail?id=1'
    });
  const side = selectField({ name: 'position', label: '展示位置', options: POSITIONS, value: banner.position, errorField })
    + numberField({ name: 'sort_order', label: '排序 (小在前)', value: banner.sort_order, errorField })
    + switchField({ name: 'status', label: '启用展示', checked: Number(banner.status) === 1 });
  const content = editShell({
    action: `/admin/banner_edit${isNew ? '' : `?id=${banner.id}`}`,
    main, side, errorField, backUrl: MANAGE_URL, backLabel: '返回列表',
    primaryLabel: isNew ? '添加轮播图' : '保存修改'
  }) + imageUploadModal({ name: 'image_url', purpose: 'cover' }) + mediaLibraryModal();
  return adminLayout({
    title: '编辑轮播图', currentPage: 'banner_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error, content
  });
}

async function deleteSubmit(ctx) {
  const form = ctx.form;
  const rawId = form.id;
  const page = form.page;
  if (!rawId || !/^\d+$/.test(String(rawId).replace('-', ''))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '参数错误', page }));
  }
  if (await isDuplicateSubmit(ctx.env, idemKey('banner_delete', String(ctx.session.id || '-'), String(rawId)))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '该操作刚刚已执行，请勿重复提交', page }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, 'SELECT image_url FROM banner_images WHERE id = ?', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该轮播图', page }));
    await run(ctx.env, 'DELETE FROM banner_images WHERE id = ?', intOr(rawId, 0));
    // 素材保留策略: 只删数据库记录, 不物理删磁盘/桶里的图片(同一张图可能被多处复用)
    auditLog('admin.banner.delete', { user: ctx.session.username, banner_id: intOr(rawId, 0), image_url: row.image_url || '' });
    invalidateEntityCache('banner');
    message = '轮播图已删除';
  } catch (err) {
    console.error(`删除轮播图失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试', page }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, page }));
}

async function copySubmit(ctx) {
  const form = ctx.form;
  const rawId = form.id;
  const page = form.page;
  if (!rawId || !/^\d+$/.test(String(rawId).replace('-', ''))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '参数错误', page }));
  }
  if (await isDuplicateSubmit(ctx.env, idemKey('banner_copy', String(ctx.session.id || '-'), String(rawId)))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '该操作刚刚已执行，请勿重复提交', page }));
  }
  let message = '';
  try {
    const original = await one(ctx.env, 'SELECT * FROM banner_images WHERE id = ?', intOr(rawId, 0));
    if (!original) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该轮播图', page }));
    // 复制: 除自增 id 外业务字段整体保留, 标题加 " (副本)"
    const result = await run(ctx.env,
      'INSERT INTO banner_images (title, image_url, link_url, position, sort_order, status) VALUES (?,?,?,?,?,?)',
      `${original.title || ''} (副本)`, original.image_url, original.link_url, original.position,
      intOr(original.sort_order, 0), Number(original.status) === 1 ? 1 : intOr(original.status, 0));
    const newId = (result && result.meta && result.meta.last_row_id) || 0;
    auditLog('admin.banner.copy', { user: ctx.session.username, banner_id: intOr(rawId, 0), new_id: newId });
    invalidateEntityCache('banner');
    message = `轮播图已成功复制！新ID: ${newId}`;
  } catch (err) {
    console.error(`复制轮播图失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '复制失败，请稍后重试', page }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, page }));
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['GET', 'HEAD'], path: '/admin/banner_rows', handler: rowsFragment },
  { methods: ['GET', 'POST'], path: '/admin/banner_edit', handler: editPage },
  { methods: ['POST'], path: '/admin/banner_delete', handler: deleteSubmit },
  { methods: ['POST'], path: '/admin/banner_copy', handler: copySubmit }
];
