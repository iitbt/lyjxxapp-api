// 从旧站 base.html 的 <head> 里原样提取: 侧栏分组展开记忆 + 滚动位置恢复 + 当前项可见性兜底
// 必须同步引入(不能 defer) —— 它要在侧栏标记之后、内容区之前跑 restore, 首帧才是正确展开态
/* ============ 侧栏分组展开状态: 唯一实现(SidebarGroups) ============
   为什么单独放在 head 里: 这段代码要在"侧栏刚解析完、还没绘制"的时候跑一次(调用点在
   侧栏标记之后, 见本文件 body 开头那次 restore())。以前恢复逻辑挂在 body 末尾, 于是
   跳转/刷新后的第一次绘制是"全部收起", 紧接着脚本再把它展开并播放 0.22s 动画 ——
   这就是"已展开的菜单先收起再展开"。
   现在: ① 状态读写只在这一处定义(点击交互与首帧恢复共用, 不会各写一份而漂移);
        ② 恢复时机提前到侧栏解析之后、内容区解析之前, 首帧就是正确状态;
        ③ 恢复期间给侧栏挂 .sb-restoring 关掉过渡, 展开态一步到位, 之后点击仍有动画。
   存储: sbOpenGroups = {"v":2,"open":{"overview":true,"user":false,...}}
   (v1 是无版本字段的裸 map, 那时「概览」被默认展开, 视为无历史状态。) */
