// 后台页面"宏"的唯一实现: 结构与 class 逐字对齐旧站 templates/_*.html, 这样 admin.css 才能直接复用
// 这边没有模板引擎, 所以每个宏就是"返回 HTML 字符串的函数"
import { escapeHtml } from '../../core/html.js';
import { assetUrl } from '../../core/media_scheme.js';
import { MEDIA_PREFIXES } from '../../core/storage.js';

export function backButton(url, label = '返回') {
  return `<a class="btn btn-outline-secondary btn-sm" href="${escapeHtml(url)}">`
    + '<i class="bi bi-arrow-left" aria-hidden="true"></i> ' + escapeHtml(label) + '</a>';
}

// 页头: 只有标题 / 带返回按钮 / 右侧再放动作按钮(用 actions 传 HTML)
export function pageHeader(options = {}) {
  const icon = options.icon ? `<i aria-hidden="true" class="bi ${options.icon}"></i> ` : '';
  const right = (options.actions || '') + (options.backUrl ? backButton(options.backUrl, options.backLabel || '返回') : '');
  return `<div class="admin-page-head">
  <h1 class="h5 mb-0">${icon}${escapeHtml(options.title || '')}</h1>
  <div class="d-flex align-items-center gap-2 flex-shrink-0">${right}</div>
</div>`;
}

// 列表统计条: simple=true 时只报总数(受控小表/不需要分页的列表用它)
export function listMeta(options = {}) {
  const total = Number(options.total) || 0;
  const unit = escapeHtml(options.unit || '条');
  const extra = options.extraClass || 'text-muted small';
  if (options.simple) return `<span class="${extra}">共 ${total} ${unit}</span>`;
  const perPage = Number(options.perPage) || total || 1;
  const loadedPage = Number(options.loadedPage) || 1;
  const totalPages = Number(options.totalPages) || 1;
  const loaded = Math.min(loadedPage * perPage, total);
  return `<span class="${extra}">共 ${total} ${unit} · 每页 ${perPage} 条 · `
    + `<span id="${escapeHtml(options.hintId || '')}">已加载 ${loaded}/${total} ${unit} · 第 ${loadedPage}/${totalPages} 页</span></span>`;
}

// 图片/视频素材字段: URL 输入框 + 本地上传按钮 + (可选)素材库按钮 + 图片预览
// 与旧站 _image_upload_field.html 同结构; 预览在图片失效时隐藏, 不占位
export function imageUploadField(options = {}) {
  const env = options.env;
  const name = options.name;
  const kind = options.mediaKind === 'video' ? 'video' : 'image';
  const placeholder = kind === 'video'
    ? '填写本站相对路径（如 video/video_xxx.mp4），或点右侧「本地上传」'
    : '填写图片直链，或点击右侧「本地上传」';
  const invalid = options.errorField === name;
  const input = `<input type="text" class="form-control${invalid ? ' is-invalid' : ''}" name="${escapeHtml(name)}"`
    + ` id="${escapeHtml(name)}FieldUrl" value="${escapeHtml(options.value || '')}"`
    + (options.required ? ' required aria-required="true"' : '')
    + (invalid ? ' aria-invalid="true"' : '')
    + ` placeholder="${escapeHtml(placeholder)}">`;
  const uploadBtn = `<button type="button" class="btn btn-outline-secondary" data-bs-toggle="modal"`
    + ` data-bs-target="#${escapeHtml(name)}UploadModal">`
    + '<i class="bi bi-cloud-arrow-up" aria-hidden="true"></i> 本地上传</button>';
  const picker = options.mediaPicker
    ? `<button type="button" class="btn btn-outline-secondary" data-bs-toggle="modal"`
      + ' data-bs-target="#mediaLibraryModal" data-media-mode="input"'
      + ` data-media-kind="${kind}" data-media-lock-kind="1"`
      + ` data-media-target="#${escapeHtml(name)}FieldUrl"`
      + (kind === 'image' ? ` data-media-preview="#${escapeHtml(name)}FieldPreview"` : '') + '>'
      + `<i class="bi bi-${kind === 'video' ? 'film' : 'images'}" aria-hidden="true"></i>`
      + (kind === 'video' ? ' 视频素材库' : ' 图片素材库') + '</button>'
    : '';
  const preview = kind === 'image'
    ? `<img id="${escapeHtml(name)}FieldPreview" src="${escapeHtml(assetUrl(env, options.value || '', '') || '#')}"`
      + ` class="mt-2 cover-preview${options.value ? '' : ' d-none'}" alt="" onerror="this.classList.add('d-none')">`
    : '';
  const hint = options.hint
    ? `<div class="form-text"${options.hintMobileHidden ? ' data-hint-mobile-hidden' : ''}>${escapeHtml(options.hint)}</div>`
    : '';
  return `<div class="${options.colClass || 'mb-3'}" data-image-upload-field>
  <label class="form-label" for="${escapeHtml(name)}FieldUrl">${escapeHtml(options.label || '')}`
    + `${options.required ? ' <span class="text-danger">*</span>' : ''}</label>
  <div class="input-group">${input}${uploadBtn}${picker}</div>
  ${preview}
  ${hint}
</div>`;
}

