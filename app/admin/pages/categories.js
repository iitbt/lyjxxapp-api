// 笔记分类: 列表(不分页) / 新增编辑(带"改标识迁移笔记") / 删除影响面确认页 / 删除
// 逐条对齐旧站 fastapi/app/admin/categories.py
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { adminLayout } from '../lib/layout.js';
import { getNameMap, nameFor } from '../lib/categorySource.js';
import {
  checkboxField, editShell, emptyRow, listMeta, numberField, selectField, switchField, textField
} from '../lib/partials.js';
import { statusActions, statusBadgeClass, statusKind, statusLabel } from '../lib/status.js';
import {
  CONTROLLED_LIST_LIMIT, auditLog, buildListUrl, idemKey, intOr, invalidateEntityCache,
  isDuplicateSubmit, strOf
} from '../lib/utils.js';

const MANAGE_URL = '/admin/app_category_manage';
const DELETE_CONFIRM_URL = '/admin/app_category_delete_confirm';
const COLUMNS = ['ID', '分类标识', '名称', '笔记数', '首页引用', '排序', '状态', '操作'];
// 标识格式: 小写字母开头 + 小写字母/数字/下划线, 最长 40(与旧站 CATEGORY_KEY_PATTERN 一致)
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

function statusCell(row) {
  const kind = statusKind('app_category');
  return `<span class="badge text-bg-${statusBadgeClass(kind, row.status)}" data-status-badge>${escapeHtml(statusLabel(kind, row.status))}</span>`;
}

