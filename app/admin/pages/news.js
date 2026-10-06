// 笔记管理: 列表(搜索/筛选/批量) / 行片段 / 发布编辑 / 预览 / 软删除 / 复制 / 回收站 / 恢复 / 彻底删除
// 逐条对齐旧站 fastapi/app/admin/news_admin.py + news_edit.py + news_recycle.py
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { assetUrl, mediaBase } from '../../core/media_scheme.js';
import { sanitizeHtml } from '../../core/sanitize.js';
import { MEDIA_PREFIXES } from '../../core/storage.js';
import { beijingNow } from '../../core/timeutil.js';
import { adminLayout } from '../lib/layout.js';
import { optionsForSelect } from '../lib/categorySource.js';
import { imagesForStorage, plainDesc, videoForBrowser, videoForEditor, videoForStorage } from '../lib/newsContent.js';
import {
  editShell, emptyRow, imageUploadField, imageUploadModal, listShell, mediaLibraryModal,
  pagerScript, selectField, switchField, textareaField, textField
} from '../lib/partials.js';
import { statusActions, statusBadgeClass, statusKind, statusLabel } from '../lib/status.js';
import {
  PER_PAGE, auditLog, buildListUrl, clampPage, datetimeLocalValue, firstScreenLimit, idemKey,
  invalidateEntityCache, isDuplicateSubmit, intOr, normalizeDatetime, nowLocalMinute, strOf
} from '../lib/utils.js';

const MANAGE_URL = '/admin/news_manage';
const RECYCLE_URL = '/admin/news_recycle';
const RECYCLE_LIMIT = 100;
const RECYCLE_RETENTION_DAYS = 30;
const BATCH_MAX = 200;

// 列表只取展示真正用到的列: 别把每行 20KB 的正文也拉回来(旧站为此改过一版)
const LIST_COLUMNS = 'id, title, "desc", category, image, publish_time, status, type, view_count, likes, favorites';
const RECYCLE_COLUMNS = 'id, title, category, image, status, type, publish_time, deleted_at';
// 首列是批量操作的"全选"复选框: 走 listShell 的 { html: true } 列, 否则会被转义成源码文本
const COLUMNS = [
  { label: '<input type="checkbox" id="rowCheckAll" aria-label="全选">', html: true },
  'ID', '标题', '分类', '封面', '状态', '浏览/点赞/收藏', '发布时间', '操作'
];
const RECYCLE_COLUMNS_HEAD = ['ID', '封面', '标题', '来源', '分类', '删除时间', '操作'];

function listWhere(query) {
  const clauses = ["type = 'admin_users'", 'deleted_at IS NULL'];
  const args = [];
  const category = strOf(query.category);
  if (category && category !== 'all') {
    clauses.push('category = ?');
    args.push(category);
  }
  const status = strOf(query.status);
  if (status && status !== 'all') {
    clauses.push('status = ?');
    args.push(status);
  }
  const keyword = strOf(query.keyword);
  if (keyword) {
    clauses.push('(title LIKE ? OR "desc" LIKE ?)');
    args.push(`%${keyword}%`, `%${keyword}%`);
  }
  return { sql: ` WHERE ${clauses.join(' AND ')}`, args };
}

function statusCell(row) {
  const kind = statusKind('news');
  return `<span class="badge text-bg-${statusBadgeClass(kind, row.status)}" data-status-badge>${escapeHtml(statusLabel(kind, row.status))}</span>`;
}