// 上传弹窗: 与字段分开渲染(HTML 不允许 form 嵌套 form)
// insert='editor' 时由页面提供 window.MediaInsertFromUpload 把地址插进正文
export function imageUploadModal(options = {}) {
  const name = options.name;
  const kind = options.kind === 'video' ? 'video' : (options.kind === 'mixed' ? 'mixed' : 'image');
  const accept = kind === 'mixed' ? 'image/*,video/*' : (kind === 'video' ? 'video/*' : 'image/*');
  const title = options.title || `上传${kind === 'video' ? '视频' : (kind === 'mixed' ? '图片或视频' : '图片')}到服务器`;
  const target = options.insert ? '' : ` data-target="#${escapeHtml(name)}FieldUrl"`;
  const preview = kind === 'image' ? ` data-preview="#${escapeHtml(name)}FieldPreview"` : '';
  return `<div class="modal fade" id="${escapeHtml(name)}UploadModal" tabindex="-1">
  <div class="modal-dialog"><div class="modal-content">
    <div class="modal-header">
      <h6 class="modal-title">${escapeHtml(title)}</h6>
      <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button>
    </div>
    <div class="modal-body">
      <form data-image-upload data-endpoint="/admin/image_upload" data-purpose="${escapeHtml(options.purpose || 'cover')}"
            data-kind="${kind}"${options.insert ? ` data-insert="${escapeHtml(options.insert)}"` : ''}${target}${preview}
            enctype="multipart/form-data">
        <input type="file" class="form-control" name="file" accept="${accept}" aria-label="选择要上传的文件">
        <button class="btn btn-primary mt-2" type="submit">
          <i class="bi bi-cloud-arrow-up" aria-hidden="true"></i> 上传
        </button>
        <div class="mt-2 d-none" data-upload-progress>
          <div class="progress" role="progressbar" aria-label="上传进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" style="height: 6px;">
            <div class="progress-bar" style="width: 0%;"></div>
          </div>
          <div class="small text-muted mt-1" data-upload-progress-text aria-live="polite"></div>
        </div>
      </form>
      <div class="mt-2 small text-success" data-upload-result role="status" aria-live="polite"></div>
    </div>
  </div></div>
</div>`;
}

// 素材库弹窗: 全后台只有一个(打开它的按钮用 data-media-* 描述行为)
export function mediaLibraryModal() {
  // data-media-prefixes: 素材目录清单下发到前端(手工填路径时判断"写全目录没有"), 真值在 core/storage.js
  return `<div class="modal fade" id="mediaLibraryModal" tabindex="-1" aria-labelledby="mediaLibraryModalLabel"
     data-media-prefixes="${escapeHtml(MEDIA_PREFIXES.join(','))}">
  <div class="modal-dialog modal-lg modal-dialog-scrollable"><div class="modal-content">
    <div class="modal-header">
      <h6 class="modal-title" id="mediaLibraryModalLabel">从素材库选择</h6>
      <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button>
    </div>
    <div class="modal-body">
      <div class="btn-group btn-group-sm w-100 mb-2" id="mediaLibraryKindSwitch" role="group" aria-label="素材分类">
        <button type="button" class="btn btn-outline-primary active" data-media-kind-btn="image">
          <i class="bi bi-image" aria-hidden="true"></i> 图片
        </button>
        <button type="button" class="btn btn-outline-primary" data-media-kind-btn="video">
          <i class="bi bi-film" aria-hidden="true"></i> 视频
        </button>
      </div>
      <div class="input-group mb-2">
        <label class="visually-hidden" for="mediaLibraryQuery">按文件名筛选素材</label>
        <input type="search" class="form-control" id="mediaLibraryQuery" placeholder="按文件名筛选（如 封面、摩旅、news）">
        <button type="button" class="btn btn-outline-secondary" id="mediaLibraryReload">
          <i class="bi bi-arrow-clockwise" aria-hidden="true"></i> 刷新
        </button>
      </div>
      <div class="small text-muted mb-2" id="mediaLibraryHint" role="status" aria-live="polite"></div>
      <div class="list-group" id="mediaLibraryList" style="max-height:52vh;overflow:auto"></div>
      <hr>
      <label class="form-label small" for="mediaLibraryManual">或手工填写素材路径</label>
      <div class="input-group">
        <input type="text" class="form-control" id="mediaLibraryManual" placeholder="image/xxx.png 或 video/xxx.mp4">
        <button type="button" class="btn btn-outline-primary" id="mediaLibraryManualInsert">插入</button>
      </div>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">关闭</button>
    </div>
  </div></div>
</div>`;
}

