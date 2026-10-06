// 首页精选: 列表(不分页) / 新增编辑 / 删除
// 逐条对齐旧站 fastapi/app/admin/app_featured.py: 与分类无引用关系, 独立模块
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { assetUrl } from '../../core/media_scheme.js';
import { adminLayout } from '../lib/layout.js';
import {
  editShell, emptyRow, imageUploadField, imageUploadModal, listMeta, mediaLibraryModal,
  numberField, switchField, textField
} from '../lib/partials.js';
import { statusActions, statusBadgeClass, statusKind, statusLabel } from '../lib/status.js';
import {
  auditLog, buildListUrl, intOr, invalidateEntityCache, strOf
} from '../lib/utils.js';

const MANAGE_URL = '/admin/app_featured_manage';
const COLUMNS = ['ID', '预览', '标识', '名称', '跳转页面', '排序', '状态', '操作'];
// 标识格式: 小写字母开头 + 小写字母/数字/下划线, 最长 40(与旧站 FEATURED_KEY_PATTERN 一致)
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

function statusCell(row) {
  const kind = statusKind('app_featured');
  return `<span class="badge text-bg-${statusBadgeClass(kind, row.status)}" data-status-badge>${escapeHtml(statusLabel(kind, row.status))}</span>`;
}

function actionsCell(row) {
  const kind = statusKind('app_featured');
  const buttons = statusActions(kind, row.status).map((action) => `<button type="button" class="btn btn-sm btn-${action.btnClass}"`
    + ` data-status-kind="${kind.key}" data-status-id="${row.id}" data-status-action="${escapeHtml(action.value)}"`
    + `${action.visible ? '' : ' hidden'}>${escapeHtml(action.label)}</button>`).join('');
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="/admin/app_featured_edit?id=${row.id}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=featured&amp;id=${row.id}&amp;back=${encodeURIComponent(MANAGE_URL)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

export function renderRows(ctx, rows) {
  if (!rows || !rows.length) return emptyRow(COLUMNS, '暂无精选内容');
  return rows.map((row) => {
    const image = strOf(row.image_url);
    const preview = image
      ? `<img src="${escapeHtml(assetUrl(ctx.env, image, ''))}" class="cover-thumb" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`
      : '-';
    return `<tr>
  <td class="text-nowrap">${row.id}</td>
  <td>${preview}</td>
  <td><code>${escapeHtml(row.item_key || '-')}</code></td>
  <td><div class="text-truncate clamp-lg">${escapeHtml(row.name || '-')}</div></td>
  <td class="text-nowrap">${row.page_path ? `<code>${escapeHtml(row.page_path)}</code>` : '-'}</td>
  <td class="text-nowrap">${row.sort_order}</td>
  <td class="text-nowrap">${statusCell(row)}</td>
  <td class="text-nowrap">${actionsCell(row)}</td>
</tr>`;
  }).join('');
}

async function managePage(ctx) {
  let rows = [];
  let error = '';
  try {
    rows = await all(ctx.env, 'SELECT * FROM app_featured_items ORDER BY sort_order ASC, id ASC');
  } catch (err) {
    console.error('获取首页精选失败', err && err.message);
    rows = [];
    error = '读取数据失败，请稍后重试';
  }
  const content = `<div class="card"><div class="card-body">
  <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
    <a class="btn btn-primary" href="/admin/app_featured_edit?id=0"><i aria-hidden="true" class="bi bi-plus-lg"></i> 添加精选</a>
    <span class="ms-auto text-end">${listMeta({ total: rows.length, unit: '条', simple: true })}</span>
  </div>
  <div class="table-responsive">
    <table aria-label="首页精选列表" class="table table-hover align-middle text-center">
      <thead class="table-light"><tr>${COLUMNS.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${renderRows(ctx, rows)}</tbody>
    </table>
  </div>
</div></div>`;
  return adminLayout({
    title: '首页精选管理', currentPage: 'app_featured_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content
  });
}

async function editPage(ctx) {
  const rowId = intOr(ctx.query.id, 0);
  const isNew = rowId <= 0;
  let error = ctx.error || '';
  let errorField = '';
  let row;
  if (isNew) {
    row = { id: 0, item_key: '', name: '', image_url: '', page_path: '', sort_order: 0, status: 1 };
  } else {
    row = await one(ctx.env, 'SELECT * FROM app_featured_items WHERE id = ?', rowId).catch(() => null);
    if (!row) return editView(ctx, { isNew: false, row: null, error: '找不到该精选项', errorField: '' });
  }

  if (ctx.method === 'POST') {
    const form = ctx.form;
    const itemKey = strOf(form.item_key);
    const name = strOf(form.name);
    const imageUrl = strOf(form.image_url);
    const pagePath = strOf(form.page_path);
    const sortOrder = intOr(form.sort_order, 0);
    const status = form.status ? 1 : 0;
    row = { id: rowId, item_key: itemKey, name, image_url: imageUrl, page_path: pagePath, sort_order: sortOrder, status };

    if (!itemKey) {
      error = '请填写必填项: 标识';
      errorField = 'item_key';
    } else if (!KEY_PATTERN.test(itemKey)) {
      error = '标识格式不正确: 小写字母开头, 只允许小写字母/数字/下划线, 最长 40';
      errorField = 'item_key';
    } else if (await keyExists(ctx.env, itemKey, rowId)) {
      error = '该标识已被其它精选使用, 请换一个(标识在本模块内必须唯一)';
      errorField = 'item_key';
    } else if (!name) {
      error = '请填写必填项: 名称';
      errorField = 'name';
    } else if (!imageUrl) {
      error = '请填写必填项: 图片地址';
      errorField = 'image_url';
    } else if (!pagePath) {
      error = '请填写必填项: 跳转页面';
      errorField = 'page_path';
    }

    if (!error) {
      try {
        if (isNew) {
          await run(ctx.env,
            'INSERT INTO app_featured_items (item_key, name, image_url, page_path, sort_order, status) VALUES (?,?,?,?,?,?)',
            itemKey, name, imageUrl, pagePath, sortOrder, status);
        } else {
          await run(ctx.env,
            'UPDATE app_featured_items SET item_key=?, name=?, image_url=?, page_path=?, sort_order=?, status=? WHERE id=?',
            itemKey, name, imageUrl, pagePath, sortOrder, status, rowId);
        }
        invalidateEntityCache('featured');
        auditLog(`admin.app_featured.${isNew ? 'create' : 'update'}`, { user: ctx.session.username, featured_id: rowId, item_key: itemKey });
        return redirect(buildListUrl(MANAGE_URL, { message: isNew ? '精选已添加' : '精选已更新' }));
      } catch (err) {
        console.error(`保存精选失败 id=${rowId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }
  return editView(ctx, { isNew, row, error, errorField });
}

// 标识唯一性检查: 查询异常时按"已占用"处理(阻止保存) —— 旧站 B1 修复的教训:
// 异常当"无重复"会放行脏数据
async function keyExists(env, itemKey, rowId) {
  try {
    const found = await one(env, 'SELECT id FROM app_featured_items WHERE item_key=? AND id<>?', itemKey, rowId);
    return Boolean(found);
  } catch (error) {
    console.error('检查精选标识唯一性失败', error && error.message);
    return true;
  }
}

function editView(ctx, { isNew, row, error, errorField }) {
  if (!row) {
    return adminLayout({
      title: '编辑精选', currentPage: 'app_featured_manage', admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: error || '找不到该精选项',
      content: '<div class="card"><div class="card-body">找不到该精选项，可能已被删除。</div></div>'
    });
  }
  const main = textField({
    name: 'item_key', label: '标识', value: row.item_key, required: true, errorField,
    placeholder: '如 outdoor_sale',
    hint: '小写字母开头，只允许小写字母/数字/下划线，最长 40；本模块内不可重复。'
  }) + textField({ name: 'name', label: '名称', value: row.name, required: true, errorField, placeholder: '如 户外精选' })
    + imageUploadField({
      env: ctx.env, name: 'image_url', label: '图片地址', value: row.image_url,
      required: true, mediaPicker: true, errorField
    })
    + textField({
      name: 'page_path', label: '跳转页面', value: row.page_path, required: true, errorField,
      placeholder: '如 /pages/outdoor/outdoor'
    });
  const side = numberField({ name: 'sort_order', label: '排序 (小在前)', value: row.sort_order, errorField })
    + switchField({ name: 'status', label: '启用展示', checked: intOr(row.status, 0) === 1 });
  const content = editShell({
    action: `/admin/app_featured_edit${isNew ? '' : `?id=${row.id}`}`,
    main, side, backUrl: MANAGE_URL, backLabel: '返回列表',
    primaryLabel: isNew ? '添加精选' : '保存修改'
  }) + imageUploadModal({ name: 'image_url', purpose: 'cover' }) + mediaLibraryModal();
  return adminLayout({
    title: '编辑精选', currentPage: 'app_featured_manage', admin: ctx.session.username,
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
    const row = await one(ctx.env, 'SELECT item_key, image_url FROM app_featured_items WHERE id = ?', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该精选项' }));
    await run(ctx.env, 'DELETE FROM app_featured_items WHERE id = ?', intOr(rawId, 0));
    // 只删配置记录, 磁盘/桶上的图片按素材保留策略留下(同一张图可能被多处引用)
    auditLog('admin.app_featured.delete', {
      user: ctx.session.username, featured_id: intOr(rawId, 0),
      item_key: row.item_key || '', image_url: row.image_url || ''
    });
    invalidateEntityCache('featured');
    message = '精选已删除';
  } catch (err) {
    console.error(`删除精选失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试' }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message }));
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['GET', 'POST'], path: '/admin/app_featured_edit', handler: editPage },
  { methods: ['POST'], path: '/admin/app_featured_delete', handler: deleteSubmit }
];