function actionsCell(ctx, row) {
  const kind = statusKind('news');
  const page = clampPage(ctx.query.page, null);
  const buttons = statusActions(kind, row.status).map((action) => `<button type="button" class="btn btn-sm btn-${action.btnClass}"`
    + ` data-status-kind="${kind.key}" data-status-id="${row.id}" data-status-action="${escapeHtml(action.value)}"`
    + `${action.visible ? '' : ' hidden'}>${escapeHtml(action.label)}</button>`).join('');
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="/admin/news_edit?id=${row.id}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    <a class="btn btn-sm btn-outline-secondary" href="/admin/news_preview?id=${row.id}" target="_blank" rel="noopener"><i class="bi bi-eye" aria-hidden="true"></i> 预览</a>
    <form method="post" action="/admin/news_copy" class="d-inline">
      <input type="hidden" name="id" value="${row.id}">
      <input type="hidden" name="page" value="${page}">
      <button class="btn btn-sm btn-outline-secondary" type="submit" onclick="return confirm('复制该笔记为待审核副本？')"><i class="bi bi-copy" aria-hidden="true"></i> 复制</button>
    </form>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=news_row&amp;id=${row.id}&amp;page=${page}&amp;back=${encodeURIComponent(MANAGE_URL)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

function renderRows(ctx, rows) {
  if (!rows || !rows.length) return emptyRow(COLUMNS, '没有符合条件的笔记');
  return rows.map((row) => {
    const image = strOf(row.image);
    const cover = image
      ? `<img src="${escapeHtml(assetUrl(ctx.env, image, ''))}" class="cover-thumb" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`
      : '-';
    const subtitle = strOf(row.desc)
      ? `<div class="small text-muted text-truncate" title="${escapeHtml(strOf(row.desc))}">${escapeHtml(strOf(row.desc))}</div>` : '';
    return `<tr>
  <td><input type="checkbox" class="form-check-input rowCheck" value="${row.id}" aria-label="选择笔记 ${row.id}"></td>
  <td class="text-nowrap">${row.id}</td>
  <td>
    <a href="/admin/news_preview?id=${row.id}" target="_blank" rel="noopener">${escapeHtml(strOf(row.title) || '(无标题)')}</a>
    ${subtitle}
  </td>
  <td class="text-nowrap">${escapeHtml(strOf(row.category) || '-')}</td>
  <td>${cover}</td>
  <td class="text-nowrap">${statusCell(row)}</td>
  <td class="text-nowrap small">${intOr(row.view_count, 0)} / ${intOr(row.likes, 0)} / ${intOr(row.favorites, 0)}</td>
  <td class="text-nowrap small">${escapeHtml(strOf(row.publish_time).slice(0, 16))}</td>
  <td class="text-nowrap">${actionsCell(ctx, row)}</td>
</tr>`;
  }).join('');
}

// 批量区: 勾选后按 action 提交(approve/pending/delete), 同时把筛选与页码带回
function batchBar(ctx) {
  const query = ctx.query;
  return `<form method="post" action="/admin/news_batch_action" id="batchForm" class="d-flex flex-wrap align-items-center gap-2 mb-3 border rounded p-2">
  <input type="hidden" name="ids" id="batchIds">
  <input type="hidden" name="action" id="batchAction">
  <input type="hidden" name="category" value="${escapeHtml(strOf(query.category) || 'all')}">
  <input type="hidden" name="status" value="${escapeHtml(strOf(query.status) || 'all')}">
  <input type="hidden" name="keyword" value="${escapeHtml(strOf(query.keyword))}">
  <input type="hidden" name="page" value="${clampPage(query.page, null)}">
  <span class="small text-muted">批量操作</span>
  <button class="btn btn-sm btn-outline-success" type="button" data-batch="approve">设为显示</button>
  <button class="btn btn-sm btn-outline-warning" type="button" data-batch="pending">设为待审核</button>
  <button class="btn btn-sm btn-outline-danger" type="button" data-batch="delete">移入回收站</button>
</form>`;
}

const BATCH_SCRIPT = `<script>
  (function () {
    var form = document.getElementById('batchForm');
    if (!form) return;
    var all = document.getElementById('rowCheckAll');
    if (all) {
      all.addEventListener('change', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.rowCheck'), function (box) { box.checked = all.checked; });
      });
    }
    function selected() {
      return Array.prototype.filter.call(document.querySelectorAll('.rowCheck'), function (box) { return box.checked; });
    }
    Array.prototype.forEach.call(form.querySelectorAll('[data-batch]'), function (btn) {
      btn.addEventListener('click', function () {
        var boxes = selected();
        if (!boxes.length) { alert('请先勾选要操作的笔记'); return; }
        var action = btn.getAttribute('data-batch');
        if (action === 'delete' && !confirm('确定删除选中的 ' + boxes.length + ' 条笔记？')) return;
        document.getElementById('batchIds').value = boxes.map(function (box) { return box.value; }).join(',');
        document.getElementById('batchAction').value = action;
        form.submit();
      });
    });
  })();
</script>`;

async function managePage(ctx) {
  const where = listWhere(ctx.query);
  let total = 0;
  let totalPages = 1;
  let page = 1;
  let rows = [];
  let error = '';
  try {
    total = intOr((await one(ctx.env, `SELECT COUNT(*) AS total FROM news${where.sql}`, ...where.args)).total, 0);
    totalPages = Math.max(Math.ceil(total / PER_PAGE), 1);
    const limited = firstScreenLimit(ctx.query.page, PER_PAGE, totalPages);
    page = limited[0];
    rows = await all(ctx.env,
      `SELECT ${LIST_COLUMNS} FROM news${where.sql} ORDER BY publish_time DESC, id DESC LIMIT ?`,
      ...where.args, limited[1]);
  } catch (err) {
    // 查询失败要明说: 渲染成"暂无数据"会让运营以为数据被删了
    console.error('获取笔记列表失败', err && err.message);
    rows = [];
    error = '读取数据失败，请稍后重试';
  }
  const categoryOptions = await optionsForSelect(ctx.env, strOf(ctx.query.category));
  const categoryForm = `<form class="d-flex flex-wrap gap-2" method="get" action="${MANAGE_URL}">
    <select class="form-select form-select-sm" name="category" style="max-width:180px">
      <option value="all">全部分类</option>
      ${categoryOptions.map(([value, label]) => `<option value="${escapeHtml(value)}"${strOf(ctx.query.category) === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
    </select>
    <select class="form-select form-select-sm" name="status" style="max-width:130px">
      ${[['all', '全部状态'], ['approved', '显示'], ['pending', '待审核'], ['rejected', '已拒绝']].map(([value, label]) =>
    `<option value="${value}"${strOf(ctx.query.status) === value ? ' selected' : ''}>${label}</option>`).join('')}
    </select>
    <input type="search" class="form-control form-control-sm" name="keyword" value="${escapeHtml(strOf(ctx.query.keyword))}" placeholder="搜索标题/摘要" style="max-width:200px">
    <button class="btn btn-sm btn-outline-secondary" type="submit"><i class="bi bi-search" aria-hidden="true"></i> 搜索</button>
  </form>`;
  const query = new URLSearchParams(ctx.query).toString();
  const content = batchBar(ctx) + listShell({
    title: '笔记', columns: COLUMNS, rows: renderRows(ctx, rows),
    actions: `<a class="btn btn-primary" href="/admin/news_edit?id=0"><i aria-hidden="true" class="bi bi-plus-lg"></i> 发布笔记</a>`
      + `<a class="btn btn-outline-secondary" href="${RECYCLE_URL}"><i class="bi bi-trash3" aria-hidden="true"></i> 回收站</a>${categoryForm}`,
    tbodyId: 'newsTbody', sentinelId: 'newsLoadMore', textId: 'newsLoadMoreText',
    hintId: 'newsLoadedHint', total, perPage: PER_PAGE, currentPage: page, totalPages,
    unit: '条', backTopId: 'newsBackTopBtn', jumpBtnId: 'newsJumpBtn', jumpInputId: 'newsJumpInput'
  });
  return adminLayout({
    title: '笔记管理', currentPage: 'news_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content,
    scripts: pagerScript({
      tbodyId: 'newsTbody', sentinelId: 'newsLoadMore', textId: 'newsLoadMoreText',
      rowsUrl: `/admin/news_manage_rows${query ? `?${query}` : ''}`, currentPage: page, totalPages,
      total, perPage: PER_PAGE, unit: '条', hintId: 'newsLoadedHint', announceLabel: '笔记',
      baseUrl: MANAGE_URL, backTopId: 'newsBackTopBtn', jumpBtnId: 'newsJumpBtn',
      jumpInputId: 'newsJumpInput', rowMarker: 'rowCheck', version: ctx.version
    }) + BATCH_SCRIPT
  });
}

async function rowsFragment(ctx) {
  const where = listWhere(ctx.query);
  const page = clampPage(ctx.query.page, null);
  let rows = [];
  try {
    rows = await all(ctx.env,
      `SELECT ${LIST_COLUMNS} FROM news${where.sql} ORDER BY publish_time DESC, id DESC LIMIT ? OFFSET ?`,
      ...where.args, PER_PAGE + 1, (page - 1) * PER_PAGE);
  } catch (err) {
    console.error('获取笔记分页数据失败', err && err.message);
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

// 预览: 只读, 不给前台浏览量 +1; 正文转成浏览器形态(图片绝对化 + wx-video → video)
async function previewPage(ctx) {
  const newsId = intOr(ctx.query.id, 0);
  const fail = (message) => adminLayout({
    title: '笔记预览', currentPage: 'news_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error: message,
    content: `<div class="card"><div class="card-body">${escapeHtml(message)}</div></div>`
  });
  if (newsId <= 0) return fail('缺少笔记ID');
  const row = await one(ctx.env, 'SELECT * FROM news WHERE id = ?', newsId).catch(() => null);
  if (!row) return fail('新闻不存在');

  const base = mediaBase(ctx.env);
  const body = videoForBrowser(sanitizeHtml(strOf(row.content)), base)
    .replace(/(<img[^>]+src=["'])([^"']+)(["'])/gi, (whole, head, src, tail) => head + assetUrl(ctx.env, src, '') + tail);
  const content = `<div class="card"><div class="card-body">
  <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
    <span class="badge text-bg-${statusBadgeClass(statusKind('news'), row.status)}">${escapeHtml(statusLabel(statusKind('news'), row.status))}</span>
    <span class="badge text-bg-secondary">${escapeHtml(strOf(row.category) || '-')}</span>
    <span class="small text-muted">发布时间 ${escapeHtml(strOf(row.publish_time).slice(0, 16))}</span>
  </div>
  <h4>${escapeHtml(strOf(row.title))}</h4>
  ${row.image ? `<img src="${escapeHtml(assetUrl(ctx.env, row.image, ''))}" class="img-fluid mb-3" alt="" onerror="this.style.display='none'">` : ''}
  <div class="news-preview-body">${body}</div>
  <div class="mt-3">
    <a class="btn btn-outline-primary btn-sm" href="/admin/news_edit?id=${row.id}">返回编辑</a>
    <a class="btn btn-outline-secondary btn-sm" href="${MANAGE_URL}">返回列表</a>
  </div>
</div></div>`;
  return adminLayout({
    title: '笔记预览', currentPage: 'news_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, content
  });
}

// 编辑: 正文先做视频转换再净化(顺序不能反 —— 净化会剥掉编辑器视频的外层容器, 先净化就认不出来了)
async function editPage(ctx) {
  const newsId = intOr(ctx.query.id, 0);
  const isNew = newsId <= 0;
  let error = ctx.error || '';
  let errorField = '';
  let row;

  if (isNew) {
    row = {
      id: 0, title: '', desc: '', content: '', category: '', image: '', video_url: '',
      status: 'pending', publish_time: nowLocalMinute(), activity_time: ''
    };
  } else {
    row = await one(ctx.env, "SELECT * FROM news WHERE id = ? AND type='admin_users' AND deleted_at IS NULL", newsId)
      .catch(() => null);
    if (!row) {
      return editView(ctx, {
        isNew: false, row: null, error: '找不到指定的笔记(仅可编辑官方发布的笔记)', errorField: '', options: []
      });
    }
  }
  const options = await optionsForSelect(ctx.env, row.category);
  if (!row.category && options.length) row.category = options[0][0];

  if (ctx.method === 'POST') {
    const form = ctx.form;
    const title = strOf(form.title);
    const category = strOf(form.category);
    const image = strOf(form.image);
    const content = strOf(form.content);
    const videoUrl = strOf(form.video_url);
    const status = form.status ? 'approved' : 'pending';
    const publishTime = normalizeDatetime(form.publish_time) || beijingNow();
    const activityTime = strOf(form.activity_time);
    row = Object.assign({}, row, { title, category, image, content, video_url: videoUrl, status, publish_time: publishTime, activity_time: activityTime });

    const missing = [];
    if (!title) missing.push('标题');
    if (!category) missing.push('分类');
    if (!image) missing.push('封面图');
    if (!content) missing.push('正文内容');
    if (missing.length) {
      error = `请填写必填项: ${missing.join('、')}`;
      errorField = !title ? 'title' : (!category ? 'category' : (!image ? 'image' : 'content'));
    } else if (!options.some(([value]) => value === category)) {
      error = '分类无效：请从下拉框中选择「分类管理」里已登记的分类';
      errorField = 'category';
    }

    if (!error) {
      // 入库形态: 视频还原成 <wx-video> 且地址转相对; 图片地址也转相对(库内只存相对路径)
      const stored = imagesForStorage(videoForStorage(sanitizeHtml(content)));
      // 摘要留空则自动截取正文
      const desc = strOf(form.desc) || plainDesc(stored);
      try {
        if (isNew) {
          await run(ctx.env,
            "INSERT INTO news (title, \"desc\", content, category, image, video_url, type, status, publish_time, activity_time) "
            + "VALUES (?,?,?,?,?,?,'admin_users',?,?,?)",
            title, desc, stored, category, image, videoUrl, status, publishTime, activityTime);
        } else {
          await run(ctx.env,
            'UPDATE news SET title=?, "desc"=?, content=?, category=?, image=?, video_url=?, status=?, publish_time=?, activity_time=? '
            + "WHERE id=? AND type='admin_users'",
            title, desc, stored, category, image, videoUrl, status, publishTime, activityTime, newsId);
        }
        invalidateEntityCache('news');
        auditLog(`admin.news.${isNew ? 'create' : 'update'}`, { user: ctx.session.username, news_id: newsId, title });
        return redirect(buildListUrl(MANAGE_URL, { message: isNew ? '笔记发布成功' : '笔记更新成功' }));
      } catch (err) {
        console.error(`保存笔记失败 id=${newsId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }
  return editView(ctx, { isNew, row, error, errorField, options });
}

function editView(ctx, { isNew, row, error, errorField, options }) {
  if (!row) {
    return adminLayout({
      title: '编辑笔记', currentPage: 'news_manage', admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error,
      content: `<div class="card"><div class="card-body">${escapeHtml(error || '找不到指定的笔记')}</div></div>`
    });
  }
  // 回显: 视频转成编辑器认识的 <video>(根路径), 否则打开编辑页看不到视频、一保存就丢
  const contentValue = videoForEditor(strOf(row.content));
  const main = textField({ name: 'title', label: '标题', value: row.title, required: true, errorField })
    + `<div class="row g-3">
      <div class="col-md-6">${imageUploadField({
      env: ctx.env, name: 'image', label: '封面图 URL', value: row.image, required: true,
      mediaPicker: true, errorField, hint: '封面建议使用 16:9 横版图片（如 1280×720）。'
    })}</div>
      <div class="col-md-6">${imageUploadField({
      env: ctx.env, name: 'video_url', label: '视频地址(可选)显示在正文之前', value: row.video_url,
      mediaKind: 'video', mediaPicker: true, errorField,
      hint: '填站内相对路径（如 video/video_x.mp4），或点右侧上传/从视频素材库选。'
    })}</div>
    </div>`
    + textareaField({
      name: 'desc', label: '摘要 / 描述 (留空则自动截取正文)', value: row.desc, rows: 3, errorField
    })
    + `<div class="mb-3">
      <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-1">
        <label class="form-label mb-0" for="contentRaw">正文内容 <span class="text-danger">*</span></label>
        <div class="d-flex flex-wrap gap-2">
          <button type="button" class="btn btn-outline-secondary" data-bs-toggle="modal" data-bs-target="#editorUploadModal">
            <i class="bi bi-cloud-arrow-up" aria-hidden="true"></i> 本地上传</button>
          <button type="button" class="btn btn-outline-secondary" data-bs-toggle="modal" data-bs-target="#mediaLibraryModal"
                  data-media-mode="editor" data-media-kind="image" data-media-lock-kind="1">
            <i class="bi bi-images" aria-hidden="true"></i> 图片素材库</button>
          <button type="button" class="btn btn-outline-secondary" data-bs-toggle="modal" data-bs-target="#mediaLibraryModal"
                  data-media-mode="editor" data-media-kind="video" data-media-lock-kind="1">
            <i class="bi bi-film" aria-hidden="true"></i> 视频素材库</button>
        </div>
      </div>
      <div class="mp-frame">
        <div id="contentToolbar" class="border rounded-top bg-light"></div>
        <div id="contentEditor" class="rich-editor border border-top-0 rounded-bottom${errorField === 'content' ? ' border-danger' : ''}"
             data-media-prefixes="${escapeHtml(MEDIA_PREFIXES.join(','))}"${errorField === 'content' ? ' tabindex="-1" data-invalid="1"' : ''}></div>
      </div>
      <textarea id="contentRaw" name="content" class="form-control font-monospace d-none" rows="16" aria-required="true">${escapeHtml(contentValue)}</textarea>
      <div class="form-text" data-hint-mobile-hidden>
        富文本所见即所得，插图三种方式结果一致：① 上方<b>「本地上传」</b>（图片与视频都能选，传完插到正文光标处）；
        ② <b>「图片素材库」/「视频素材库」</b>（点选后插到光标处）；③ 工具栏「图片 → 上传图片」「视频 → 上传视频」。<br>
        图片以 <code>&lt;img src="image/…"&gt;</code> 入库、视频以小程序标签 <code>&lt;wx-video&gt;</code> 入库
        （编辑页在"浏览器能播"与"小程序存储格式"之间自动转换，打开能看、保存不丢）。视频支持 mp4 / mov / m4v / webm，网页上传上限 64MB；
        更大的视频可先传到素材目录再用「视频素材库」选。<br>
        编辑器资源若未能加载，页面会退回普通文本域并给出提示（不阻塞编辑保存）。
      </div>
    </div>`;
  const side = selectField({
    name: 'category', label: '分类', options: options.length ? options : [['', '（还没有可用分类）']],
    value: row.category, required: true, errorField
  }) + textField({
    name: 'publish_time', label: '发布时间', value: datetimeLocalValue(row.publish_time), errorField,
    placeholder: 'YYYY-MM-DD HH:MM'
  }) + textField({
    name: 'activity_time', label: '活动时间(可选)', value: row.activity_time, errorField
  }) + switchField({
    name: 'status', label: '立即显示 (不勾选则为待审核)', checked: strOf(row.status) === 'approved'
  });
  const content = editShell({
    action: `/admin/news_edit${isNew ? '' : `?id=${row.id}`}`,
    main, side, backUrl: MANAGE_URL, backLabel: '返回列表',
    primaryLabel: isNew ? '发布笔记' : '保存修改'
  }) + imageUploadModal({ name: 'image', purpose: 'cover' })
    + imageUploadModal({ name: 'video_url', purpose: 'video', kind: 'video' })
    // 正文「本地上传」: 图片与视频都收(kind=mixed), 传完由组件回调 MediaInsertFromUpload 插到光标处
    + imageUploadModal({ name: 'editor', purpose: 'content', kind: 'mixed', insert: 'editor', title: '上传图片或视频到正文' })
    + mediaLibraryModal();
  return adminLayout({
    title: '编辑笔记', currentPage: 'news_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error, content,
    // 编辑器只在编辑页加载: 样式 → 编辑器本体 → 本页的初始化脚本(顺序不能乱)
    scripts: [
      `<link rel="stylesheet" href="/admin/static/vendor/wangeditor/style.css?v=${encodeURIComponent(String(ctx.version || ''))}">`,
      `<script src="/admin/static/vendor/wangeditor/index.js?v=${encodeURIComponent(String(ctx.version || ''))}"></script>`,
      `<script src="/admin/static/js/news_editor.js?v=${encodeURIComponent(String(ctx.version || ''))}"></script>`
    ].join('\n')
  });
}

// 软删除: 标记 deleted_at 进回收站(可恢复), 子表数据与素材都保留
async function deleteSubmit(ctx) {
  const rawId = strOf(ctx.form.id);
  const page = strOf(ctx.form.page) || null;
  if (!/^\d+$/.test(rawId.replace('-', ''))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '无效的请求', page }));
  }
  if (await isDuplicateSubmit(ctx.env, idemKey('news_delete', String(ctx.session.id || '-'), rawId))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '该删除刚刚已执行，请勿重复提交', page }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, "SELECT title FROM news WHERE id=? AND type='admin_users' AND deleted_at IS NULL", intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到指定的官方笔记', page }));
    await run(ctx.env, "UPDATE news SET deleted_at=? WHERE id=? AND type='admin_users' AND deleted_at IS NULL",
      beijingNow(), intOr(rawId, 0));
    invalidateEntityCache('news');
    auditLog('admin.news.delete', { user: ctx.session.username, news_id: intOr(rawId, 0), title: row.title || '' });
    message = `笔记 "${strOf(row.title)}" 已移入回收站(ID：${intOr(rawId, 0)})，可在「笔记管理 → 回收站」恢复`;
  } catch (err) {
    console.error(`删除笔记失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试', page }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, page }));
}

// 复制: 新副本一律待审核; 活动时间的 YYYY/MM/DD 归一成 YYYY-MM-DD
async function copySubmit(ctx) {
  const rawId = strOf(ctx.form.id);
  const page = strOf(ctx.form.page) || null;
  if (!/^\d+$/.test(rawId.replace('-', ''))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '缺少有效的笔记ID参数', page }));
  }
  if (await isDuplicateSubmit(ctx.env, idemKey('news_copy', String(ctx.session.id || '-'), rawId))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '该操作刚刚已执行，请勿重复提交', page }));
  }
  let message = '';
  try {
    const original = await one(ctx.env, "SELECT * FROM news WHERE id=? AND type='admin_users'", intOr(rawId, 0));
    if (!original) return redirect(buildListUrl(MANAGE_URL, { error: '找不到指定的官方笔记', page }));
    const activity = strOf(original.activity_time).replace(/\//g, '-');
    const result = await run(ctx.env,
      'INSERT INTO news (title, "desc", content, image, category, video_url, activity_time, publish_time, status, type) '
      + "VALUES (?,?,?,?,?,?,?,?, 'pending', 'admin_users')",
      `${strOf(original.title)} (副本)`, strOf(original.desc), strOf(original.content), original.image,
      original.category, original.video_url, activity, beijingNow());
    const newId = (result && result.meta && result.meta.last_row_id) || 0;
    invalidateEntityCache('news');
    auditLog('admin.news.copy', { user: ctx.session.username, news_id: intOr(rawId, 0), new_id: newId });
    message = `笔记已成功复制！新ID: ${newId}`;
  } catch (err) {
    console.error(`复制笔记失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '复制失败，请稍后重试', page }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, page }));
}

