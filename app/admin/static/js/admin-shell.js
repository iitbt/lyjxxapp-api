// 从旧站 base.html 的 body 末尾原样提取: 侧栏抽屉/焦点管理/无障碍播报/表单防重/错误聚焦
// 在 body 末尾同步引入(此时 DOM 已就绪, 内部 getElementById 才拿得到侧栏)
/* ============ 菜单栏交互 ============ */
  (function () {
    var sb = document.getElementById('sidebar');
    var backdrop = document.getElementById('sidebarBackdrop');
    var btnOpen = document.getElementById('btnOpenSidebar');
    function isMobile() { return window.innerWidth < 768; }
    function debounce(fn, ms) {
      var t = null;
      return function () { clearTimeout(t); t = setTimeout(fn, ms); };
    }
    // 抽屉焦点管理(无障碍): 打开时把焦点移入抽屉, 关闭时归还给触发按钮,
    // 并用 Tab 循环把焦点锁在抽屉内 —— 否则键盘用户 Tab 会跑到被遮罩盖住的内容区。
    var _lastFocus = null;
    function _focusables() {
      if (!sb) return [];
      return Array.prototype.slice.call(
        sb.querySelectorAll('a[href], button:not([disabled]), input, select, textarea')
      ).filter(function (el) { return el.offsetParent !== null; });
    }
    function setDrawer(open) {
      if (!sb) return;
      var wasOpen = sb.classList.contains('show');
      sb.classList.toggle('show', open);
      document.body.classList.toggle('sidebar-open', open);
      if (btnOpen) btnOpen.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && !wasOpen) {
        _lastFocus = document.activeElement;
        var first = _focusables()[0];
        // preventScroll: 抽屉内第一个可聚焦元素是顶部的品牌链接, 而浏览器为了"显示被聚焦元素"
        // 会把**侧栏自己**滚回顶部 —— 表现为"刚打开菜单, 之前滚到的位置就没了"。
        // 键盘用户照样能用 Tab 进来, 只是不因为聚焦而改变滚动位置。
        if (first) { try { first.focus({ preventScroll: true }); } catch (e) {} }
      } else if (!open && wasOpen) {
        if (_lastFocus && document.contains(_lastFocus)) {
          try { _lastFocus.focus(); } catch (e) {}
        } else if (btnOpen) {
          try { btnOpen.focus(); } catch (e) {}
        }
        _lastFocus = null;
      }
    }
    // 全局无障碍播报: 各页异步操作(加载更多/切状态)完成后调用, 读屏用户可感知结果
    window.a11yAnnounce = function (msg) {
      var el = document.getElementById('a11yLive');
      if (!el || !msg) return;
      el.textContent = '';           // 先清空, 保证同一句话重复播报也能被读到
      setTimeout(function () { el.textContent = msg; }, 30);
    };
    // 侧栏常驻: 桌面端不显示入口按钮; 小屏才由按钮滑出抽屉(setDrawer 在非小屏无效)
    window.openSidebar = function () { if (isMobile()) setDrawer(true); };
    window.closeSidebar = function () { setDrawer(false); };
    window.toggleSidebar = function () {
      if (!isMobile()) return;
      sb.classList.contains('show') ? setDrawer(false) : setDrawer(true);
    };
    if (backdrop) backdrop.addEventListener('click', function () { setDrawer(false); });
    document.addEventListener('keydown', function (e) {
      // 2026-09-20: 以前这里 if 内外各调一次 setDrawer(false)(重复调用), 合并为一次
      if (e.key !== 'Escape') return;
      setDrawer(false);
    });
    // 焦点陷阱: 抽屉打开时 Tab / Shift+Tab 只在抽屉内循环
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || !sb || !sb.classList.contains('show')) return;
      var items = _focusables();
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (items.indexOf(document.activeElement) === -1) { e.preventDefault(); first.focus(); }
    });
    /* ---- 分组抽屉(2026-09-20: 由手风琴改为"各组独立开关, 可同时展开多个") ----
       父菜单点击 → 只切换自己这一组的展开/收起, 同层其它组保持原样;
       状态读写与"首帧恢复"都收在 head 的 window.SidebarGroups 里(侧栏标记之后已调用过
       restore, 首帧即正确展开态, 不会再出现"先收起再展开"); 这里只负责点击交互与落盘,
       不重复实现恢复逻辑, 避免两处各写一份而漂移。
       点子菜单项 → 正常导航并把侧栏收起(侧栏本身是浮层)。 */
    // 兜底: 万一 </aside> 后面那次首帧恢复没跑到(模板被裁剪/脚本被拦), 这里补一次。
    // 正常路径下 restore 已经跑过(侧栏上有 data-groups-restored 标记), 不会重复执行 ——
    // 重复执行本身也不会闪动(同样的状态再 apply 一次不触发过渡), 但没必要。
    if (sb && !sb.dataset.groupsRestored) { window.SidebarGroups.restore(sb); }
    if (sb) sb.addEventListener('click', function (e) {
      var btn = e.target.closest('.nav-cat');
      if (btn) {
        var g = btn.closest('.nav-group');
        if (g) {
          window.SidebarGroups.setOpen(g, !g.classList.contains('open'));
          window.SidebarGroups.save(sb);
        }
        return;
      }
      // 点菜单项后自动收起(各尺寸一致): 抽屉是浮层, 导航完不该继续压着内容区
      if (e.target.closest('a')) {
        // 跳转前把侧栏当前滚动位置落盘 —— 新页面靠它"点哪停哪"(见 head 的 restoreScrollTop)
        window.SidebarGroups.saveScrollTop(sb);
        setDrawer(false);
      }
    });
    // 侧栏滚动位置: 滚动中节流落盘 + 离开页面时再补一次
    // (补那次是为了覆盖"不是点侧栏菜单、而是点内容区里的链接"造成的跳转)
    if (sb) {
      var _sbScrollTimer = null;
      sb.addEventListener('scroll', function () {
        if (_sbScrollTimer) return;          // 节流: 滚动过程中只写最后一个位置
        _sbScrollTimer = window.setTimeout(function () {
          _sbScrollTimer = null;
          window.SidebarGroups.saveScrollTop(sb);
        }, 120);
      }, { passive: true });
      window.addEventListener('pagehide', function () {
        if (_sbScrollTimer) { window.clearTimeout(_sbScrollTimer); _sbScrollTimer = null; }
        window.SidebarGroups.saveScrollTop(sb);
      });
    }
    // 视口变化(旋转/改窗口/软键盘): 收起小屏抽屉, 避免"常驻栏/浮层"两种形态错位
    function applyViewport() {
      setDrawer(false);
    }
    // CSRF 请求头工具(2026-09-19): fetch/AJAX 写请求统一从这里取令牌。
    // 生产 ADMIN_CSRF_ENFORCE=true 时, 漏带令牌的写请求会被 AdminCsrfGuard 直接 403 ——
    // 图片上传走的是 multipart(服务端只解析表单体取不到令牌), 因此**必须**靠这个头。
    // 各页面不要再各写一份(以前就有页面漏带, 表现为"上传点了没反应/403")。
    window.csrfHeaders = function (extra) {
      var headers = extra || {};
      var meta = document.querySelector('meta[name="csrf-token"]');
      var token = meta && meta.getAttribute('content');
      if (token) { headers['X-CSRF-Token'] = token; }
      return headers;
    };
    // 锁按钮只能用 aria-disabled: 表单数据在 submit 事件走完之后才构造, 事件里被禁用的按钮不进表单数据。
    // 提交只看按钮的 value 属性(与 innerHTML 无关), 所以只改 button 的文案, input[type=submit] 不改。
    function lockButton(btn) {
      if (btn.getAttribute('aria-disabled') === 'true') return;
      btn.setAttribute('aria-disabled', 'true');
      btn.style.pointerEvents = 'none';
      if (btn.tagName === 'INPUT') return;
      if (!btn.dataset.originHtml) btn.dataset.originHtml = btn.innerHTML;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span> 处理中…';
    }
    function unlockButton(btn) {
      btn.removeAttribute('aria-disabled');
      btn.style.pointerEvents = '';
      if (btn.dataset.originHtml !== undefined) {
        btn.innerHTML = btn.dataset.originHtml;
        delete btn.dataset.originHtml;
      }
    }
    document.addEventListener('submit', function (e) {
      var form = e.target;
      if (!form || form.method.toLowerCase() !== 'post') return;
      if (form.dataset.submitting === '1') {   // 已经在提交中, 拦掉重复提交
        e.preventDefault();
        return;
      }
      form.dataset.submitting = '1';
    }, true);

    // 冒泡阶段的收尾: defaultPrevented 表示这次提交已被取消 → 必须复位
    document.addEventListener('submit', function (e) {
      var form = e.target;
      if (!form || form.method.toLowerCase() !== 'post') return;
      if (e.defaultPrevented) {
        form.dataset.submitting = '';
        return;
      }
      // 提交确实要发出去了: 只锁按钮的可点性, 绝不动它的 name/value
      var btn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (btn) lockButton(btn);
      // 不再设"N 秒后自动解锁": 慢请求下解锁会让用户再次提交成功。
      // 需要恢复的场景(校验失败/异常)服务端会重新渲染整页, 按钮自然回到初始态;
      // 从 bfcache 返回时由下面的 pageshow 复位。
    }, false);
    // 浏览器"后退"从 bfcache 恢复页面时, 清掉可能残留的提交中标记与按钮锁
    window.addEventListener('pageshow', function () {
      var list = document.querySelectorAll('form[data-submitting="1"]');
      for (var i = 0; i < list.length; i++) {
        list[i].dataset.submitting = '';
        var btn = list[i].querySelector('button[type="submit"], input[type="submit"]');
        if (btn) unlockButton(btn);
      }
    });

    // 错误/成功提示自动聚焦: 提示是服务端渲染后静态出现的,
    // 聚焦后读屏会立即播报, 键盘用户也能直接看到出错原因(配合 role="alert")。
    // 字段级错误优先: 若存在被标记 .is-invalid 的控件, 焦点落在该控件上
    // (用户不用自己在长表单里找哪一项填错), 否则聚焦提示条。
    (function focusFirstError() {
      // .is-invalid 优先; 富文本这类非表单控件用 data-invalid 标记(外层容器)
      var bad = document.querySelector('.is-invalid') || document.querySelector('[data-invalid]');
      if (bad) {
        try {
          bad.scrollIntoView({ block: 'center', behavior: 'smooth' });
          bad.focus({ preventScroll: true });
        } catch (e) {
          try { bad.focus(); } catch (e2) {}
        }
        return;
      }
      var el = document.querySelector('.alert[role="alert"]');
      if (!el) return;
      el.setAttribute('tabindex', '-1');
      try { el.focus({ preventScroll: true }); } catch (e) {}
    })();

    if (sb) {
      var act = sb.querySelector('a.active');
      if (act) {
        act.setAttribute('aria-current', 'page');
        // 滚动定位**不在这里**: 它已经在"侧栏标记之后"那次同步调用里做完了(首帧即正确位置)。
        // 这里只保留兜底 —— 万一之后布局又变了(例如图标字体加载完把行高改了一点点)导致当前项
        // 被遮住, 就在资源加载完成后补一次。它是"最小幅度"的: 当前项本来就在视野里时
        // ensureActiveVisible 直接返回、一点不滚, 因此不会再制造出第二次跳动。
        //
        // 兜底还必须"让着用户": 侧栏上出现真实输入(滚轮/触摸/按下/按键)就说明用户自己在滚动菜单,
        // 此时**绝不能**再按"当前项是否可见"去纠正 —— 那会把人家正在看的位置拽走(本次要消灭的
        // 正是这种"你没让我滚, 我却滚了")。只听用户意图事件, 不听 scroll: 我们自己那次定位
        // 也会触发 scroll 事件, 用 scroll 判断会把用户与脚本混为一谈。
        var userMoved = false;
        ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(function (evt) {
          sb.addEventListener(evt, function () { userMoved = true; }, { passive: true, once: true });
        });
        var alignActive = function () {
          if (userMoved) return;
          window.SidebarGroups.ensureActiveVisible(sb);
        };
        if (document.readyState === 'complete') { alignActive(); }
        else { window.addEventListener('load', alignActive); }
      }
    }
    applyViewport();
    window.addEventListener('resize', debounce(applyViewport, 160));
  })();