window.SidebarGroups = (function () {
  'use strict';
  var KEY = 'sbOpenGroups';
  var LEGACY_KEY = 'sbOpenGroup';   // 更早的版本: 只记"最后展开的那一个分组"
  var STATE_VERSION = 2;

  function keyOf(group) { return (group && group.getAttribute('data-group')) || ''; }
  function list(sb) {
    return sb ? Array.prototype.slice.call(sb.querySelectorAll('.nav-group')) : [];
  }
  function setOpen(group, open) {
    if (!group) return;
    group.classList.toggle('open', !!open);
    var btn = group.querySelector('.nav-cat');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  // 读状态; null = 没有可恢复的状态(首次访问 / 旧格式) → 一律按收起处理
  function read() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { return null; }
    if (raw === null) {
      var old = null;
      try { old = localStorage.getItem(LEGACY_KEY); } catch (e) {}
      if (old === null || old === '') return null;
      try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
      var migrated = {}; migrated[old] = true; return migrated;
    }
    try {
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || obj.v !== STATE_VERSION) return null;
      return (obj.open && typeof obj.open === 'object') ? obj.open : null;
    } catch (e) { return null; }
  }
  // 把当前各组的开关状态落盘(换页/刷新后照此恢复)
  function save(sb) {
    var map = {};
    list(sb).forEach(function (g) { map[keyOf(g)] = g.classList.contains('open'); });
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: STATE_VERSION, open: map }));
    } catch (e) {}
  }
  function restore(sb) {
    if (!sb) return null;
    var saved = read();
    sb.dataset.groupsRestored = '1';        // 标记"已恢复", body 末尾只做兜底不重复执行
    sb.classList.add('sb-restoring');       // 关过渡: 展开态直接到位, 不做 0 → 640px 动画
    var activeGroup = null;
    list(sb).forEach(function (g) {
      var open = saved ? saved[keyOf(g)] === true : false;   // 无历史状态 → 全部收起
      if (g.querySelector('a.active')) {
        // 含当前页的分组必定展开并提亮: 刷新/跳转后当前项不能被"藏在收起的组里"
        open = true;
        activeGroup = g;
        g.classList.add('has-active');
      }
      setOpen(g, open);
    });
    save(sb);
    // 下一帧放开过渡: 之后用户点击父菜单仍有正常动画, 而这次恢复不会产生任何闪动
    (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
      sb.classList.remove('sb-restoring');
    });
    return activeGroup;
  }
  /* ---- 侧栏滚动位置: 记住 + 跨页恢复(2026-09-21) ----
     为什么需要它: 后台是"点菜单就整页重新加载"的传统页面 —— 新文档的侧栏 scrollTop 天然是 0。
     于是"先把侧栏往下滚、再点一个靠下的菜单"时, 新页面必然从**顶部**开始, 随后被定位逻辑
     修正一次: 先前那版算"居中", 用户看到"把自己滚到中间"; 改成贴边后又表现为"向下对齐" ——
     两种都不是"点哪停哪"。根子在于**位置本身被重置了**, 只是因为滚动容器在整页跳转后不保留位置。
     于是这里把位置记下来、首帧前恢复; 之后那次可见性兜底通常就无事可做。
     存 sessionStorage 而不是 localStorage: 这是"浏览过程中的当前位置"(临时状态), 关掉标签页
     即失效; 不像分组展开态(sbOpenGroups)那样是要跨天记住的偏好。
     保存时机见 body 末尾: 滚动时节流落盘 + 点菜单项时立即落盘 + 离开页面时补一次。 */
  var SCROLL_KEY = 'sbScrollTop';

  /* 立即(无动画)把侧栏滚到指定位置。所有"首帧前的滚动"都走这里 —— 显式把 scroll-behavior
     置为 auto: 否则将来一旦有样式(或 UA/插件)给侧栏开了 smooth, 这次定位就会变成一段
     可见的滚动动画(那正是要消掉的现象)。 */
  function setScrollTopInstant(sb, value) {
    var prev = sb.style.scrollBehavior;
    sb.style.scrollBehavior = 'auto';
    sb.scrollTop = value;                 // 越界由浏览器自动夹到合法范围
    sb.style.scrollBehavior = prev;
  }

  function savedScrollTop() {
    try {
      var raw = sessionStorage.getItem(SCROLL_KEY);
      if (raw === null || raw === '') return null;
      var n = parseInt(raw, 10);
      return (isNaN(n) || n <= 0) ? null : n;
    } catch (e) { return null; }          // 隐私模式/被禁用 → 当作没有历史位置
  }

  function saveScrollTop(sb) {
    if (!sb) return false;
    try { sessionStorage.setItem(SCROLL_KEY, String(Math.round(sb.scrollTop || 0))); return true; }
    catch (e) { return false; }
  }

  /* 回到上次的滚动位置(首帧前调用)。返回是否真的滚了。 */
  function restoreScrollTop(sb) {
    if (!sb) return false;
    var top = savedScrollTop();
    if (top === null) return false;
    if (sb.scrollHeight <= sb.clientHeight) return false;   // 这一屏根本滚不动
    setScrollTopInstant(sb, top);
    return true;
  }

  /* 让"当前页那一项"进入侧栏可视区(**兜底**: 最小幅度, 不居中)。
     用户口径"点哪停哪":
       · 当前项已完整可见 → 一点不滚;
       · 只在被遮住时才滚, 且只滚到"刚好贴边露出来"(上方被遮贴顶、下方被遮贴底), **不居中**。
     正常路径下它什么都不做: 位置已由 restoreScrollTop 恢复, 而用户点的那个菜单项本来就在
     可见范围内。只有"没有可恢复的位置"(首次进入/直接打开某页)或"恢复后仍看不到当前项"时,
     它才动, 且只动最小幅度。
     时机: 在 </aside> 之后与 restore 同一帧同步调用 —— 首帧即最终位置, 不会"先回顶部再跳"。 */
  function ensureActiveVisible(sb) {
    if (!sb) return false;
    var act = sb.querySelector('a.active');
    if (!act) return false;
    if (sb.scrollHeight <= sb.clientHeight) return false;   // 侧栏没超出一屏 → 本来就不用滚
    var r = act.getBoundingClientRect(), box = sb.getBoundingClientRect();
    // 只算"把它露出来所需的最小位移": 上方被遮 → 向上贴顶; 下方被遮 → 向下贴底; 完整可见 → 0
    var delta = 0;
    if (r.top < box.top) { delta = r.top - box.top; }
    else if (r.bottom > box.bottom) { delta = r.bottom - box.bottom; }
    if (delta === 0) return false;                          // 已在可视区 → 不滚动(点哪停哪)
    setScrollTopInstant(sb, sb.scrollTop + delta);
    return true;
  }
  return { restore: restore, save: save, setOpen: setOpen, read: read, keyOf: keyOf,
           ensureActiveVisible: ensureActiveVisible,
           restoreScrollTop: restoreScrollTop, saveScrollTop: saveScrollTop };
})();