// 分页列表骨架(与旧站 banner_manage.html 同结构): 顶部按钮 + 统计条 + 表格 + 触底哨兵 + 底部工具栏
export function listShell(options = {}) {
  const columns = (options.columns || []).map((column) => {
    const isObject = column !== null && typeof column === 'object';
    const label = isObject ? column.label : column;
    const className = isObject ? (column.className || '') : '';
    // 默认一律转义; 需要表头放真 HTML(如"全选"复选框)时显式写 { html: true }, 由调用方保证内容安全
    const text = isObject && column.html ? String(label || '') : escapeHtml(label);
    return `<th scope="col"${className ? ` class="${className}"` : ''}>${text}</th>`;
  }).join('');
  const totalPages = Number(options.totalPages) || 1;
  const sentinel = totalPages > 1
    ? `<span id="${escapeHtml(options.textId)}" data-page="${Number(options.currentPage) || 1}"`
      + ` data-total-pages="${totalPages}">`
      + '<i aria-hidden="true" class="bi bi-arrow-down-circle"></i> 滚动到底自动加载更多</span>'
    : `<span class="text-muted">— 已全部加载 ${Number(options.total) || 0} ${escapeHtml(options.unit || '条')} —</span>`;
  return `<div class="card">
  <div class="card-body">
    <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
      ${options.actions || ''}
      <span class="ms-auto text-end">${listMeta({
        total: options.total, perPage: options.perPage, loadedPage: options.currentPage,
        totalPages, unit: options.unit || '条', hintId: options.hintId
      })}</span>
    </div>
    <div class="table-responsive"${options.tableAttrs || ''}>
      <table aria-label="${escapeHtml(options.title || '列表')}列表" class="table table-hover align-middle text-center">
        <thead class="table-light"><tr>${columns}</tr></thead>
        <tbody id="${escapeHtml(options.tbodyId)}">${options.rows || ''}</tbody>
      </table>
    </div>
    <div id="${escapeHtml(options.sentinelId)}" class="text-center text-muted small py-3">${sentinel}</div>
    <div class="d-flex flex-wrap justify-content-center align-items-center gap-2 border-top pt-3">
      <button type="button" class="btn btn-sm btn-outline-secondary" id="${escapeHtml(options.backTopId)}">
        <i aria-hidden="true" class="bi bi-arrow-up-circle"></i> 回到顶部
      </button>
      <div class="d-flex align-items-center gap-1">
        <label class="small text-muted mb-0" for="${escapeHtml(options.jumpInputId)}">跳至</label>
        <input type="number" class="form-control form-control-sm jump-input" id="${escapeHtml(options.jumpInputId)}"
               min="1" max="${totalPages}" value="${Number(options.currentPage) || 1}">
        <span class="small text-muted">/ ${totalPages} 页</span>
        <button type="button" class="btn btn-sm btn-outline-primary" id="${escapeHtml(options.jumpBtnId)}">跳转</button>
      </div>
    </div>
  </div>
</div>`;
}

// 列表页末尾脚本: 同步引入 infinite_scroll.js(它定义 AdminListLoader) + DOMContentLoaded 里 init
export function pagerScript(options = {}) {
  const config = {
    tbodyId: options.tbodyId, sentinelId: options.sentinelId, textId: options.textId,
    rowsUrl: options.rowsUrl, loadedPage: Number(options.currentPage) || 1,
    totalPages: Number(options.totalPages) || 1, total: Number(options.total) || 0,
    perPage: Number(options.perPage) || 10, unit: options.unit || '条',
    hintId: options.hintId, announceLabel: options.announceLabel || '列表',
    pager: {
      backTopId: options.backTopId, jumpBtnId: options.jumpBtnId,
      jumpInputId: options.jumpInputId, baseUrl: options.baseUrl
    }
  };
  if (options.rowMarker) config.rowMarker = options.rowMarker;
  return `<script src="/admin/static/js/infinite_scroll.js?v=${escapeHtml(options.version || '')}"></script>
<script>
  document.addEventListener('DOMContentLoaded', function () {
    AdminListLoader.init(${JSON.stringify(config)});
  });
</script>`;
}

