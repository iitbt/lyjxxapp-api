// 我的页菜单: 列表 / 新增编辑 / 删除 / 补齐内置菜单项
// 逐条对齐旧站 fastapi/app/admin/config_center.py 的菜单那部分
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { assetUrl } from '../../core/media_scheme.js';
import { adminLayout } from '../lib/layout.js';
import {
  DEFAULT_APP_MENU, LOGIN_REQUIRED_ACTIONS, MENU_ACTIONS, MENU_LINK_TYPES, MENU_LOCAL_ICON_PREFIX,
  MENU_VISIBILITY, isPagePath, menuActionLabel, pagePathHint
} from '../lib/catalog.js';
import {
  editShell, emptyRow, imageUploadField, imageUploadModal, listMeta, mediaLibraryModal,
  numberField, selectField, switchField, textField
} from '../lib/partials.js';
import { statusActions, statusBadgeClass, statusKind, statusLabel } from '../lib/status.js';
import {
  CONTROLLED_LIST_LIMIT, auditLog, buildListUrl, intOr, invalidateEntityCache, strOf
} from '../lib/utils.js';

const MANAGE_URL = '/admin/app_menu_manage';
const COLUMNS = ['菜单标识', '图标', '标题', '跳转目标', '可见性', '排序', '状态', '操作'];
// 菜单标识格式: 小写字母开头 + 小写字母/数字/下划线, 最长 50
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

function statusCell(row) {
  const kind = statusKind('app_menu_item');
  return `<span class="badge text-bg-${statusBadgeClass(kind, row.status)}" data-status-badge>${escapeHtml(statusLabel(kind, row.status))}</span>`;
}

