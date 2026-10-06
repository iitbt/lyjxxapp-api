// 专题精选(摩旅 / 户外): 聚合列表(tab 切换) / 行片段 / 新增编辑 / 预览 / 删除
// 与旧站 fastapi/app/admin/topics.py 一致: 两份配置驱动同一套页面, 旧地址 302 到聚合页
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { assetUrl } from '../../core/media_scheme.js';
import { adminLayout } from '../lib/layout.js';
import {
  editShell, emptyRow, imageUploadField, imageUploadModal, listShell, mediaLibraryModal,
  pagerScript, selectField, textareaField, textField
} from '../lib/partials.js';
import { statusActions, statusBadgeClass, statusKind, statusLabel } from '../lib/status.js';
import {
  PER_PAGE, auditLog, buildListUrl, clampPage, firstScreenLimit, idemKey,
  invalidateEntityCache, isDuplicateSubmit, intOr, strOf
} from '../lib/utils.js';

// 两份配置: 表 / 状态 kind / 文案 / 路径 / 额外字段 —— 页面结构由它驱动, 不再各写一套
const CONFIGS = {
  motorcycle: {
    kind: 'motorcycle',
    table: 'motorcycle_trips',
    itemLabel: '摩旅路线',
    title: '摩旅精选管理',
    manage: '/admin/motorcycle_manage',
    edit: '/admin/motorcycle_edit',
    preview: '/admin/motorcycle_preview',
    rows: '/admin/motorcycle_rows',
    deletePath: '/admin/motorcycle_delete',
    columns: ['title', 'description', 'poster', 'videoUrl', 'status', 'distance', 'duration', 'difficulty'],
    extraFields: ['distance', 'duration', 'difficulty'],
    labels: {
      title: '标题', description: '简介', poster: '封面图 URL', videoUrl: '视频地址', status: '状态',
      distance: '骑行里程(km)', duration: '计划时长', difficulty: '难度'
    },
    headerLabels: { poster: '封面', description: '简介', status: '状态', videoUrl: '视频' }
  },
  outdoor: {
    kind: 'outdoor',
    table: 'outdoor_activities',
    itemLabel: '户外活动',
    title: '户外精选管理',
    manage: '/admin/outdoor_manage',
    edit: '/admin/outdoor_edit',
    preview: '/admin/outdoor_preview',
    rows: '/admin/outdoor_rows',
    deletePath: '/admin/outdoor_delete',
    columns: ['title', 'description', 'poster', 'videoUrl', 'status', 'date', 'location'],
    extraFields: ['date', 'location'],
    labels: {
      title: '标题', description: '简介', poster: '封面图 URL', videoUrl: '视频地址', status: '状态',
      date: '活动日期', location: '活动地点'
    },
    headerLabels: { poster: '封面', description: '简介', status: '状态', videoUrl: '视频' }
  }
};

const TOPIC_MANAGE_URL = '/admin/topics_manage';
const SEARCHABLE_COLS = ['title', 'description', 'location', 'difficulty', 'duration', 'distance', 'date'];
const STATUS_OPTIONS = [['approved', '显示'], ['pending', '待审核']];

// 认两种入参: 列表页的 ?topic=outdoor, 以及编辑/预览/删除的路径 /admin/outdoor_edit
function configOf(raw) {
  const key = strOf(raw).toLowerCase();
  if (key.includes('outdoor')) return CONFIGS.outdoor;
  return CONFIGS.motorcycle;
}

function headerLabel(config, column) {
  return config.headerLabels[column] || config.labels[column] || column;
}

// 搜索: 只在"这份配置真实存在的列"里搜(摩旅没有 location, 户外没有 difficulty)
function topicWhere(config, keyword) {
  if (!keyword) return { sql: '', args: [] };
  const cols = SEARCHABLE_COLS.filter((col) => config.columns.includes(col));
  if (!cols.length) return { sql: '', args: [] };
  return {
    sql: ` WHERE (${cols.map((col) => `${col} LIKE ?`).join(' OR ')})`,
    args: cols.map(() => `%${keyword}%`)
  };
}