// 空态行: colspan 由列清单推导(与表头同源, 加列时只改一处)
export function emptyRow(columns, text) {
  return `<tr><td colspan="${(columns || []).length}" class="text-center text-muted py-4">${escapeHtml(text)}</td></tr>`;
}

// ---------------------------------------------------------------------------
// 表单字段: 五个编辑页共用(旧站靠 Jinja 模板, 这边收敛成函数, 免得各页拼一遍而漂移)
// errorField 命中时加 is-invalid + aria-invalid —— 与旧站一样"高亮并聚焦出错字段"
// ---------------------------------------------------------------------------
function fieldClass(name, errorField) {
  const bad = errorField && errorField === name;
  return { class: `form-control${bad ? ' is-invalid' : ''}`, aria: bad ? ' aria-invalid="true"' : '' };
}

function labelFor(id, label, required) {
  return `<label class="form-label" for="${escapeHtml(id)}">${escapeHtml(label)}`
    + `${required ? ' <span class="text-danger">*</span>' : ''}</label>`;
}

export function textField(options = {}) {
  const id = options.id || `${options.name}Input`;
  const cls = fieldClass(options.name, options.errorField);
  return `<div class="${options.colClass || 'mb-3'}">
  ${labelFor(id, options.label, options.required)}
  <input type="text" class="${cls.class}" name="${escapeHtml(options.name)}" id="${escapeHtml(id)}"`
    + ` value="${escapeHtml(options.value || '')}"${cls.aria}`
    + `${options.required ? ' required aria-required="true"' : ''}`
    + `${options.maxlength ? ` maxlength="${Number(options.maxlength)}"` : ''}`
    + `${options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : ''}>
  ${options.hint ? `<div class="form-text">${escapeHtml(options.hint)}</div>` : ''}
</div>`;
}

export function textareaField(options = {}) {
  const id = options.id || `${options.name}Textarea`;
  const cls = fieldClass(options.name, options.errorField);
  return `<div class="${options.colClass || 'mb-3'}">
  ${labelFor(id, options.label, options.required)}
  <textarea class="${cls.class}" name="${escapeHtml(options.name)}" id="${escapeHtml(id)}"`
    + ` rows="${Number(options.rows) || 8}"${cls.aria}`
    + `${options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : ''}>${escapeHtml(options.value || '')}</textarea>
  ${options.hint ? `<div class="form-text">${escapeHtml(options.hint)}</div>` : ''}
</div>`;
}

export function selectField(options = {}) {
  const id = options.id || `${options.name}Select`;
  const bad = options.errorField && options.errorField === options.name;
  const items = (options.options || []).map(([value, label]) => {
    const selected = String(value) === String(options.value) ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
  }).join('');
  return `<div class="${options.colClass || 'mb-3'}">
  ${labelFor(id, options.label, options.required)}
  <select class="form-select${bad ? ' is-invalid' : ''}" name="${escapeHtml(options.name)}" id="${escapeHtml(id)}"${bad ? ' aria-invalid="true"' : ''}>${items}</select>
  ${options.hint ? `<div class="form-text">${escapeHtml(options.hint)}</div>` : ''}
</div>`;
}

export function numberField(options = {}) {
  const id = options.id || `${options.name}Input`;
  const cls = fieldClass(options.name, options.errorField);
  return `<div class="${options.colClass || 'mb-3'}">
  ${labelFor(id, options.label, options.required)}
  <input type="number" class="${cls.class}" name="${escapeHtml(options.name)}" id="${escapeHtml(id)}"`
    + ` value="${escapeHtml(String(options.value === undefined ? 0 : options.value))}"${cls.aria}`
    + `${options.hint ? ` aria-describedby="${escapeHtml(id)}Hint"` : ''}>
  ${options.hint ? `<div class="form-text" id="${escapeHtml(id)}Hint">${escapeHtml(options.hint)}</div>` : ''}
</div>`;
}