// 批量: 只作用于官方笔记, 单次最多 200 条(防超大 IN 子句)
async function batchSubmit(ctx) {
  const form = ctx.form;
  const filters = { category: strOf(form.category), status: strOf(form.status), keyword: strOf(form.keyword) };
  const page = strOf(form.page) || null;
  const action = strOf(form.action);
  const ids = strOf(form.ids).split(',').map((item) => intOr(item.trim(), 0)).filter((id) => id > 0).slice(0, BATCH_MAX);
  if (!ids.length) return redirect(buildListUrl(MANAGE_URL, { error: '参数错误', filters, page }));
  if (!['approve', 'pending', 'delete'].includes(action)) {
    return redirect(buildListUrl(MANAGE_URL, { error: '不支持的操作类型', filters, page }));
  }
  if (await isDuplicateSubmit(ctx.env, idemKey('news_batch', String(ctx.session.id || '-'), action, ids.join(',')))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '该操作刚刚已执行，请勿重复提交', filters, page }));
  }
  let message = '';
  try {
    const marks = ids.map(() => '?').join(',');
    const found = await all(ctx.env,
      `SELECT id FROM news WHERE id IN (${marks}) AND type='admin_users' AND deleted_at IS NULL`, ...ids);
    const valid = found.map((item) => intOr(item.id, 0));
    if (!valid.length) return redirect(buildListUrl(MANAGE_URL, { error: '没有可操作的笔记', filters, page }));
    const validMarks = valid.map(() => '?').join(',');
    if (action === 'delete') {
      await run(ctx.env, `UPDATE news SET deleted_at=? WHERE id IN (${validMarks})`, beijingNow(), ...valid);
    } else {
      await run(ctx.env, `UPDATE news SET status=? WHERE id IN (${validMarks})`, action === 'approve' ? 'approved' : 'pending', ...valid);
    }
    invalidateEntityCache('news');
    auditLog('admin.news.batch', { user: ctx.session.username, action, count: valid.length, ids: valid.join(',') });
    const label = statusLabel(statusKind('news'), action === 'approve' ? 'approved' : 'pending');
    message = action === 'delete'
      ? `已成功将 ${valid.length} 条官方笔记移入回收站`
      : `已成功将 ${valid.length} 条官方笔记设为${label}状态`;
  } catch (err) {
    console.error(`批量操作失败 action=${action}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '操作失败，请稍后重试', filters, page }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, filters, page }));
}

// 到期自动清理: 访问回收站时把超过保留期的记录连带子表一起清掉(可用 ?purge=0 关闭)
async function purgeExpired(env) {
  const cutoff = new Date(Date.now() - RECYCLE_RETENTION_DAYS * 24 * 3600 * 1000);
  const cutoffText = new Date(cutoff.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const expired = await all(env, 'SELECT id FROM news WHERE deleted_at IS NOT NULL AND deleted_at < ?', cutoffText)
    .catch(() => []);
  const ids = expired.map((item) => intOr(item.id, 0)).filter((id) => id > 0);
  if (!ids.length) return 0;
  await cleanupNews(env, ids);
  invalidateEntityCache('news');
  return ids.length;
}

// 彻底删除时连带清子表: 与对外接口/用户彻底删除同一份表清单(全库无外键, 必须应用层级联)
async function cleanupNews(env, ids) {
  const marks = ids.map(() => '?').join(',');
  const statements = [];
  for (const table of ['news_likes', 'news_favorites', 'news_view_history', 'news_shares', 'news_comments']) {
    statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE news_id IN (${marks})`).bind(...ids));
  }
  statements.push(env.DB.prepare(`DELETE FROM news WHERE id IN (${marks})`).bind(...ids));
  await env.DB.batch(statements);
}