function statusCell(config, row) {
  const kind = statusKind(config.kind);
  return `<span class="badge text-bg-${statusBadgeClass(kind, row.status)}" data-status-badge>${escapeHtml(statusLabel(kind, row.status))}</span>`;
}

function actionsCell(ctx, config, row) {
  const kind = statusKind(config.kind);
  const page = clampPage(ctx.query.page, null);
  const buttons = statusActions(kind, row.status).map((action) => `<button type="button" class="btn btn-sm btn-${action.btnClass}"`
    + ` data-status-kind="${kind.key}" data-status-id="${row.id}" data-status-action="${escapeHtml(action.value)}"`
    + `${action.visible ? '' : ' hidden'}>${escapeHtml(action.label)}</button>`).join('');
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="${config.edit}?id=${row.id}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    <a class="btn btn-sm btn-outline-secondary" href="${config.preview}?id=${row.id}" target="_blank" rel="noopener"><i class="bi bi-eye" aria-hidden="true"></i> 预览</a>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=${config.kind}&amp;id=${row.id}&amp;page=${page}&amp;back=${encodeURIComponent(config.manage)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

function cellOf(ctx, config, row, column) {
  const value = row[column];
  if (column === 'poster') {
    const poster = strOf(value);
    return poster
      ? `<img src="${escapeHtml(assetUrl(ctx.env, poster, ''))}" class="cover-thumb" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`
      : '-';
  }
  if (column === 'description') {
    return `<div class="desc-cell text-truncate clamp-lg" title="${escapeHtml(strOf(value))}">${escapeHtml(strOf(value) || '-')}</div>`;
  }
  if (column === 'status') return statusCell(config, row);
  if (column === 'videoUrl') {
    const video = strOf(value);
    if (!video) return '-';
    return `<a href="${escapeHtml(assetUrl(ctx.env, video, ''))}" target="_blank" rel="noopener" aria-label="查看视频">`
      + '<i class="bi bi-play-circle" aria-hidden="true"></i></a>';
  }
  if (column === 'title') {
    return `<div class="text-truncate clamp-lg" title="${escapeHtml(strOf(value))}">${escapeHtml(strOf(value) || '-')}</div>`
      + `<a class="small" href="${config.preview}?id=${row.id}" target="_blank" rel="noopener">打开预览</a>`;
  }
  return escapeHtml(strOf(value) || '-');
}

function renderRows(ctx, config, rows) {
  if (!rows || !rows.length) return emptyRow(['ID'].concat(config.columns, ['操作']), `暂无${config.itemLabel}内容`);
  return rows.map((row) => {
    const cells = config.columns.map((column) => {
      const className = ['poster', 'status', 'videoUrl'].includes(column) ? 'text-nowrap' : '';
      return `<td${className ? ` class="${className}"` : ''}>${cellOf(ctx, config, row, column)}</td>`;
    }).join('');
    return `<tr>\n  <td class="text-nowrap">${row.id}</td>${cells}\n  <td class="text-nowrap">${actionsCell(ctx, config, row)}</td>\n</tr>`;
  }).join('');
}

function tabNav(activeKind) {
  return `<ul class="nav nav-pills mb-3">
    <li class="nav-item"><a class="nav-link${activeKind === 'motorcycle' ? ' active' : ''}" href="${TOPIC_MANAGE_URL}?topic=motorcycle">摩旅精选</a></li>
    <li class="nav-item"><a class="nav-link${activeKind === 'outdoor' ? ' active' : ''}" href="${TOPIC_MANAGE_URL}?topic=outdoor">户外精选</a></li>
  </ul>`;
}

async function managePage(ctx) {
  const config = configOf(ctx.query.topic);
  const keyword = strOf(ctx.query.keyword);
  const where = topicWhere(config, keyword);
  let total = 0;
  let totalPages = 1;
  let page = 1;
  let rows = [];
  let error = '';
  try {
    const counted = await one(ctx.env, `SELECT COUNT(*) AS total FROM ${config.table}${where.sql}`, ...where.args);
    total = intOr(counted && counted.total, 0);
    totalPages = Math.max(Math.ceil(total / PER_PAGE), 1);
    const limited = firstScreenLimit(ctx.query.page, PER_PAGE, totalPages);
    page = limited[0];
    rows = await all(ctx.env, `SELECT * FROM ${config.table}${where.sql} ORDER BY id DESC LIMIT ?`, ...where.args, limited[1]);
  } catch (err) {
    // 查询失败要明说, 不能渲染成"暂无数据"
    console.error(`获取${config.itemLabel}列表失败`, err && err.message);
    rows = [];
    error = '读取数据失败，请稍后重试';
  }
  const columns = ['ID'].concat(config.columns.map((column) => headerLabel(config, column)), ['操作']);
  const searchForm = `<form class="d-flex gap-2" method="get" action="${TOPIC_MANAGE_URL}">
    <input type="hidden" name="topic" value="${config.kind}">
    <input type="search" class="form-control form-control-sm" name="keyword" value="${escapeHtml(keyword)}" placeholder="搜索标题/简介等" style="max-width:200px">
    <button class="btn btn-sm btn-outline-secondary" type="submit"><i class="bi bi-search" aria-hidden="true"></i> 搜索</button>
  </form>`;
  const content = tabNav(config.kind) + listShell({
    title: config.title, columns, rows: renderRows(ctx, config, rows),
    actions: `<a class="btn btn-primary" href="${config.edit}?id=0"><i aria-hidden="true" class="bi bi-plus-lg"></i> 新增${config.itemLabel}</a>${searchForm}`,
    tbodyId: 'topicTbody', sentinelId: 'topicLoadMore', textId: 'topicLoadMoreText',
    hintId: 'topicLoadedHint', total, perPage: PER_PAGE, currentPage: page, totalPages,
    unit: '条', backTopId: 'topicBackTopBtn', jumpBtnId: 'topicJumpBtn', jumpInputId: 'topicJumpInput'
  });
  return adminLayout({
    title: config.title, currentPage: config.manage.replace('/admin/', ''), admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content,
    scripts: pagerScript({
      tbodyId: 'topicTbody', sentinelId: 'topicLoadMore', textId: 'topicLoadMoreText',
      rowsUrl: config.rows, currentPage: page, totalPages, total, perPage: PER_PAGE,
      unit: '条', hintId: 'topicLoadedHint', announceLabel: config.itemLabel, baseUrl: TOPIC_MANAGE_URL,
      backTopId: 'topicBackTopBtn', jumpBtnId: 'topicJumpBtn', jumpInputId: 'topicJumpInput',
      version: ctx.version
    })
  });
}

// 旧地址(带原查询串)302 到聚合页 —— 旧书签/旧链接的 page / keyword 不丢
function legacyRedirect(kind) {
  return (ctx) => {
    const params = new URLSearchParams(ctx.query);
    params.set('topic', kind);
    return new Response(null, { status: 302, headers: { location: `${TOPIC_MANAGE_URL}?${params.toString()}` } });
  };
}

function json(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function rowsFragment(ctx) {
  // 行片段地址是 /admin/motorcycle_rows 与 /admin/outdoor_rows, 靠路径区分配置
  const config = configOf(ctx.query.topic || ctx.path);
  const keyword = strOf(ctx.query.keyword);
  const where = topicWhere(config, keyword);
  const page = clampPage(ctx.query.page, null);
  let rows = [];
  try {
    rows = await all(ctx.env,
      `SELECT * FROM ${config.table}${where.sql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...where.args, PER_PAGE + 1, (page - 1) * PER_PAGE);
  } catch (err) {
    console.error(`获取${config.itemLabel}分页数据失败`, err && err.message);
    return json({ success: false, message: '加载失败，请稍后重试' });
  }
  const hasMore = rows.length > PER_PAGE;
  rows = rows.slice(0, PER_PAGE);
  // 越界时返回空串: 以前返回"暂无内容"行, 前端会当数据插入并继续翻页
  if (!rows.length) return json({ success: true, rows: '', has_more: false });
  return json({ success: true, rows: renderRows(ctx, config, rows), has_more: hasMore });
}

const VIDEO_HINT = '填站内相对路径（如 video/video_xxx.mp4），或点右侧「本地上传」传新视频、「视频素材库」从服务器已有视频里选。';
const POSTER_HINT = '封面建议使用 16:9 横版图片（如 1280×720），后台统一按 16:9 居中裁剪显示。';

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

async function editPage(ctx) {
  const config = configOf(ctx.query.topic || ctx.path);
  const rowId = intOr(ctx.query.id, 0);
  const isNew = rowId <= 0;
  let error = ctx.error || '';
  let errorField = '';
  let row;
  if (isNew) {
    row = { id: 0, title: '', description: '', poster: '', videoUrl: '', status: 'approved' };
    for (const field of config.extraFields) row[field] = '';
  } else {
    row = await one(ctx.env, `SELECT * FROM ${config.table} WHERE id = ?`, rowId).catch(() => null);
    if (!row) return editView(ctx, config, { isNew: false, row: null, error: '找不到该记录', errorField: '' });
  }

  if (ctx.method === 'POST') {
    const form = ctx.form;
    const title = strOf(form.title);
    const description = strOf(form.description);
    const poster = strOf(form.poster);
    const videoUrl = strOf(form.videoUrl);
    // 状态只接受 approved/pending, 其它(含空)一律回落 approved
    const wanted = strOf(form.status);
    const status = STATUS_OPTIONS.some(([value]) => value === wanted) ? wanted : 'approved';
    row = { id: rowId, title, description, poster, videoUrl, status };
    for (const field of config.extraFields) row[field] = strOf(form[field]);

    const missing = [];
    if (!title) missing.push(config.labels.title);
    if (!description) missing.push(config.labels.description);
    if (!poster) missing.push(config.labels.poster);
    if (missing.length) {
      error = `请填写必填项: ${missing.join('、')}`;
      errorField = !title ? 'title' : (!description ? 'description' : 'poster');
    } else if (isNew && await isDuplicateSubmit(ctx.env,
      idemKey('topic_create', String(ctx.session.id || '-'), config.kind, title, poster))) {
      error = '该操作刚刚已执行，请勿重复提交';
    }

    if (!error) {
      try {
        const cols = ['title', 'description', 'poster', 'videoUrl', 'status'].concat(config.extraFields);
        const values = cols.map((name) => row[name]);
        if (isNew) {
          await run(ctx.env,
            `INSERT INTO ${config.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...values);
        } else {
          await run(ctx.env,
            `UPDATE ${config.table} SET ${cols.map((name) => `${name} = ?`).join(', ')} WHERE id = ?`, ...values, rowId);
        }
        invalidateEntityCache('topic');
        auditLog(`admin.${config.kind}.${isNew ? 'create' : 'update'}`, { user: ctx.session.username, item_id: rowId, title });
        return redirect(`${TOPIC_MANAGE_URL}?topic=${config.kind}&message=${encodeURIComponent(isNew ? '新增成功' : '更新成功')}`);
      } catch (err) {
        console.error(`保存${config.itemLabel}失败 id=${rowId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }
  return editView(ctx, config, { isNew, row, error, errorField });
}

function editView(ctx, config, { isNew, row, error, errorField }) {
  if (!row) {
    return adminLayout({
      title: config.title, currentPage: config.manage.replace('/admin/', ''), admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: error || '找不到该记录',
      content: '<div class="card"><div class="card-body">找不到该记录，可能已被删除。</div></div>'
    });
  }
  const main = textField({ name: 'title', label: config.labels.title, value: row.title, required: true, errorField })
    + textareaField({ name: 'description', label: config.labels.description, value: row.description, rows: 4, required: true, errorField })
    + `<div class="row g-3">`
    + `<div class="col-md-6">${imageUploadField({
      env: ctx.env, name: 'poster', label: config.labels.poster, value: row.poster,
      required: true, mediaPicker: true, errorField, colClass: 'mb-3', hint: POSTER_HINT
    })}</div>`
    + `<div class="col-md-6">${imageUploadField({
      env: ctx.env, name: 'videoUrl', label: config.labels.videoUrl, value: row.videoUrl,
      mediaKind: 'video', mediaPicker: true, errorField, colClass: 'mb-3', hint: VIDEO_HINT
    })}</div>`
    + '</div>'
    + config.extraFields.map((field) => textField({
      name: field, label: config.labels[field] || field, value: row[field], errorField
    })).join('');
  const side = selectField({ name: 'status', label: config.labels.status, options: STATUS_OPTIONS, value: row.status, errorField });
  const content = editShell({
    action: `${config.edit}${isNew ? '' : `?id=${row.id}`}`,
    main, side, backUrl: TOPIC_MANAGE_URL, backLabel: '返回列表',
    primaryLabel: isNew ? `新增${config.itemLabel}` : `保存修改${config.itemLabel}`
  }) + imageUploadModal({ name: 'poster', purpose: 'cover' })
    + imageUploadModal({ name: 'videoUrl', purpose: 'video', kind: 'video' })
    + mediaLibraryModal();
  return adminLayout({
    title: config.title, currentPage: config.manage.replace('/admin/', ''), admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error, content
  });
}

async function previewPage(ctx) {
  const config = configOf(ctx.query.topic || ctx.path);
  const rowId = intOr(ctx.query.id, 0);
  if (rowId <= 0) {
    return adminLayout({
      title: config.title, currentPage: config.manage.replace('/admin/', ''), admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: '缺少记录ID',
      content: '<div class="card"><div class="card-body">缺少记录ID。</div></div>'
    });
  }
  const row = await one(ctx.env, `SELECT * FROM ${config.table} WHERE id = ?`, rowId).catch(() => null);
  if (!row) {
    return adminLayout({
      title: config.title, currentPage: config.manage.replace('/admin/', ''), admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: '找不到该记录',
      content: '<div class="card"><div class="card-body">找不到该记录。</div></div>'
    });
  }
  const kind = statusKind(config.kind);
  const poster = strOf(row.poster);
  const video = strOf(row.videoUrl);
  const extraRows = config.extraFields
    .filter((field) => strOf(row[field]))
    .map((field) => `<tr><th scope="row">${escapeHtml(config.labels[field] || field)}</th><td>${escapeHtml(strOf(row[field]))}</td></tr>`)
    .join('');
  const content = `<div class="card"><div class="card-body">
  <span class="badge text-bg-${statusBadgeClass(kind, row.status)}">${escapeHtml(statusLabel(kind, row.status))}</span>
  <h4 class="mt-2">${escapeHtml(strOf(row.title))}</h4>
  ${poster ? `<img src="${escapeHtml(assetUrl(ctx.env, poster, ''))}" class="img-fluid cover-detail mb-3" alt="" onerror="this.style.display='none'">` : ''}
  <p>${escapeHtml(strOf(row.description))}</p>
  ${video ? `<a class="btn btn-outline-primary btn-sm mb-3" href="${escapeHtml(assetUrl(ctx.env, video, ''))}" target="_blank" rel="noopener"><i class="bi bi-play-circle" aria-hidden="true"></i> 查看视频</a>` : ''}
  ${extraRows ? `<div class="table-responsive"><table class="table table-sm align-middle"><tbody>${extraRows}</tbody></table></div>` : ''}
  <div class="d-flex gap-2">
    <a class="btn btn-outline-primary btn-sm" href="${config.edit}?id=${row.id}">返回编辑</a>
    <a class="btn btn-outline-secondary btn-sm" href="${TOPIC_MANAGE_URL}?topic=${config.kind}">返回列表</a>
  </div>
</div></div>`;
  return adminLayout({
    title: config.title, currentPage: config.manage.replace('/admin/', ''), admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, content
  });
}

async function deleteSubmit(ctx) {
  const config = configOf(ctx.query.topic || ctx.path);
  const rawId = ctx.form.id;
  const page = ctx.form.page;
  const back = buildListUrl(TOPIC_MANAGE_URL, { filters: { topic: config.kind }, page });
  if (!rawId || !/^\d+$/.test(String(rawId).replace('-', ''))) {
    return redirect(buildListUrl(TOPIC_MANAGE_URL, { error: '参数错误', filters: { topic: config.kind }, page }));
  }
  if (await isDuplicateSubmit(ctx.env, idemKey('topic_delete', String(ctx.session.id || '-'), config.kind, String(rawId)))) {
    return redirect(buildListUrl(TOPIC_MANAGE_URL, { error: '该操作刚刚已执行，请勿重复提交', filters: { topic: config.kind }, page }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, `SELECT poster FROM ${config.table} WHERE id = ?`, intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(TOPIC_MANAGE_URL, { error: '找不到该记录', filters: { topic: config.kind }, page }));
    await run(ctx.env, `DELETE FROM ${config.table} WHERE id = ?`, intOr(rawId, 0));
    // 只删数据库记录, 绝不物理删素材: 同一封面可能被多条记录引用
    auditLog(`admin.${config.kind}.delete`, { user: ctx.session.username, item_id: intOr(rawId, 0), poster: row.poster || '' });
    invalidateEntityCache('topic');
    message = `${config.itemLabel}已删除`;
  } catch (err) {
    console.error(`删除${config.itemLabel}失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(TOPIC_MANAGE_URL, { error: '删除失败，请稍后重试', filters: { topic: config.kind }, page }));
  }
  return redirect(buildListUrl(TOPIC_MANAGE_URL, { message, filters: { topic: config.kind }, page }));
}

// 编辑/预览/删除 都需要知道"当前是哪一份配置": 旧站靠路径里的 motorcycle/outdoor 判定
function configFromPath(path) {
  return path.includes('outdoor') ? CONFIGS.outdoor : CONFIGS.motorcycle;
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: TOPIC_MANAGE_URL, handler: managePage },
  { methods: ['GET', 'HEAD'], path: '/admin/motorcycle_manage', handler: legacyRedirect('motorcycle') },
  { methods: ['GET', 'HEAD'], path: '/admin/outdoor_manage', handler: legacyRedirect('outdoor') },
  { methods: ['GET', 'HEAD'], path: '/admin/motorcycle_rows', handler: rowsFragment },
  { methods: ['GET', 'HEAD'], path: '/admin/outdoor_rows', handler: rowsFragment },
  { methods: ['GET', 'POST'], path: '/admin/motorcycle_edit', handler: (ctx) => editPage(ctx, CONFIGS.motorcycle) },
  { methods: ['GET', 'POST'], path: '/admin/outdoor_edit', handler: (ctx) => editPage(ctx, CONFIGS.outdoor) },
  { methods: ['GET', 'HEAD'], path: '/admin/motorcycle_preview', handler: (ctx) => previewPage(ctx, CONFIGS.motorcycle) },
  { methods: ['GET', 'HEAD'], path: '/admin/outdoor_preview', handler: (ctx) => previewPage(ctx, CONFIGS.outdoor) },
  { methods: ['POST'], path: '/admin/motorcycle_delete', handler: (ctx) => deleteSubmit(ctx, CONFIGS.motorcycle) },
  { methods: ['POST'], path: '/admin/outdoor_delete', handler: (ctx) => deleteSubmit(ctx, CONFIGS.outdoor) }
];

export { configFromPath };
