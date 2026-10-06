// 后台页面外壳: 结构照搬旧站 base.html(同样的 class 名与分组层级), 因此旧站 admin.css 能直接复用
// 脚本引用顺序不能乱: ① head 里同步引 sidebar-groups.js(首帧就要恢复分组展开态);
// ② 侧栏标记之后 inline 调 restore; ③ body 末尾同步引 admin-shell.js(DOM 已就绪, 抽屉才绑得上)
import { escapeHtml } from '../../core/html.js';
import { NAV_GROUPS } from './nav.js';

// 仅本 Worker 需要的几行样式(旧 CSS 里没有"待迁"标记与统计卡片)
const EXTRA_STYLE = [
  '.nav-tag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;background:#ffe9c7;color:#9a6100;font-size:10px;vertical-align:middle}',
  'a.nav-todo{opacity:.6}',
  '.card-stat{background:#fff;border-radius:12px;padding:16px 18px;box-shadow:0 1px 2px rgba(16,24,40,.06)}',
  '.card-stat .num{font-size:26px;font-weight:600}',
  '.card-stat .lbl{color:#8a9099;font-size:13px}'
].join('');
// 说明: sparkline / cover-thumb / cover-preview / action-cell 这些类旧站 admin.css 里已有定义,
// 不要在这里重复声明 —— 覆盖旧值会造成"和旧后台长得不一样"的隐性偏差

function renderSidebar(currentPage, isSuper) {
  return NAV_GROUPS.map((group) => {
    const items = group.items.filter((item) => !item.superOnly || isSuper);
    if (!items.length) return '';
    const links = items.map((item) => {
      const cls = [item.key === currentPage ? 'active' : '', item.status === 'ready' ? '' : 'nav-todo']
        .filter(Boolean).join(' ');
      // 待迁 = 后面还会做; 未迁移 = 本次明确不做(如数据库工具/素材库治理, 用 D1 控制台代替)
      const tag = item.status === 'ready' ? ''
        : `<span class="nav-tag">${item.status === 'skipped' ? '未迁移' : '待迁'}</span>`;
      return `<a href="${item.href}"${cls ? ` class="${cls}"` : ''} title="${escapeHtml(item.title)}">`
        + `<i aria-hidden="true" class="bi ${item.icon}"></i>`
        + `<span class="nav-label">${escapeHtml(item.title)}${tag}</span></a>`;
    }).join('');
    return `<div class="nav-group" data-group="${group.key}">`
      + `<button type="button" class="nav-cat" aria-expanded="false" aria-controls="navgrp-${group.key}">`
      + `<span>${escapeHtml(group.title)}</span><i aria-hidden="true" class="bi bi-chevron-down nav-cat-caret"></i></button>`
      + `<div class="nav-group-items" id="navgrp-${group.key}">${links}</div></div>`;
  }).join('');
}

function alerts(message, error) {
  const ok = message
    ? `<div class="alert alert-success" role="alert"><i class="bi bi-check-circle" aria-hidden="true"></i> ${escapeHtml(message)}</div>`
    : '';
  const bad = error
    ? `<div class="alert alert-danger" role="alert" aria-live="assertive"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> ${escapeHtml(error)}</div>`
    : '';
  return ok + bad;
}

export function adminLayout(options = {}) {
  const title = options.title || '控制面板';
  // 版本号只有一个来源(main.js 的 API_VERSION, 由入口注入到 ctx); 万一没注入, 也**不要**渲染出空的"v"
  const rawVersion = String(options.version || '');
  const version = encodeURIComponent(rawVersion);
  const isSuper = options.isSuper === true;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - 狼牙极限运动笔记</title>
<link href="/admin/static/vendor/bootstrap.min.css?v=${version}" rel="stylesheet">
<link href="/admin/static/vendor/bootstrap-icons.min.css?v=${version}" rel="stylesheet">
<link href="/admin/static/css/admin.css?v=${version}" rel="stylesheet">
<style>${EXTRA_STYLE}</style>
<script src="/admin/static/js/sidebar-groups.js?v=${version}"></script>
</head>
<body>
<a href="#mainContent" class="skip-link">跳到主要内容</a>
<div class="app-shell">
  <aside class="sidebar" id="sidebar" aria-label="后台侧边菜单">
    <div class="sidebar-inner">
      <a class="brand" href="/admin/dashboard" title="返回控制面板">
        <i aria-hidden="true" class="bi bi-shield-check"></i>
        <span class="brand-text">狼牙笔记</span>
        ${rawVersion ? `<span class="ver">v${escapeHtml(rawVersion)}</span>` : ''}
      </a>
      <nav class="sidebar-nav" aria-label="后台功能菜单">${renderSidebar(options.currentPage, isSuper)}</nav>
    </div>
  </aside>
  <script>
    (function () {
      var sb = document.getElementById('sidebar');
      window.SidebarGroups.restore(sb);
      window.SidebarGroups.restoreScrollTop(sb);
      window.SidebarGroups.ensureActiveVisible(sb);
    })();
  </script>
  <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
  <main class="content" id="mainContent" tabindex="-1">
    <div class="topbar">
      <div class="d-flex align-items-center gap-2 col-shrink">
        <button id="btnOpenSidebar" class="btn btn-light border d-md-none flex-shrink-0" type="button"
                title="打开菜单" aria-label="打开菜单" aria-expanded="false" aria-controls="sidebar"
                onclick="toggleSidebar()"><i aria-hidden="true" class="bi bi-list"></i></button>
        <h5 class="mb-0 text-truncate">${escapeHtml(title)}</h5>
      </div>
      <div class="d-flex align-items-center gap-2 flex-shrink-0">
        <span class="badge bg-success-subtle text-success"><i aria-hidden="true" class="bi bi-person-circle"></i> ${escapeHtml(options.admin || '')}</span>
        <form method="post" action="/admin/logout" class="d-inline">
          <button class="btn btn-outline-danger btn-sm" type="submit"><i class="bi bi-box-arrow-right" aria-hidden="true"></i> 退出</button>
        </form>
      </div>
    </div>
    ${alerts(options.message, options.error)}
    <div id="a11yLive" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></div>
    <div class="content-wrap">${options.content || ''}</div>
  </main>
</div>
<script src="/admin/static/vendor/bootstrap.bundle.min.js?v=${version}"></script>
<script src="/admin/static/js/admin-shell.js?v=${version}"></script>
<script src="/admin/static/js/status-toggle.js?v=${version}" defer></script>
${options.scripts || ''}
</body>
</html>`;
}
