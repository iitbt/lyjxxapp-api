// 首页板块: 列表(不分页) / 新增编辑 / 删除
// 逐条对齐旧站 fastapi/app/admin/app_home.py: 入口身份是"笔记分类", 名称由分类表派生
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { assetUrl } from '../../core/media_scheme.js';
import { adminLayout } from '../lib/layout.js';
import { getNameMap, getActiveKeys, nameFor, optionsForSelect } from '../lib/categorySource.js';
import {
  editShell, emptyRow, imageUploadField, imageUploadModal, listMeta, mediaLibraryModal,
  numberField, selectField, switchField
} from '../lib/partials.js';
import { statusActions, statusBadgeClass, statusKind, statusLabel } from '../lib/status.js';
import { auditLog, buildListUrl, intOr, invalidateEntityCache, strOf } from '../lib/utils.js';

const MANAGE_URL = '/admin/app_home_manage';
const COLUMNS = ['ID', '预览', '板块', '分类', '排序', '状态', '操作'];
// 板块定义(唯一维护点, 与旧站 core/catalog.py 的 HOME_SECTION_LABELS / ORDER 一致)
const SECTION_ORDER = ['main', 'ext'];
const SECTION_LABELS = { main: '主题项目', ext: '拓展项目' };
const SECTION_OPTIONS = SECTION_ORDER.map((key) => [key, SECTION_LABELS[key]]);

const sectionText = (key) => SECTION_LABELS[strOf(key)] || strOf(key) || '-';
const sectionOrEmpty = (raw) => {
  const key = strOf(raw);
  return SECTION_LABELS[key] ? key : '';
};

// 板块排序: 小程序展示顺序 → 排序值 → id(字典序不是展示顺序)
function sortKey(row) {
  const key = strOf(row.section_key);
  const order = SECTION_ORDER.indexOf(key);
  return [order < 0 ? SECTION_ORDER.length : order, intOr(row.sort_order, 0), intOr(row.id, 0)];
}

function statusCell(row) {
  const kind = statusKind('home_section');
  return `<span class="badge text-bg-${statusBadgeClass(kind, row.status)}" data-status-badge>${escapeHtml(statusLabel(kind, row.status))}</span>`;
}

