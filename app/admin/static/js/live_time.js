/* 会走动的「时间 / 运行时长」显示的**唯一实现**。
 * 2026-09-23 创建(v2.3.6); 同日按用户要求**不升版本号**, 把基准从"浏览器本地时间"改成
 * "服务器时间 + 本地推算"。
 *
 * 【为什么抽成一个文件】
 * 「后端显示页面」(状态页, 挂在 /, 模板 app/templates/status.html)与后台「系统信息」页
 * (app/admin/templates/system_info.html)都要显示会走动的时间。原先只有状态页内联了一段
 * tick(), 系统信息页的「服务器时间」「服务已运行」只有刷新页面才更新; 两处的格式与间隔
 * 必须一致, 所以收敛成这一份, 两个页面都引用它 —— 各写一套必然漂移。
 *
 * 【基准 = 服务器时间(本次调整)】
 *   之前: 直接显示**浏览器本机**的 new Date() —— 机器时间不准时, 页面上的「服务器时间」就是错的。
 *   现在: ① 后端渲染页面时写入锚点 data-live-anchor(服务器墙钟毫秒, 见 timeutil.wall_clock_ms),
 *            前端先用它算出与本机的差值 → **首屏立刻**就是服务器时间, 不必等网络;
 *         ② 再**额外请求一次** /?format=json 取服务器当时的时间, 用"请求往返的中点"校正差值
 *            (差值 = 服务器墙钟 − 本机墙钟在往返中点的读数, 即把网络延迟对半分掉),
 *            这样连"渲染→解析"那段延迟带来的偏差也一并抹掉;
 *         ③ 之后每 10 分钟、以及标签页重新可见时再校一次; 平时每秒**本地推算**, 不做轮询。
 *   请求失败/离线: 继续用锚点推算(退化成"以页面渲染时刻为基准"), 页面照常走动, 不报错、不刷屏。
 *
 * 【时区无关】
 *   双方约定用"墙钟读数": 把某时区的墙上时间当成 UTC 来读(把北京时间 18:46:00 读作
 *   2026-09-23T18:46:00Z 的毫秒数)。前端 formatWall() 用 getUTC* 取值即可,
 *   所以浏览器在哪台机器、哪个时区, 显示的都是**服务器那口钟**, 不会再被本地时区搬一次。
 *
 * 【用法】(与上一版完全相同, 页面侧只多了一个锚点元素)
 *   <元素 data-live-anchor="1758…">          页面级锚点(两个页面各一个, 后端渲染时写入)
 *   data-live="clock"                        服务器时间, 格式 YYYY-MM-DD HH:mm:ss
 *   data-live="uptime" data-live-base="155"  运行时长, 文案与后端 _fmt_duration 完全一致
 *                                            (3 天 4 小时 / 2 小时 5 分 / 42 分 7 秒 / 9 秒)
 */
(function () {
  'use strict';

  /* 取服务器时间用**只读、无副作用**的 JSON 形态: service_status.index 的 JSON 分支在查库
     统计之前就返回(只有 name/description/status/server_time), 不触发任何数据库探测。 */
  var SYNC_URL = '/?format=json';
  /* 复核间隔: 10 分钟一次(不是高频轮询); 标签页重新可见时若距上次超过 1 分钟也复核一次 */
  var RESYNC_MS = 10 * 60 * 1000;
  var RESYNC_ON_SHOW_MS = 60 * 1000;

  function pad(n) { return String(n).padStart(2, '0'); }

  /* ---------- 墙钟读数(与后端 timeutil.wall_clock_ms 同一约定) ---------- */
  function wallNow() {
    var d = new Date();
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(),
                    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  }
  function parseWall(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  }
  function formatWall(wallMs) {
    var d = new Date(wallMs);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
      + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  }

  /* 与 app/admin/settings_admin.py 的 _fmt_duration() 是**同一套文案**
     (守卫会比对这份分支结构; 改一边必须同步另一边)。 */
  function fmtDuration(total) {
    var t = Math.max(0, Math.floor(total));
    var days = Math.floor(t / 86400);
    var hours = Math.floor((t % 86400) / 3600);
    var minutes = Math.floor((t % 3600) / 60);
    var secs = t % 60;
    if (days) { return days + ' 天 ' + hours + ' 小时'; }
    if (hours) { return hours + ' 小时 ' + minutes + ' 分'; }
    if (minutes) { return minutes + ' 分 ' + secs + ' 秒'; }
    return secs + ' 秒';
  }

  var anchorEl = document.querySelector('[data-live-anchor]');
  var anchorWall = anchorEl ? parseInt(anchorEl.getAttribute('data-live-anchor'), 10) : NaN;
  var loadWall = wallNow();
  var offsetMs = isNaN(anchorWall) ? 0 : (anchorWall - loadWall);  /* ① 首屏基准: 渲染锚点 */
  var lastSync = 0;

  function serverWall() { return wallNow() + offsetMs; }

  function sync() {
    lastSync = Date.now();
    var t0 = wallNow();
    var req;
    try {
      req = fetch(SYNC_URL, {
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin',
        cache: 'no-store'
      });
    } catch (e) { return; }              /* 老浏览器没有 fetch: 继续用锚点推算 */
    if (!req || typeof req.then !== 'function') { return; }
    req.then(function (r) { return r.json(); }).then(function (d) {
      var t1 = wallNow();
      var server = parseWall(d && d.server_time);
      if (server === null) { return; }
      /* ② 服务器墙钟 − 本机墙钟在"往返中点"的读数(把网络延迟对半分掉) */
      offsetMs = server - (t0 + t1) / 2;
      tick();
    }).catch(function () { /* 离线/被拦截: 静默保持锚点基准, 不影响页面 */ });
  }

  function tick() {
    var nodes = document.querySelectorAll('[data-live]');
    var nowWall = serverWall();
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var kind = el.getAttribute('data-live');
      if (kind === 'clock') {
        el.textContent = formatWall(nowWall);
      } else if (kind === 'uptime') {
        var base = parseInt(el.getAttribute('data-live-base') || '0', 10);
        if (isNaN(base)) { base = 0; }
        /* 已运行 = 后端给的基准秒数 + 距离**渲染锚点**过了多少秒(锚点是服务器时刻, 精确到毫秒) */
        var elapsed = isNaN(anchorWall) ? (wallNow() - loadWall) : (nowWall - anchorWall);
        el.textContent = fmtDuration(base + elapsed / 1000);
      }
    }
  }

  tick();                     /* 立即先走一次: 首屏不必等 1 秒, 也不等接口 */
  setInterval(tick, 1000);    /* 间隔与状态页原实现一致(前端本地推算, 不请求后端) */
  setInterval(sync, RESYNC_MS);
  sync();                     /* ③ 拉一次服务器时间校正差值 */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - lastSync > RESYNC_ON_SHOW_MS) { sync(); }
  });
})();