function actionsCell(row) {
  const kind = statusKind('app_menu_item');
  const buttons = statusActions(kind, row.status).map((action) => `<button type="button" class="btn btn-sm btn-${action.btnClass}"`
    + ` data-status-kind="${kind.key}" data-status-id="${row.id}" data-status-action="${escapeHtml(action.value)}"`
    + `${action.visible ? '' : ' hidden'}>${escapeHtml(action.label)}</button>`).join('');
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="/admin/app_menu_edit?id=${row.id}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=menu&amp;id=${row.id}&amp;back=${encodeURIComponent(MANAGE_URL)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

// 图标列三种情况: 包内 /images/ 路径只显示文本(根化会 404)、其它非空出图、空显示"默认图标"
function iconCell(ctx, row) {
  const icon = strOf(row.icon);
  if (!icon) return '<span class="text-muted small">默认图标</span>';
  if (icon.startsWith(MENU_LOCAL_ICON_PREFIX)) return `<code>${escapeHtml(icon)}</code>`;
  return `<img src="${escapeHtml(assetUrl(ctx.env, icon, ''))}" class="cover-thumb" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`;
}

function renderRows(ctx, rows) {
  if (!rows || !rows.length) return emptyRow(COLUMNS, '暂无菜单项');
  return rows.map((row) => {
    const isAction = strOf(row.link_type) === 'action';
    const target = isAction
      ? `<span class="badge text-bg-secondary">动作</span> <code>${escapeHtml(strOf(row.link_value))}</code>`
      : `<code>${escapeHtml(strOf(row.link_value))}</code>`;
    const visibility = intOr(row.need_login, 0) === 1
      ? '<span class="badge text-bg-secondary">登录可见</span>'
      : '<span class="badge bg-light text-dark border">未登录可见</span>';
    return `<tr>
  <td class="text-nowrap"><code>${escapeHtml(row.menu_key || '-')}</code></td>
  <td>${iconCell(ctx, row)}</td>
  <td class="text-nowrap">${escapeHtml(strOf(row.title) || '-')}</td>
  <td>${target}</td>
  <td class="text-nowrap">${visibility}</td>
  <td class="text-nowrap">${row.sort_order}</td>
  <td class="text-nowrap">${statusCell(row)}</td>
  <td class="text-nowrap">${actionsCell(row)}</td>
</tr>`;
  }).join('');
}

async function managePage(ctx) {
  let rows = [];
  let total = 0;
  let enabledCount = 0;
  let existingKeys = [];
  let error = '';
  try {
    // 只查两次: 一次拿全表(key/status, 用于总数/启用数/已有 key), 一次拿展示行
    const allRows = await all(ctx.env, 'SELECT menu_key, status FROM app_menu_items');
    total = allRows.length;
    enabledCount = allRows.filter((item) => intOr(item.status, 0) === 1).length;
    existingKeys = allRows.map((item) => strOf(item.menu_key));
    rows = await all(ctx.env, 'SELECT * FROM app_menu_items ORDER BY sort_order ASC, id ASC LIMIT ?', CONTROLLED_LIST_LIMIT);
  } catch (err) {
    console.error('获取我的页菜单失败', err && err.message);
    rows = [];
    error = '读取数据失败，请稍后重试';
  }
  const truncated = total > rows.length;
  const usingBuiltin = enabledCount === 0;
  const missing = DEFAULT_APP_MENU.filter((item) => !existingKeys.includes(item.menu_key));
  const banners = [];
  if (missing.length) {
    banners.push(`<div class="alert alert-warning" role="alert">
      代码里登记了、但本表还没有的菜单项（小程序目前看不到它们）：
      ${missing.map((item) => `<code>${escapeHtml(item.menu_key)}</code>（${escapeHtml(item.title)}）`).join('、')}
      <div class="small mt-1">—— 点上方按钮一键补齐，或点「添加菜单项」自己填。</div>
    </div>`);
  }
  if (usingBuiltin) {
    banners.push(`<div class="alert alert-info" role="alert">
      当前没有任何启用项，接口正在下发内置默认菜单：${DEFAULT_APP_MENU.map((item) => escapeHtml(item.title)).join('、')}。
      <div class="small mt-1">新增任意一条并启用后，即以本页配置为准。</div>
    </div>`);
  }
  const restoreForm = missing.length
    ? `<form method="post" action="/admin/app_menu_restore_missing" class="d-inline">
        <button class="btn btn-outline-primary" type="submit"
                onclick="return confirm('将按代码里的内置定义补齐 ${missing.length} 条菜单项（已有项不会被修改），确定继续？')">
          <i class="bi bi-plus-circle" aria-hidden="true"></i> 补齐内置菜单项（${missing.length}）
        </button>
      </form>`
    : '';
  const content = `<div class="card"><div class="card-body">
  ${banners.join('')}
  <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
    <a class="btn btn-primary" href="/admin/app_menu_edit?id=0"><i aria-hidden="true" class="bi bi-plus-lg"></i> 添加菜单项</a>
    ${restoreForm}
    <span class="ms-auto text-end">${listMeta({ total, unit: '条', simple: true })}${truncated ? ` <span class="text-danger">（仅显示前 ${CONTROLLED_LIST_LIMIT} 条）</span>` : ''}</span>
  </div>
  <div class="table-responsive">
    <table aria-label="我的页菜单列表" class="table table-hover align-middle">
      <thead class="table-light"><tr>${COLUMNS.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${renderRows(ctx, rows)}</tbody>
    </table>
  </div>
  <div class="small text-muted mt-3">
    · 跳转目标选「页面路径」时必须 <code>${escapeHtml(pagePathHint())}</code> 开头；<br>
    · 内置动作只能是：${MENU_ACTIONS.map(([key, label]) => `<code>${escapeHtml(key)}</code>（${escapeHtml(label)}）`).join('、')}；<br>
    · 隐藏某一项请用「停用」而不是删除 —— 一条启用项都没有时，接口会改发内置默认菜单。
  </div>
</div></div>`;
  return adminLayout({
    title: '我的页菜单配置', currentPage: 'app_menu_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

async function keyExists(env, menuKey, rowId) {
  try {
    const found = await one(env, 'SELECT id FROM app_menu_items WHERE menu_key=? AND id<>?', menuKey, rowId);
    return Boolean(found);
  } catch (error) {
    console.error('检查菜单标识唯一性失败', error && error.message);
    return false;
  }
}

async function editPage(ctx) {
  const rowId = intOr(ctx.query.id, 0);
  const isNew = rowId <= 0;
  let error = ctx.error || '';
  let errorField = '';
  let row;
  if (isNew) {
    row = {
      id: 0, menu_key: '', title: '', icon: '', link_type: 'page', link_value: '',
      need_login: 0, trusted_only: 0, sort_order: 0, status: 1
    };
  } else {
    row = await one(ctx.env, 'SELECT * FROM app_menu_items WHERE id = ?', rowId).catch(() => null);
    if (!row) return editView(ctx, { isNew: false, row: null, error: '找不到该菜单项', errorField: '' });
  }

  if (ctx.method === 'POST') {
    const form = ctx.form;
    const menuKey = strOf(form.menu_key);
    const title = strOf(form.title);
    const icon = strOf(form.icon);
    const linkType = strOf(form.link_type) || 'page';
    const linkValue = strOf(form.link_value);
    // need_login 是 enum01(下拉 "0"/"1"): 不能当成布尔,"0" 也是真值
    const needLogin = strOf(form.need_login || '0') === '1' ? 1 : 0;
    const trustedOnly = form.trusted_only ? 1 : 0;
    const sortOrder = intOr(form.sort_order, 0);
    const status = form.status ? 1 : 0;
    row = {
      id: rowId, menu_key: menuKey, title, icon, link_type: linkType, link_value: linkValue,
      need_login: needLogin, trusted_only: trustedOnly, sort_order: sortOrder, status
    };

    if (!menuKey) {
      error = '请填写必填项: 菜单标识';
      errorField = 'menu_key';
    } else if (!KEY_PATTERN.test(menuKey)) {
      error = '菜单标识格式不正确: 小写字母开头, 只允许小写字母/数字/下划线, 最长 50';
      errorField = 'menu_key';
    } else if (await keyExists(ctx.env, menuKey, rowId)) {
      error = '该菜单标识已存在, 请换一个';
      errorField = 'menu_key';
    } else if (!title) {
      error = '请填写菜单标题';
      errorField = 'title';
    } else if (linkType === 'page' && !isPagePath(linkValue)) {
      error = `页面路径必须以 ${pagePathHint()} 开头(如 /subpackages/content/like/like 或 /pages/like/like)`;
      errorField = 'link_value';
    } else if (linkType === 'action' && !MENU_ACTIONS.some(([key]) => key === linkValue)) {
      error = '请选择有效的内置动作';
      errorField = 'link_value';
    } else if (linkType === 'action' && LOGIN_REQUIRED_ACTIONS.has(linkValue) && needLogin !== 1) {
      error = `「${menuActionLabel(linkValue)}」必须设为「登录可见」—— 未登录用户执行不了这个动作`;
      errorField = 'need_login';
    } else if (!MENU_LINK_TYPES.some(([key]) => key === linkType)) {
      error = '跳转类型只能是 页面路径 或 内置动作';
      errorField = 'link_type';
    }

    if (!error) {
      try {
        if (isNew) {
          await run(ctx.env,
            'INSERT INTO app_menu_items (menu_key, title, icon, link_type, link_value, need_login, trusted_only, sort_order, status) VALUES (?,?,?,?,?,?,?,?,?)',
            menuKey, title, icon, linkType, linkValue, needLogin, trustedOnly, sortOrder, status);
        } else {
          await run(ctx.env,
            'UPDATE app_menu_items SET menu_key=?, title=?, icon=?, link_type=?, link_value=?, need_login=?, trusted_only=?, sort_order=?, status=? WHERE id=?',
            menuKey, title, icon, linkType, linkValue, needLogin, trustedOnly, sortOrder, status, rowId);
        }
        invalidateEntityCache('menu');
        auditLog(`admin.app_menu.${isNew ? 'create' : 'update'}`, { user: ctx.session.username, menu_id: rowId, menu_key: menuKey });
        return redirect(buildListUrl(MANAGE_URL, { message: isNew ? '菜单已添加' : '菜单已更新' }));
      } catch (err) {
        console.error(`保存菜单失败 id=${rowId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }
  return editView(ctx, { isNew, row, error, errorField });
}

function editView(ctx, { isNew, row, error, errorField }) {
  if (!row) {
    return adminLayout({
      title: '编辑菜单项', currentPage: 'app_menu_manage', admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: error || '找不到该菜单项',
      content: '<div class="card"><div class="card-body">找不到该菜单项，可能已被删除。</div></div>'
    });
  }
  const isAction = strOf(row.link_type) === 'action';
  const main = textField({
    name: 'menu_key', label: '菜单标识', value: row.menu_key, required: true, maxlength: 50, errorField,
    placeholder: '如 likes'
  }) + textField({
    name: 'title', label: '菜单标题', value: row.title, required: true, errorField, placeholder: '如 我的点赞'
  }) + imageUploadField({
    env: ctx.env, name: 'icon', label: '图标', value: row.icon, mediaPicker: true, errorField,
    hint: '包内图标（/images/xxx.png）或站点图片均可；留空则该项不显示图标。'
  }) + selectField({
    name: 'link_type', label: '跳转类型', options: MENU_LINK_TYPES, value: strOf(row.link_type) || 'page', errorField
  }) + (isAction
    ? selectField({
      name: 'link_value', label: '内置动作', options: MENU_ACTIONS, value: row.link_value, errorField
    })
    : textField({
      name: 'link_value', label: '页面路径', value: row.link_value, errorField,
      hint: `必须以 ${pagePathHint()} 开头。`
    }));
  const side = selectField({
    name: 'need_login', label: '可见性', options: MENU_VISIBILITY, value: String(intOr(row.need_login, 0)), errorField,
    hint: '登录可见：未登录的小程序用户看不到这一整条，不是「点了才提示登录」。'
  }) + switchField({ name: 'trusted_only', label: '仅内部测试用户可见', checked: intOr(row.trusted_only, 0) === 1 })
    + numberField({ name: 'sort_order', label: '排序 (小在前)', value: row.sort_order, errorField })
    + switchField({ name: 'status', label: '启用', checked: intOr(row.status, 0) === 1 });
  const content = editShell({
    action: `/admin/app_menu_edit${isNew ? '' : `?id=${row.id}`}`,
    main, side, backUrl: MANAGE_URL, backLabel: '返回列表',
    primaryLabel: isNew ? '添加' : '保存修改'
  }) + imageUploadModal({ name: 'icon', purpose: 'cover' }) + mediaLibraryModal();
  return adminLayout({
    title: '编辑菜单项', currentPage: 'app_menu_manage', admin: ctx.session.username,
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
    const row = await one(ctx.env, 'SELECT menu_key FROM app_menu_items WHERE id = ?', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该菜单项' }));
    await run(ctx.env, 'DELETE FROM app_menu_items WHERE id = ?', intOr(rawId, 0));
    auditLog('admin.app_menu.delete', { user: ctx.session.username, menu_id: intOr(rawId, 0), menu_key: row.menu_key || '' });
    invalidateEntityCache('menu');
    message = '菜单已删除';
  } catch (err) {
    console.error(`删除菜单失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试' }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message }));
}

// 补齐内置菜单项: 只新增缺的 key, 已有项一律不动(被运营故意删掉的内置项也不会自己回来)
async function restoreMissing(ctx) {
  let existing = [];
  try {
    existing = (await all(ctx.env, 'SELECT menu_key FROM app_menu_items')).map((item) => strOf(item.menu_key));
  } catch (err) {
    console.error('补齐内置菜单项时读取失败', err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '补齐失败，请稍后重试' }));
  }
  const pending = DEFAULT_APP_MENU.filter((item) => !existing.includes(item.menu_key));
  if (!pending.length) {
    return redirect(buildListUrl(MANAGE_URL, { message: '内置菜单项都已存在，无需补齐' }));
  }
  try {
    for (const item of pending) {
      await run(ctx.env,
        'INSERT INTO app_menu_items (menu_key, title, icon, link_type, link_value, need_login, trusted_only, sort_order, status) VALUES (?,?,?,?,?,?,?,?,1)',
        item.menu_key, item.title, item.icon || '', item.link_type, item.link_value,
        intOr(item.need_login, 0), intOr(item.trusted_only, 0), intOr(item.sort_order, 0));
    }
    invalidateEntityCache('menu');
    auditLog('admin.app_menu.restore_missing', {
      user: ctx.session.username, inserted: pending.map((item) => item.menu_key).join(',')
    });
    return redirect(buildListUrl(MANAGE_URL, {
      message: `已补齐 ${pending.length} 条内置菜单项：${pending.map((item) => item.menu_key).join('、')}（已有 ${existing.length} 条保持不变）`
    }));
  } catch (err) {
    console.error('补齐内置菜单项失败', err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '补齐失败，请稍后重试' }));
  }
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['POST'], path: '/admin/app_menu_restore_missing', handler: restoreMissing },
  { methods: ['GET', 'POST'], path: '/admin/app_menu_edit', handler: editPage },
  { methods: ['POST'], path: '/admin/app_menu_delete', handler: deleteSubmit }
];