function actionsCell(row, section) {
  const kind = statusKind('home_section');
  const buttons = statusActions(kind, row.status).map((action) => `<button type="button" class="btn btn-sm btn-${action.btnClass}"`
    + ` data-status-kind="${kind.key}" data-status-id="${row.id}" data-status-action="${escapeHtml(action.value)}"`
    + `${action.visible ? '' : ' hidden'}>${escapeHtml(action.label)}</button>`).join('');
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="/admin/app_home_edit?id=${row.id}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=home_section&amp;id=${row.id}${section ? `&amp;section=${encodeURIComponent(section)}` : ''}&amp;back=${encodeURIComponent(MANAGE_URL)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

function renderRows(ctx, rows) {
  if (!rows || !rows.length) return emptyRow(COLUMNS, '暂无板块入口');
  return rows.map((row) => {
    const image = strOf(row.image_url);
    const preview = image
      ? `<img src="${escapeHtml(assetUrl(ctx.env, image, ''))}" class="cover-thumb" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`
      : '-';
    // 分类名实时取自分类表(分类改名后这里立即跟随), 未知标识原样显示便于发现脏数据
    const categoryText = nameFor(ctx.nameMap || {}, row.item_id, strOf(row.item_id));
    return `<tr>
  <td class="text-nowrap">${row.id}</td>
  <td>${preview}</td>
  <td class="text-nowrap">${escapeHtml(sectionText(row.section_key))}</td>
  <td class="text-nowrap">${escapeHtml(categoryText || '-')}</td>
  <td class="text-nowrap">${row.sort_order}</td>
  <td class="text-nowrap">${statusCell(row)}</td>
  <td class="text-nowrap">${actionsCell(row, ctx.sectionFilter)}</td>
</tr>`;
  }).join('');
}

async function managePage(ctx) {
  const section = sectionOrEmpty(ctx.query.section);
  let rows = [];
  let error = '';
  try {
    const where = section ? ' WHERE section_key = ?' : '';
    rows = await all(ctx.env, `SELECT * FROM app_home_sections${where}` + (section ? '' : ''), ...(section ? [section] : []));
  } catch (err) {
    console.error('获取首页板块列表失败', err && err.message);
    rows = [];
    error = '读取数据失败，请稍后重试';
  }
  ctx.nameMap = await getNameMap(ctx.env);
  ctx.sectionFilter = section;
  rows = rows.slice().sort((a, b) => {
    const left = sortKey(a);
    const right = sortKey(b);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
  });
  const filterForm = `<form class="d-flex gap-2" method="get" action="${MANAGE_URL}">
    <select class="form-select form-select-sm" name="section" style="max-width:140px">
      <option value="">全部板块</option>
      ${SECTION_OPTIONS.map(([value, label]) => `<option value="${value}"${section === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
    </select>
    <button class="btn btn-sm btn-outline-secondary" type="submit"><i class="bi bi-funnel" aria-hidden="true"></i> 筛选</button>
  </form>`;
  const content = `<div class="card"><div class="card-body">
  <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
    <a class="btn btn-primary" href="/admin/app_home_edit?id=0"><i aria-hidden="true" class="bi bi-plus-lg"></i> 添加入口</a>
    ${filterForm}
    <span class="ms-auto text-end">${listMeta({ total: rows.length, unit: '条', simple: true })}</span>
  </div>
  <div class="table-responsive">
    <table aria-label="首页板块列表" class="table table-hover align-middle text-center">
      <thead class="table-light"><tr>${COLUMNS.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${renderRows(ctx, rows)}</tbody>
    </table>
  </div>
</div></div>`;
  return adminLayout({
    title: '首页板块管理', currentPage: 'app_home_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

async function editPage(ctx) {
  const rowId = intOr(ctx.query.id, 0);
  const isNew = rowId <= 0;
  let error = ctx.error || '';
  let errorField = '';
  let row;
  if (isNew) {
    row = { id: 0, section_key: SECTION_ORDER[0], item_id: '', name: '', image_url: '', sort_order: 0, status: 1 };
  } else {
    row = await one(ctx.env, 'SELECT * FROM app_home_sections WHERE id = ?', rowId).catch(() => null);
    if (!row) return editView(ctx, { isNew: false, row: null, error: '找不到该配置项', errorField: '', options: [] });
  }
  const activeKeys = await getActiveKeys(ctx.env);
  const options = await optionsForSelect(ctx.env, row.item_id);

  if (ctx.method === 'POST') {
    const form = ctx.form;
    const sectionKey = strOf(form.section_key);
    const itemId = strOf(form.item_id);
    const imageUrl = strOf(form.image_url);
    const sortOrder = intOr(form.sort_order, 0);
    const status = form.status ? 1 : 0;
    row = { id: rowId, section_key: sectionKey, item_id: itemId, name: row.name, image_url: imageUrl, sort_order: sortOrder, status };

    if (!SECTION_LABELS[sectionKey]) {
      error = '请选择有效的板块';
      errorField = 'section_key';
    } else if (!activeKeys.has(itemId)) {
      error = '请选择有效的分类（须为「分类管理」中已启用的分类）';
      errorField = 'item_id';
    } else if (!imageUrl) {
      error = '请填写必填项: 图片地址';
      errorField = 'image_url';
    }
    if (!error) {
      // 显示名统一跟随分类表: 分类改名后首页入口自动跟着改, 不必再来这里改一遍
      const nameMap = await getNameMap(ctx.env);
      const derivedName = nameFor(nameMap, itemId, itemId);
      try {
        if (isNew) {
          await run(ctx.env,
            'INSERT INTO app_home_sections (section_key, item_id, name, image_url, sort_order, status) VALUES (?,?,?,?,?,?)',
            sectionKey, itemId, derivedName, imageUrl, sortOrder, status);
        } else {
          await run(ctx.env,
            'UPDATE app_home_sections SET section_key=?, item_id=?, name=?, image_url=?, sort_order=?, status=? WHERE id=?',
            sectionKey, itemId, derivedName, imageUrl, sortOrder, status, rowId);
        }
        invalidateEntityCache('home_section');
        auditLog(`admin.app_home.${isNew ? 'create' : 'update'}`,
          { user: ctx.session.username, home_section_id: rowId, section_key: sectionKey });
        return redirect(buildListUrl(MANAGE_URL, {
          message: isNew ? '板块入口添加成功' : '板块入口已更新',
          filters: { section: sectionOrEmpty(sectionKey) }
        }));
      } catch (err) {
        console.error(`保存板块入口失败 id=${rowId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
    row.name = row.name || '';
  }
  return editView(ctx, { isNew, row, error, errorField, options });
}

function editView(ctx, { isNew, row, error, errorField, options }) {
  if (!row) {
    return adminLayout({
      title: '编辑首页板块', currentPage: 'app_home_manage', admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: error || '找不到该配置项',
      content: '<div class="card"><div class="card-body">找不到该配置项，可能已被删除。</div></div>'
    });
  }
  const main = selectField({
    name: 'section_key', label: '板块', options: SECTION_OPTIONS, value: row.section_key, errorField,
    hint: '主题项目与拓展项目分别对应小程序首页的两排入口。'
  }) + selectField({
    name: 'item_id', label: '分类', options: options.length ? options : [['', '（还没有可用分类）']],
    value: row.item_id, errorField, required: true,
    hint: '入口点进去看到的是这个分类下的笔记，所以只能选「分类管理」里已启用的分类。'
  }) + imageUploadField({
    env: ctx.env, name: 'image_url', label: '图片地址', value: row.image_url,
    required: true, mediaPicker: true, errorField
  });
  const side = numberField({ name: 'sort_order', label: '排序 (小在前)', value: row.sort_order, errorField })
    + switchField({ name: 'status', label: '启用展示', checked: intOr(row.status, 0) === 1 });
  const content = editShell({
    action: `/admin/app_home_edit${isNew ? '' : `?id=${row.id}`}`,
    main, side, backUrl: MANAGE_URL, backLabel: '返回列表',
    primaryLabel: isNew ? '添加入口' : '保存修改'
  }) + imageUploadModal({ name: 'image_url', purpose: 'cover' }) + mediaLibraryModal();
  return adminLayout({
    title: '编辑首页板块', currentPage: 'app_home_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error, content
  });
}

async function deleteSubmit(ctx) {
  const rawId = ctx.form.id;
  const section = sectionOrEmpty(ctx.form.section);
  if (!rawId || !/^\d+$/.test(String(rawId).replace('-', ''))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '参数错误', filters: { section } }));
  }
  let message = '';
  let redirectSection = section;
  try {
    const row = await one(ctx.env, 'SELECT section_key, image_url FROM app_home_sections WHERE id = ?', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该配置项', filters: { section } }));
    // 回跳优先按这一行自己所属的板块: 删的是"拓展项目"里的入口, 不该退回"主题项目"的筛选视图
    redirectSection = sectionOrEmpty(row.section_key) || section;
    await run(ctx.env, 'DELETE FROM app_home_sections WHERE id = ?', intOr(rawId, 0));
    auditLog('admin.app_home.delete', {
      user: ctx.session.username, home_section_id: intOr(rawId, 0),
      section_key: row.section_key || '', image_url: row.image_url || ''
    });
    invalidateEntityCache('home_section');
    message = '板块入口已删除';
  } catch (err) {
    console.error(`删除板块入口失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试', filters: { section } }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, filters: { section: redirectSection } }));
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['GET', 'POST'], path: '/admin/app_home_edit', handler: editPage },
  { methods: ['POST'], path: '/admin/app_home_delete', handler: deleteSubmit }
];
