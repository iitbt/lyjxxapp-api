/**
 * 后台列表页公共脚本(唯一实现):
 *   AdminInfiniteScroll —— "滚动到底自动加载"的触发器
 *   AdminPagerBar       —— 底部工具栏(回到顶部 / 页码直达)
 *   AdminListLoader     —— 分页加载下一页(取数 + 插入行 + 状态文案 + 失败重试)
 *
 * 演进:
 *   2026-09-19(优化建议 七.2): 以前触发逻辑与工具栏在 7 个列表模板里逐字
 *     复制, 改一处要改七处 —— 收编为 AdminInfiniteScroll
 *     与 AdminPagerBar, 各模板只保留"本页特有"的部分。
 *   2026-09-20(B1/B2/B3/B4): 再把 8 份逐字复制的 loadNextXxxPage() /
 *     syncXxxPageFields() / renderXxxLoadedHint() 收编成 AdminListLoader ——
 *     各列表页末尾现在只剩一次 init(含 notice_manage 那份漏网的第 8 份)。
 *     顺带修掉: ① 跳页默认不再携带 ?message/error; ② IntersectionObserver 与
 *     window.scroll 不再双双注册, 兜底分支改为 rAF 节流, 页面卸载时 disconnect()。
 *
 * 用法(见各列表模板末尾):
 *   AdminListLoader.init({
 *     tbodyId: 'newsRowsTbody',           // 追加行的 <tbody>
 *     sentinelId: 'newsLoadMore',         // "滚动到底自动加载更多"提示条
 *     textId: 'newsLoadMoreText',         // 提示条里的文案容器
 *     rowsUrl: '/admin/news_manage_rows', // 行片段端点(返回 {success, rows})
 *     loadedPage: 1, totalPages: 3,       // 首屏页码状态
 *     total: 28, perPage: 10, unit: '条',  // 统计条口径(可省, 省了只显示页码)
 *     hintId: 'loadedHint',               // 统计条容器(可省)
 *     announceLabel: '笔记',               // 读屏播报前缀
 *     rowMarker: 'rowCheck',              // 可省: 用"本页是否含该标记"判定空页
 *     pager: {                            // 可省: 底部工具栏三项 id
 *       backTopId: 'newsBackTopBtn',
 *       jumpBtnId: 'newsJumpBtn',
 *       jumpInputId: 'newsJumpInput',
 *       baseUrl: '/admin/news_manage'     // 可省, 省略则跳当前路径
 *     }
 *   });
 *
 * 仍由页面自己负责的: 行内操作(复制/删除/启停) —— 各模块的行 HTML 与端点不同,
 * 天然是页面自己的职责(行片段里的状态切换已另有 status-toggle.js)。
 */