async function recyclePage(ctx) {
  const source = strOf(ctx.query.source);
  const keyword = strOf(ctx.query.keyword);
  const clauses = ['deleted_at IS NOT NULL'];
  const args = [];
  if (source === 'admin') clauses.push("type = 'admin_users'");
  if (source === 'users') clauses.push("type = 'users'");
  if (keyword) {
    clauses.push('title LIKE ?');
    args.push(`%${keyword}%`);
  }
  let rows = [];
  let total = 0;
  let error = '';
  let purged = 0;
  if (strOf(ctx.query.purge) !== '0') {
    purged = await purgeExpired(ctx.env).catch(() => 0);
  }
  try {
    const where = ` WHERE ${clauses.join(' AND ')}`;
    total = intOr((await one(ctx.env, `SELECT COUNT(*) AS total FROM news${where}`, ...args)).total, 0);
    rows = await all(ctx.env, `SELECT ${RECYCLE_COLUMNS} FROM news${where} ORDER BY deleted_at DESC, id DESC LIMIT ?`,
      ...args, RECYCLE_LIMIT);
  } catch (err) {
    console.error('获取回收站失败', err && err.message);
    rows = [];
    error = '读取数据失败，请稍后重试';
  }
  const rendered = rows.length ? rows.map((row) => {
    const image = strOf(row.image);
    const cover = image
      ? `<img src="${escapeHtml(assetUrl(ctx.env, image, ''))}" class="cover-thumb" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '-';
    const sourceBadge = strOf(row.type) === 'users'
      ? '<span class="badge text-bg-info">用户笔记</span>'
      : '<span class="badge text-bg-secondary">官方笔记</span>';
    return `<tr>
  <td class="text-nowrap">${row.id}</td>
  <td>${cover}</td>
  <td>${escapeHtml(strOf(row.title) || '-')}</td>
  <td class="text-nowrap">${sourceBadge}</td>
  <td class="text-nowrap">${escapeHtml(strOf(row.category) || '-')}</td>
  <td class="text-nowrap small">${escapeHtml(strOf(row.deleted_at).slice(0, 16))}</td>
  <td class="text-nowrap">
    <div class="action-cell justify-content-center">
      <form method="post" action="/admin/news_restore" class="d-inline">
        <input type="hidden" name="id" value="${row.id}">
        <input type="hidden" name="source" value="${escapeHtml(source)}">
        <input type="hidden" name="keyword" value="${escapeHtml(keyword)}">
        <button class="btn btn-sm btn-outline-success" type="submit"><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i> 恢复</button>
      </form>
      <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=news&amp;id=${row.id}">
        <i class="bi bi-trash" aria-hidden="true"></i> 彻底删除</a>
    </div>
  </td>
</tr>`;
  }).join('') : emptyRow(RECYCLE_COLUMNS_HEAD, '回收站是空的');
  const filterForm = `<form class="d-flex flex-wrap gap-2" method="get" action="${RECYCLE_URL}">
    <select class="form-select form-select-sm" name="source" style="max-width:150px">
      ${[['all', '全部来源'], ['admin', '官方笔记'], ['users', '用户笔记']].map(([value, label]) =>
    `<option value="${value}"${source === value ? ' selected' : ''}>${label}</option>`).join('')}
    </select>
    <input type="search" class="form-control form-control-sm" name="keyword" value="${escapeHtml(keyword)}" placeholder="搜索标题" style="max-width:200px">
    <button class="btn btn-sm btn-outline-secondary" type="submit"><i class="bi bi-search" aria-hidden="true"></i> 筛选</button>
  </form>`;
  const content = `<div class="card"><div class="card-body">
  <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
    <a class="btn btn-outline-secondary" href="${MANAGE_URL}"><i class="bi bi-arrow-left" aria-hidden="true"></i> 返回笔记管理</a>
    ${filterForm}
    <span class="ms-auto text-end text-muted small">共 ${total} 条${total > rows.length ? `（仅显示最近 ${RECYCLE_LIMIT} 条）` : ''}
      · 超过 ${RECYCLE_RETENTION_DAYS} 天会被自动清理</span>
  </div>
  <div class="table-responsive">
    <table aria-label="回收站" class="table table-hover align-middle text-center">
      <thead class="table-light"><tr>${RECYCLE_COLUMNS_HEAD.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${rendered}</tbody>
    </table>
  </div>
</div></div>`;
  const purgeMessage = purged ? `已自动清理 ${purged} 条超过 ${RECYCLE_RETENTION_DAYS} 天的记录` : '';
  return adminLayout({
    title: '笔记回收站', currentPage: 'news_recycle', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: [purgeMessage, ctx.message].filter(Boolean).join('；'), error: error || ctx.error, content
  });
}

async function restoreSubmit(ctx) {
  const rawId = strOf(ctx.form.id);
  const filters = { source: strOf(ctx.form.source), keyword: strOf(ctx.form.keyword) };
  if (!/^\d+$/.test(rawId.replace('-', ''))) {
    return redirect(buildListUrl(RECYCLE_URL, { error: '参数错误', filters }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, 'SELECT title FROM news WHERE id=? AND deleted_at IS NOT NULL', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(RECYCLE_URL, { error: '回收站中找不到该笔记', filters }));
    await run(ctx.env, 'UPDATE news SET deleted_at=NULL WHERE id=?', intOr(rawId, 0));
    invalidateEntityCache('news');
    auditLog('admin.news.restore', { user: ctx.session.username, news_id: intOr(rawId, 0) });
    message = `笔记 "${strOf(row.title)}" 已恢复`;
  } catch (err) {
    console.error(`恢复笔记失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(RECYCLE_URL, { error: '恢复失败，请稍后重试', filters }));
  }
  return redirect(buildListUrl(RECYCLE_URL, { message, filters }));
}

async function purgeSubmit(ctx) {
  const rawId = strOf(ctx.form.id);
  if (!/^\d+$/.test(rawId.replace('-', ''))) {
    return redirect(buildListUrl(RECYCLE_URL, { error: '参数错误' }));
  }
  if (await isDuplicateSubmit(ctx.env, idemKey('news_purge', String(ctx.session.id || '-'), rawId))) {
    return redirect(buildListUrl(RECYCLE_URL, { error: '该操作刚刚已执行，请勿重复提交' }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, 'SELECT title FROM news WHERE id=? AND deleted_at IS NOT NULL', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(RECYCLE_URL, { error: '回收站中找不到该笔记' }));
    await cleanupNews(ctx.env, [intOr(rawId, 0)]);
    invalidateEntityCache('news');
    auditLog('admin.news.purge', { user: ctx.session.username, news_id: intOr(rawId, 0) });
    message = `笔记 "${strOf(row.title)}" 已彻底删除`;
  } catch (err) {
    console.error(`彻底删除笔记失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(RECYCLE_URL, { error: '删除失败，请稍后重试' }));
  }
  return redirect(buildListUrl(RECYCLE_URL, { message }));
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['GET', 'HEAD'], path: '/admin/news_manage_rows', handler: rowsFragment },
  { methods: ['GET', 'HEAD'], path: '/admin/news_preview', handler: previewPage },
  { methods: ['GET', 'POST'], path: '/admin/news_edit', handler: editPage },
  { methods: ['POST'], path: '/admin/news_delete', handler: deleteSubmit },
  { methods: ['POST'], path: '/admin/news_copy', handler: copySubmit },
  { methods: ['POST'], path: '/admin/news_batch_action', handler: batchSubmit },
  { methods: ['GET', 'HEAD'], path: RECYCLE_URL, handler: recyclePage },
  { methods: ['POST'], path: '/admin/news_restore', handler: restoreSubmit },
  { methods: ['POST'], path: '/admin/news_purge', handler: purgeSubmit }
];