function actionsCell(row) {
  const kind = statusKind('app_category');
  const buttons = statusActions(kind, row.status).map((action) => `<button type="button" class="btn btn-sm btn-${action.btnClass}"`
    + ` data-status-kind="${kind.key}" data-status-id="${row.id}" data-status-action="${escapeHtml(action.value)}"`
    + `${action.visible ? '' : ' hidden'}>${escapeHtml(action.label)}</button>`).join('');
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="/admin/app_category_edit?id=${row.id}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="${DELETE_CONFIRM_URL}?id=${row.id}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

function renderRows(rows) {
  if (!rows || !rows.length) return emptyRow(COLUMNS, '暂无分类');
  return rows.map((row) => `<tr>
  <td class="text-nowrap">${row.id}</td>
  <td><code>${escapeHtml(row.category_key)}</code></td>
  <td><div class="text-truncate clamp-lg">${escapeHtml(row.name || '-')}</div></td>
  <td class="text-nowrap">${intOr(row.news_count, 0)}</td>
  <td class="text-nowrap">${intOr(row.home_ref_count, 0) > 0
    ? `<span class="badge text-bg-warning">${intOr(row.home_ref_count, 0)}</span>`
    : '0'}</td>
  <td class="text-nowrap">${row.sort_order}</td>
  <td class="text-nowrap">${statusCell(row)}</td>
  <td class="text-nowrap">${actionsCell(row)}</td>
</tr>`).join('');
}

// 脏数据体检: 库里引用了"分类表里没有"的标识(历史数据)时, 页面顶部给黄框提示
async function unknownCategories(env) {
  return await all(env,
    "SELECT category, COUNT(*) AS total FROM news "
    + "WHERE deleted_at IS NULL AND (category IS NULL OR category='' "
    + 'OR category NOT IN (SELECT category_key FROM app_categories)) '
    + 'GROUP BY category ORDER BY total DESC').catch(() => []);
}

async function managePage(ctx) {
  let rows = [];
  let total = 0;
  let error = '';
  let unknown = [];
  try {
    total = intOr((await one(ctx.env, 'SELECT COUNT(*) AS c FROM app_categories')).c, 0);
    rows = await all(ctx.env,
      'SELECT c.*, '
      + '(SELECT COUNT(*) FROM news n WHERE n.category=c.category_key AND n.deleted_at IS NULL) AS news_count, '
      + '(SELECT COUNT(*) FROM app_home_sections h WHERE h.item_id=c.category_key) AS home_ref_count '
      + 'FROM app_categories c ORDER BY c.sort_order ASC, c.id ASC LIMIT ?', CONTROLLED_LIST_LIMIT);
    unknown = await unknownCategories(ctx.env);
  } catch (err) {
    console.error('获取分类列表失败', err && err.message);
    rows = [];
    error = '读取数据失败，请稍后重试';
  }
  const truncated = total > rows.length;
  const warn = unknown.length
    ? `<div class="alert alert-warning" role="alert">
      <i class="bi bi-exclamation-triangle" aria-hidden="true"></i>
      发现 ${unknown.length} 个未登记的分类（历史数据，共 ${unknown.reduce((sum, item) => sum + intOr(item.total, 0), 0)} 篇笔记）
      <ul class="mb-0 mt-2">${unknown.map((item) => `<li><code>${escapeHtml(item.category || '（空值）')}</code> · ${intOr(item.total, 0)} 篇
        <a class="ms-2" href="/admin/news_manage?category=${encodeURIComponent(strOf(item.category))}">查看笔记</a>
        <a class="ms-2" href="/admin/app_category_edit?id=0">新建同名分类</a></li>`).join('')}</ul>
    </div>`
    : '';
  const content = `<div class="card"><div class="card-body">
  ${warn}
  <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
    <a class="btn btn-primary" href="/admin/app_category_edit?id=0"><i aria-hidden="true" class="bi bi-plus-lg"></i> 添加分类</a>
    <span class="ms-auto text-end">${listMeta({ total, unit: '个分类', simple: true })}${truncated ? ` <span class="text-danger">（仅显示前 ${CONTROLLED_LIST_LIMIT} 个）</span>` : ''}</span>
  </div>
  <div class="table-responsive">
    <table aria-label="分类列表" class="table table-hover align-middle text-center">
      <thead class="table-light"><tr>${COLUMNS.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${renderRows(rows)}</tbody>
    </table>
  </div>
</div></div>`;
  return adminLayout({
    title: '笔记分类管理', currentPage: 'app_category_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

async function noteCountOf(env, categoryKey) {
  const row = await one(env, 'SELECT COUNT(*) AS c FROM news WHERE category=? AND deleted_at IS NULL', categoryKey)
    .catch(() => null);
  return intOr(row && row.c, 0);
}

async function editPage(ctx) {
  const rowId = intOr(ctx.query.id, 0);
  const isNew = rowId <= 0;
  let error = ctx.error || '';
  let errorField = '';
  let row;
  let oldKey = '';
  let noteCount = 0;
  if (isNew) {
    row = { id: 0, category_key: '', name: '', sort_order: 0, status: 1 };
  } else {
    row = await one(ctx.env, 'SELECT * FROM app_categories WHERE id = ?', rowId).catch(() => null);
    if (!row) return editView(ctx, { isNew: false, row: null, error: '找不到该分类', errorField: '', oldKey: '', noteCount: 0 });
    oldKey = strOf(row.category_key);
    noteCount = await noteCountOf(ctx.env, oldKey);
  }

  if (ctx.method === 'POST') {
    const form = ctx.form;
    // 标识统一小写(旧站也这么做)
    const categoryKey = strOf(form.category_key).toLowerCase();
    const name = strOf(form.name);
    const sortOrder = intOr(form.sort_order, 0);
    const status = form.status ? 1 : 0;
    const migrateNotes = form.migrate_notes ? 1 : 0;
    row = { id: rowId, category_key: categoryKey, name, sort_order: sortOrder, status };

    if (!categoryKey) {
      error = '请填写必填项: 分类标识';
      errorField = 'category_key';
    } else if (!KEY_PATTERN.test(categoryKey)) {
      error = '分类标识只能用小写字母开头 + 小写字母/数字/下划线（最长 40 位）';
      errorField = 'category_key';
    } else if (await keyExists(ctx.env, categoryKey, rowId)) {
      error = '该分类标识已被占用，请换一个';
      errorField = 'category_key';
    } else if (!name) {
      error = '请填写必填项: 名称';
      errorField = 'name';
    }

    if (!error) {
      try {
        let message = '';
        if (isNew) {
          await run(ctx.env, 'INSERT INTO app_categories (category_key, name, sort_order, status) VALUES (?,?,?,?)',
            categoryKey, name, sortOrder, status);
          message = '分类添加成功';
          auditLog('admin.app_category.create', { user: ctx.session.username, category_id: rowId, category_key: categoryKey });
        } else {
          const keyChanged = Boolean(oldKey) && oldKey !== categoryKey;
          let moved = 0;
          if (keyChanged && migrateNotes) {
            const result = await run(ctx.env, 'UPDATE news SET category=? WHERE category=?', categoryKey, oldKey);
            moved = intOr(result && result.meta && result.meta.changes, 0);
          }
          await run(ctx.env, 'UPDATE app_categories SET category_key=?, name=?, sort_order=?, status=? WHERE id=?',
            categoryKey, name, sortOrder, status, rowId);
          // 改标识必须同步首页板块引用: 否则那些入口会跳到一个不存在的分类(空列表)
          if (keyChanged) {
            await run(ctx.env, 'UPDATE app_home_sections SET item_id=? WHERE item_id=?', categoryKey, oldKey);
          }
          if (keyChanged && migrateNotes) message = `分类已更新，并把 ${moved} 篇笔记迁移到新标识`;
          else if (keyChanged) message = `分类已更新；旧标识「${oldKey}」下的笔记未迁移，请按需处理`;
          else message = '分类已更新';
          auditLog('admin.app_category.update', { user: ctx.session.username, category_id: rowId, category_key: categoryKey });
          // 迁移过笔记时额外清 news 实体(工厂/本页在分类实体之外还要照顾笔记口径)
          if (keyChanged && migrateNotes) invalidateEntityCache('news');
        }
        invalidateEntityCache('category');
        return redirect(buildListUrl(MANAGE_URL, { message }));
      } catch (err) {
        console.error(`保存分类失败 id=${rowId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }
  return editView(ctx, { isNew, row, error, errorField, oldKey, noteCount });
}

async function keyExists(env, categoryKey, rowId) {
  try {
    const found = await one(env, 'SELECT id FROM app_categories WHERE category_key=? AND id<>?', categoryKey, rowId);
    return Boolean(found);
  } catch (error) {
    console.error('检查分类标识唯一性失败', error && error.message);
    return true;
  }
}

function editView(ctx, { isNew, row, error, errorField, oldKey, noteCount }) {
  if (!row) {
    return adminLayout({
      title: '编辑分类', currentPage: 'app_category_manage', admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: error || '找不到该分类',
      content: '<div class="card"><div class="card-body">找不到该分类，可能已被删除。</div></div>'
    });
  }
  const migrateRow = !isNew && noteCount > 0
    ? checkboxField({
      name: 'migrate_notes', value: '1',
      labelHtml: `同时把这 <strong>${noteCount}</strong> 篇笔记迁移到新标识（推荐）`
    })
    : '';
  const top = !isNew
    ? `<div class="alert alert-warning" role="alert">
      <div class="fw-semibold">改「分类标识」= 换了一个分类。</div>
      <div class="small">已发布的笔记里存的是旧标识，不会自动迁移。当前标识 <code>${escapeHtml(oldKey)}</code> 下有 <strong>${noteCount}</strong> 篇笔记。</div>
    </div>`
    : '';
  const main = textField({
    name: 'category_key', label: '分类标识', value: row.category_key, required: true, maxlength: 40, errorField,
    placeholder: '如 outdoor（小写字母开头，可用小写字母/数字/下划线）'
  }) + textField({
    name: 'name', label: '名称', value: row.name, required: true, maxlength: 20, errorField,
    placeholder: '显示在小程序分类 tab 上的文字，如 户外'
  }) + migrateRow;
  const side = numberField({ name: 'sort_order', label: '排序 (小在前)', value: row.sort_order, errorField })
    + switchField({ name: 'status', label: '启用展示', checked: intOr(row.status, 0) === 1 });
  const content = editShell({
    top,
    action: `/admin/app_category_edit${isNew ? '' : `?id=${row.id}`}`,
    main, side, backUrl: MANAGE_URL, backLabel: '返回列表',
    primaryLabel: isNew ? '添加分类' : '保存修改'
  });
  return adminLayout({
    title: '编辑分类', currentPage: 'app_category_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error, content
  });
}

// 删除影响面确认页: 摊开"多少篇笔记"与"多少个首页入口"受影响, 并让用户选择是否迁移笔记
async function deleteConfirmPage(ctx) {
  const rowId = intOr(ctx.query.id, 0);
  const row = await one(ctx.env, 'SELECT * FROM app_categories WHERE id = ?', rowId).catch(() => null);
  if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该分类' }));
  const key = strOf(row.category_key);
  const noteCount = await noteCountOf(ctx.env, key);
  const homeRefs = intOr((await one(ctx.env,
    'SELECT COUNT(*) AS c FROM app_home_sections WHERE item_id=?', key).catch(() => null) || {}).c, 0);
  const targets = await all(ctx.env,
    'SELECT category_key, name FROM app_categories WHERE status=1 AND category_key<>? ORDER BY sort_order ASC, id ASC', key)
    .catch(() => []);
  const targetOptions = [['', '不迁移（笔记变成未归类）']]
    .concat(targets.map((item) => [strOf(item.category_key), `${strOf(item.name) || strOf(item.category_key)}（${strOf(item.category_key)}）`]));
  const content = `<div class="card"><div class="card-body">
  <h1 class="h5">即将删除分类「${escapeHtml(row.name || key)}」（<code>${escapeHtml(key)}</code>）</h1>
  <p class="text-muted">该分类下的笔记不会被删除，只是失去这个分类归属（仍可在「全部」里看到）。此操作不可撤销，但可以随时重新添加同名分类。</p>
  <div class="table-responsive">
    <table class="table table-sm align-middle" aria-label="删除影响面">
      <thead><tr><th scope="col">影响项</th><th scope="col">数量</th><th scope="col">说明</th></tr></thead>
      <tbody>
        <tr><td>该分类下的笔记</td><td>${noteCount}</td><td class="text-muted">笔记保留；若不迁移，它们会显示为「未归类」</td></tr>
        <tr><td>引用该分类的首页入口</td><td>${homeRefs}</td><td class="text-muted">这些入口（主题项目 / 拓展项目）是按分类标识跳转的，删除后会跳到空列表</td></tr>
      </tbody>
    </table>
  </div>
  ${homeRefs > 0 ? `<p class="text-danger small">删除后请到 「首页板块管理」 处理这 ${homeRefs} 个引用该分类的入口。（首页精选是独立模块，不引用分类，无需处理。）</p>` : ''}
  <form method="post" action="/admin/app_category_delete" class="d-flex flex-wrap align-items-end gap-2">
    <input type="hidden" name="id" value="${row.id}">
    <div>
      <label class="form-label" for="moveToSelect">把该分类下的笔记迁移到</label>
      <select class="form-select" name="move_to" id="moveToSelect">
        ${targetOptions.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}
      </select>
    </div>
    <button class="btn btn-danger" type="submit"><i class="bi bi-trash" aria-hidden="true"></i> 确认删除分类</button>
    <a class="btn btn-outline-secondary" href="${MANAGE_URL}">取消并返回</a>
  </form>
</div></div>`;
  return adminLayout({
    title: '删除分类', currentPage: 'app_category_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, content
  });
}

async function deleteSubmit(ctx) {
  const rawId = ctx.form.id;
  if (!rawId || !/^\d+$/.test(String(rawId).replace('-', ''))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '参数错误' }));
  }
  if (await isDuplicateSubmit(ctx.env, idemKey('category_delete', String(ctx.session.id || '-'), String(rawId)))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '该操作刚刚已执行，请勿重复提交' }));
  }
  const moveTo = strOf(ctx.form.move_to);
  let message = '';
  try {
    const row = await one(ctx.env, 'SELECT * FROM app_categories WHERE id = ?', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该分类' }));
    const key = strOf(row.category_key);
    const label = strOf(row.name) || key;
    if (moveTo && moveTo !== key && !(await one(ctx.env, 'SELECT id FROM app_categories WHERE category_key=?', moveTo))) {
      return redirect(buildListUrl(MANAGE_URL, { error: '迁移目标分类不存在' }));
    }
    let moved = 0;
    if (moveTo && moveTo !== key) {
      const result = await run(ctx.env, 'UPDATE news SET category=? WHERE category=?', moveTo, key);
      moved = intOr(result && result.meta && result.meta.changes, 0);
      invalidateEntityCache('news');
    }
    await run(ctx.env, 'DELETE FROM app_categories WHERE id = ?', intOr(rawId, 0));
    auditLog('admin.app_category.delete', { user: ctx.session.username, category_id: intOr(rawId, 0), category_key: key });
    invalidateEntityCache('category');
    message = moved > 0
      ? `分类「${label}」已删除，${moved} 篇笔记已迁移到「${moveTo}」`
      : `分类「${label}」已删除；该分类下的笔记未被删除，已变成未归类（可在笔记管理里改到其它分类）`;
  } catch (err) {
    console.error(`删除分类失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试' }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message }));
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['GET', 'POST'], path: '/admin/app_category_edit', handler: editPage },
  { methods: ['GET', 'HEAD'], path: DELETE_CONFIRM_URL, handler: deleteConfirmPage },
  { methods: ['POST'], path: '/admin/app_category_delete', handler: deleteSubmit }
];