(function (global) {
  'use strict';

  // 提示条文案里的图标斜线都带 aria-hidden, 避免读屏念出无意义的图标
  var LOADING_HTML = '<i class="bi bi-arrow-repeat" aria-hidden="true"></i> 加载中…';
  var MORE_HTML = '<i class="bi bi-arrow-down-circle" aria-hidden="true"></i> 滚动到底自动加载更多';

  function byId(id) { return id ? document.getElementById(id) : null; }

  var AdminInfiniteScroll = {
    /**
     * @param {Object}  opts
     * @param {string}  opts.sentinelId 哨兵元素 id("加载更多"提示条)
     * @param {Function} [opts.hasMore] 返回是否还有下一页; 假则完全不启用监听
     * @param {Function} opts.loadMore  触发一次"加载下一页"
     */
    init: function (opts) {
      var el = byId(opts.sentinelId);
      if (!el) return;
      if (typeof opts.hasMore === 'function' && !opts.hasMore()) return;

      var queued = false;
      function hasMore() { return typeof opts.hasMore !== 'function' || opts.hasMore(); }
      // rAF 节流: 一次滚动会连发多个 scroll / 多次 IO 回调, 不必每帧都去 loadMore
      function trigger() {
        if (queued || !hasMore()) return;
        queued = true;
        (global.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
          queued = false;
          if (hasMore()) opts.loadMore();
        });
      }

      if ('IntersectionObserver' in global) {
        var io = new IntersectionObserver(function (entries) {
          if (entries[0].isIntersecting) trigger();
        }, { rootMargin: '200px 0px' });
        io.observe(el);
        // 页面卸载/从 bfcache 离开时解绑: 否则反复进出列表页会堆积观察器
        global.addEventListener('pagehide', function () { io.disconnect(); });
      } else {
        // 只有不支持 IntersectionObserver 时才退化到 scroll 兜底(以前两套同时注册,
        // 同一刻会触发两次加载判定, 且没有任何节流)
        global.addEventListener('scroll', function () {
          if (global.innerHeight + global.scrollY >= document.documentElement.scrollHeight - 300) trigger();
        }, { passive: true });
      }
    }
  };

  var AdminPagerBar = {
    /**
     * @param {Object}          opts
     * @param {string}          opts.backTopId   回到顶部按钮 id
     * @param {string}          opts.jumpBtnId   跳页按钮 id
     * @param {string}          opts.jumpInputId 跳页输入框 id
     * @param {Function|number} opts.totalPages  总页数(值或取值函数)
     * @param {string}   [opts.baseUrl]    跳页目标(省略 = 当前路径)
     * @param {string[]} [opts.cleanParams] 跳页时要删掉的查询参数(默认清掉提示用的 message/error)
     */
    init: function (opts) {
      var backTopBtn = byId(opts.backTopId);
      if (backTopBtn) {
        backTopBtn.addEventListener('click', function () {
          global.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }
      var jumpBtn = byId(opts.jumpBtnId);
      var jumpInput = byId(opts.jumpInputId);
      function doJump() {
        var n = parseInt(jumpInput ? jumpInput.value : '', 10);
        var totalPages = typeof opts.totalPages === 'function' ? opts.totalPages() : opts.totalPages;
        if (!n || n < 1 || n > totalPages) {
          alert('请输入 1 ~ ' + totalPages + ' 之间的页码');
          if (jumpInput) jumpInput.focus();
          return;
        }
        // 复制当前查询参数再覆盖 page, 保证筛选条件不丢
        var params = new URLSearchParams(global.location.search);
        // 2026-09-20: 提示类参数默认一并清掉 —— 以前跨页仍带着 ?message/error,
        // 跳页后旧提示又弹一次。原先只有一半的列表页手动传了 cleanParams。
        (opts.cleanParams || ['message', 'error']).forEach(function (k) { params.delete(k); });
        params.set('page', n);
        global.location.href = (opts.baseUrl || global.location.pathname) + '?' + params.toString();
      }
      if (jumpBtn) jumpBtn.addEventListener('click', doJump);
      if (jumpInput) {
        jumpInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); doJump(); }
        });
      }
    }
  };

  var AdminListLoader = {
    /**
     * 统一"触底加载下一页": 取数 → 追加行 → 更新统计与 page 隐藏域 → 失败给重试按钮。
     * 页码/total 由页面渲染时下发(值与后端 paginate 同源), 这里只做增量。
     *
     * @param {number} [opts.syncPageFields=true] 是否把最新页码回写到所有 input[name=page]
     * @param {string[]} [opts.cleanParams=['message','error']] 取行片段时要丢掉的参数
     * @returns {{loadNext: Function, state: Object, renderHint: Function}}
     */
    init: function (opts) {
      var state = {
        page: opts.loadedPage || 1,
        totalPages: opts.totalPages || 1,
        loading: false,
        failed: false
      };
      var retryBtnId = opts.retryBtnId ||
        (opts.sentinelId ? opts.sentinelId.replace('LoadMore', 'Retry') + 'Btn' : '');

      function loadedCount() {
        if (!opts.perPage) return null;
        return Math.min(state.page * opts.perPage, opts.total || 0);
      }
      function renderHint() {
        var hint = byId(opts.hintId);
        if (!hint) return;
        var n = loadedCount();
        hint.textContent = n === null
          ? '已加载 ' + state.page + '/' + state.totalPages + ' 页'
          : '已加载 ' + n + '/' + opts.total + ' ' + (opts.unit || '条') +
            ' · 第 ' + state.page + '/' + state.totalPages + ' 页';
      }
      function syncPageFields() {
        if (opts.syncPageFields === false) return;
        // 行内 <form> 会让外层表单在解析时提前闭合, 因此必须更新全页所有 name=page,
        // 不能只搜某个表单内部 —— 保证脚行操作后仍停在当前已加载页。
        Array.prototype.forEach.call(document.querySelectorAll('input[name="page"]'), function (input) {
          input.value = state.page;
        });
        // 行内删除改走服务端确认页后(B11), 该类入口是 <a href="...&page=N"> 而非表单 ——
        // 标了 data-page-sync 的链接同样要把 page 换成最新已加载页才能回到原位置。
        Array.prototype.forEach.call(document.querySelectorAll('a[data-page-sync]'), function (link) {
          var url = new URL(link.href, global.location.origin);
          url.searchParams.set('page', state.page);
          link.href = url.pathname + '?' + url.searchParams.toString();
        });
      }
      // 空页判定: 默认看整段 HTML 是否只有空白; 个别页面(笔记/用户)的行片段可能带
      // 首屏之外的标记行, 用 rowMarker 更稳 —— 两种口径都由页面按需指定。
      function isEmptyPage(rows) {
        if (opts.rowMarker) return (rows || '').indexOf(opts.rowMarker) === -1;
        return !(rows || '').trim();
      }
      function setStatusText(html) { var t = byId(opts.textId); if (t) t.innerHTML = html; }
      function announce() {
        if (!global.a11yAnnounce) return;
        global.a11yAnnounce((opts.announceLabel || '列表') + '已加载 ' +
          state.page + '/' + state.totalPages + ' 页');
      }

      function loadNext() {
        // failed: 上次失败后先停手, 避免滚到底时不停重试打接口, 由用户点"重试"恢复
        if (state.loading || state.failed || state.page >= state.totalPages) return;
        var textEl = byId(opts.textId);
        if (!textEl) return;
        state.loading = true;
        state.failed = false;
        setStatusText(LOADING_HTML);

        var next = state.page + 1;
        // 带上当前查询参数(筛选条件不会因为翻页丢失), 只丢掉提示类参数
        var params = new URLSearchParams(global.location.search);
        (opts.cleanParams || ['message', 'error']).forEach(function (k) { params.delete(k); });
        params.set('page', next);

        fetch(opts.rowsUrl + '?' + params.toString())
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.success) throw new Error((d && d.message) || '加载失败');
            var rowsHtml = d.rows || '';
            if (isEmptyPage(rowsHtml)) {
              state.page = state.totalPages;   // 这页没有数据了, 强制到底并停止加载
            } else {
              var tbody = byId(opts.tbodyId);
              if (tbody) tbody.insertAdjacentHTML('beforeend', rowsHtml);
              state.page = next;
            }
            syncPageFields();
            renderHint();
            announce();
            setStatusText(state.page >= state.totalPages ? '— 已全部加载 —' : MORE_HTML);
          })
          .catch(function (err) {
            state.failed = true;
            setStatusText('<i class="bi bi-exclamation-triangle" aria-hidden="true"></i> 加载失败 ' +
              '<button type="button" class="btn btn-sm btn-outline-primary ms-2" id="' + retryBtnId + '">' +
              '<i class="bi bi-arrow-clockwise" aria-hidden="true"></i> 重试</button>');
            var retryBtn = byId(retryBtnId);
            if (retryBtn) {
              retryBtn.addEventListener('click', function () {
                state.failed = false;
                loadNext();
              });
            }
            console.error(err);
          })
          .then(function () { state.loading = false; });
      }

      AdminInfiniteScroll.init({
        sentinelId: opts.sentinelId,
        hasMore: function () { return state.page < state.totalPages; },
        loadMore: loadNext
      });
      if (opts.pager) {
        AdminPagerBar.init({
          backTopId: opts.pager.backTopId,
          jumpBtnId: opts.pager.jumpBtnId,
          jumpInputId: opts.pager.jumpInputId,
          baseUrl: opts.pager.baseUrl,
          totalPages: function () { return state.totalPages; }
        });
      }
      // 首屏同步一次: 模板里写的是初始页码, 这里补上统一的「已加载 N/总数 · 第 x/y 页」口径
      renderHint();
      return { loadNext: loadNext, state: state, renderHint: renderHint };
    }
  };

  global.AdminInfiniteScroll = AdminInfiniteScroll;
  global.AdminPagerBar = AdminPagerBar;
  global.AdminListLoader = AdminListLoader;
})(window);