// 开关(复选框): 与旧站 form-check form-switch 同结构
export function switchField(options = {}) {
  const id = options.id || `${options.name}Switch`;
  return `<div class="form-check form-switch ${options.colClass || 'mb-3'}">
  <input class="form-check-input" type="checkbox" name="${escapeHtml(options.name)}" id="${escapeHtml(id)}"${options.checked ? ' checked' : ''}>
  <label class="form-check-label" for="${escapeHtml(id)}">${escapeHtml(options.label || '')}</label>
</div>`;
}

export function checkboxField(options = {}) {
  const id = options.id || `${options.name}Check`;
  return `<div class="form-check ${options.colClass || 'mb-3'}">
  <input class="form-check-input" type="checkbox" name="${escapeHtml(options.name)}" id="${escapeHtml(id)}"`
    + ` value="${escapeHtml(options.value || '1')}"${options.checked ? ' checked' : ''}>
  <label class="form-check-label" for="${escapeHtml(id)}">${options.labelHtml || escapeHtml(options.label || '')}</label>
</div>`;
}

export function hiddenField(name, value) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value === undefined || value === null ? '' : value)}">`;
}

// 编辑页外壳: 整宽卡片 + 左主区(字段) + 右设置区(保存/返回), 与旧站编辑页同布局
export function editShell(options = {}) {
  return `<div class="card">
  <div class="card-body">
    ${options.top || ''}
    <form method="post" action="${escapeHtml(options.action)}">
      ${options.formNonce ? hiddenField('form_nonce', options.formNonce) : ''}
      <div class="row g-3">
        <div class="col-lg-8">${options.main || ''}</div>
        <div class="col-lg-4">
          <div class="card"><div class="card-body">
            <div class="form-label">${escapeHtml(options.sideTitle || '发布设置')}</div>
            ${options.side || ''}
            <div class="d-grid gap-2">
              <button class="btn btn-primary" type="submit"><i class="bi bi-check-lg" aria-hidden="true"></i> ${escapeHtml(options.primaryLabel || '保存')}</button>
              ${backButton(options.backUrl, options.backLabel || '返回列表')}
            </div>
          </div></div>
        </div>
      </div>
    </form>
  </div>
</div>`;
}

// 删除确认卡片(与服务端确认页同文案): 不可恢复 / 可恢复两套措辞
export function deleteConfirmCard(options = {}) {
  const rows = (options.impact || []).map(([label, count]) => `<tr><td>${escapeHtml(label)}</td><td>${Number(count) || 0}</td></tr>`).join('');
  const head = options.recoverable
    ? `<div class="alert alert-warning d-flex align-items-start gap-2" role="alert" aria-live="polite">
      <i class="bi bi-exclamation-triangle-fill fs-4" aria-hidden="true"></i>
      <div><div class="fw-semibold">即将删除 ${escapeHtml(options.title)}</div>
      <div class="small">删除后进入回收站，可在回收站恢复；<strong>不会</strong>清除下列关联数据，它们只是随这条记录一起隐藏。超过保留期会被自动彻底清理。</div></div>
    </div>`
    : `<div class="alert alert-danger d-flex align-items-start gap-2" role="alert" aria-live="assertive">
      <i class="bi bi-exclamation-triangle-fill fs-4" aria-hidden="true"></i>
      <div><div class="fw-semibold">此操作不可恢复</div>
      <div class="small">即将删除 ${escapeHtml(options.title)}，以下关联数据会一并被清除，且无法恢复。</div></div>
    </div>`;
  return `<div class="card"><div class="card-body">
  ${head}
  <div class="table-responsive">
    <table class="table table-sm align-middle" aria-label="删除影响面预览">
      <thead><tr><th scope="col">关联数据</th><th scope="col">将被删除的条数</th></tr></thead>
      <tbody>${rows}
        <tr class="table-light"><th scope="row">合计</th><td>${Number(options.totalImpact) || 0} 条关联数据</td></tr>
      </tbody>
    </table>
  </div>
  ${options.tip ? `<p class="text-muted small mb-3">${escapeHtml(options.tip)}</p>` : ''}
  <form method="post" action="${escapeHtml(options.submitAction)}" class="d-flex flex-wrap gap-2">
    ${(options.hiddenFields || []).map(([name, value]) => hiddenField(name, value)).join('')}
    <button class="btn btn-danger" type="submit">
      <i class="bi bi-trash" aria-hidden="true"></i> ${options.recoverable ? '确认删除（移入回收站）' : '确认彻底删除'}
    </button>
    <a class="btn btn-outline-secondary" href="${escapeHtml(options.backUrl)}">取消并返回</a>
  </form>
</div></div>`;
}
