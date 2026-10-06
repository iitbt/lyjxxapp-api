/*!
 * 后台统一"状态切换"前端实现(唯一一份)。
 *
 * 覆盖: 笔记管理 / 轮播图管理 / 摩旅精选 / 户外精选 / 留言管理。
 * 改前每个页面各写一套 fetch + 各自更新 DOM 的 JS(文案表/配色表/筛选处理/播报都是拷贝),
 * 现在全部走这里 —— 行片段只需按声明式约定渲染按钮, 不用再写任何脚本。
 *
 * 按钮约定(由 templates/_*_rows.html 渲染, 取值来自后端注册表 app/admin/status.py):
 *   data-status-kind="news"          实体类型
 *   data-status-id="12"              记录 ID
 *   data-status-action="approved"    目标状态(既是提交值, 也用于显隐判断)
 *   hidden                           当前状态不适用时由服务端直接隐藏
 *
 * 交互行为(与笔记管理对齐):
 *   请求 POST /admin/status_update → 就地更新徽章与按钮, 不整页刷新、不丢滚动位置;
 *   成功/失败都用 base.html 的 a11yLive 播报(无障碍);
 *   若当前正按状态筛选且新状态不再匹配, 行用 display:none 隐藏(保留 DOM, 不影响已加载页数)。
 */
(function () {
  if (window.__adminStatusBound) { return; }  // 重复引入只绑定一次
  window.__adminStatusBound = true;

  function announce(msg) {
    if (typeof window.a11yAnnounce === 'function') {
      window.a11yAnnounce(msg);
    }
  }

  /* 状态筛选参数名由页面容器声明(data-status-filter-param="status");
     轮播图/精选没有状态筛选, 容器不声明该属性 → 不做隐藏。 */
  function filterParamName(el) {
    var scope = el.closest ? el.closest('[data-status-filter-param]') : null;
    return scope ? (scope.getAttribute('data-status-filter-param') || '') : '';
  }

  function applyToRow(btn, payload) {
    var row = btn.closest('tr');
    if (!row) { return; }
    // 1) 徽章文案 + 配色(全部来自后端返回, 前端不硬编码任何模块口径)
    var badge = row.querySelector('[data-status-badge]');
    if (badge) {
      badge.textContent = payload.status_text || payload.status;
      badge.className = 'badge text-bg-' + (payload.badge_class || 'secondary');
    }
    // 2) 切换按钮: 只显示"新状态下可用"的那些, 同一行可立刻改回去
    var allowed = payload.actions || [];
    row.querySelectorAll('[data-status-action]').forEach(function (b) {
      b.hidden = allowed.indexOf(b.getAttribute('data-status-action')) === -1;
    });
    row.setAttribute('data-status', payload.status);

    var msg = payload.message || ('状态已更新为「' + (payload.status_text || payload.status) + '」');
    // 3) 正在按状态筛选时, 新状态不再匹配就把该行隐藏(而非移除, 保证已加载页数不乱)
    var param = filterParamName(btn);
    if (param) {
      var cur = new URLSearchParams(window.location.search).get(param);
      if (cur && cur !== 'all' && cur !== payload.status) {
        row.style.display = 'none';
        announce(msg + '，当前筛选下已隐藏该行');
        return;
      }
    }
    announce(msg);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-status-action]') : null;
    if (!btn || btn.disabled) { return; }
    e.preventDefault();
    var kind = btn.getAttribute('data-status-kind');
    var id = btn.getAttribute('data-status-id');
    var target = btn.getAttribute('data-status-action');
    if (!kind || !id || !target) { return; }
    btn.disabled = true;
    var body = 'kind=' + encodeURIComponent(kind)
             + '&id=' + encodeURIComponent(id)
             + '&status=' + encodeURIComponent(target);
    // 第四批第 8 项: AJAX 写请求带上 CSRF 令牌(取自 base.html 的 <meta name="csrf-token">),
    // 服务端 AdminCsrfGuard 在"带了令牌"时做严格比对
    var csrfMeta = document.querySelector('meta[name="csrf-token"]');
    var headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (csrfMeta && csrfMeta.getAttribute('content')) {
      headers['X-CSRF-Token'] = csrfMeta.getAttribute('content');
    }
    // 2026-09-20: 加超时控制 —— 请求挂起(网络中断/服务端不响应)时 then/catch 都不执行,
    // 按钮会永久禁用且没有任何提示。15 秒未返回即中止, 走 catch 里的恢复与提示。
    var controller = null, timer = null;
    var fetchOpts = { method: 'POST', headers: headers, body: body };
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      fetchOpts.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, 15000);
    }
    function done() {
      if (timer) clearTimeout(timer);
      btn.disabled = false;
    }
    fetch('/admin/status_update', fetchOpts)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        done();
        if (!d || !d.success) {
          var err = (d && d.message) || '操作失败，请稍后重试';
          alert(err);
          announce(err);
          return;
        }
        applyToRow(btn, d);
      })
      .catch(function () {
        done();
        alert('请求失败');
        announce('请求失败，请稍后重试');
      });
  });
})();
