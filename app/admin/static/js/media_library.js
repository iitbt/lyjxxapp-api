/**
 * 素材库弹窗(「从素材库选择」)的**唯一实现**(2026-09-23 抽出): 服务笔记编辑(news_edit)
 * 与专题编辑(topic_edit)两个页面 —— 以前只写在 news_edit 里, 别的页面要用就得复制一份。
 *
 * 页面需要做两件事:
 *   ① 引入标记(模板 _media_library_modal.html 已包含本脚本, 页面里 include 那个文件即可);
 *   ② 若该页面需要"把素材插进富文本", 提供 window.MediaInsertFromLibrary(path, kind);
 *      只往输入框里写值(input 模式)的页面什么都不用提供。
 *
 * 打开弹窗的按钮上用 data-* 说明本次行为(见 _media_library_modal.html 顶部注释):
 *   data-media-mode input|editor / data-media-kind image|video /
 *   data-media-lock-kind "1" / data-media-target / data-media-preview
 */
(function () {
  'use strict';

  var mediaModal = document.getElementById('mediaLibraryModal');
  var mediaListEl = document.getElementById('mediaLibraryList');
  var mediaQueryEl = document.getElementById('mediaLibraryQuery');
  var mediaHintEl = document.getElementById('mediaLibraryHint');
  var mediaManualEl = document.getElementById('mediaLibraryManual');
  var mediaKindBtns = mediaModal ? mediaModal.querySelectorAll('[data-media-kind-btn]') : [];
  var mediaKindGroupEl = document.getElementById('mediaLibraryKindSwitch');
  var mediaTitleEl = document.getElementById('mediaLibraryModalLabel');
  var mediaMode = 'editor';   // 由打开弹窗的按钮决定
  var mediaKind = 'image';    // 当前分类(图片/视频): 由按钮决定, 弹窗内可切换
  // 2026-09-23(v2.3.1): 分类可被"锁定" —— 「图片素材库」只显示图片、「视频素材库」只显示视频。
  // 锁定时弹窗里连分类切换按钮都隐藏, 保证"按钮名字写了哪一类, 弹窗里就只有哪一类"。
  var mediaKindLocked = false;
  var mediaTarget = '';       // mode=input: 目标输入框选择器
  var mediaPreview = '';      // mode=input: 可选, 目标预览图选择器
  // 素材目录清单由模板下发(真值在 core/storage.js), 手工填写时用它判断"写全了没有"
  var mediaPrefixes = String((mediaModal && mediaModal.getAttribute('data-media-prefixes')) || 'image/,video/,news_uploads/')
    .split(',').map(function (p) { return p.trim(); }).filter(Boolean);
  var mediaLoaded = {};       // {kind: true}: 每个分类成功拉过一次
  // 2026-09-23(v2.3.2 修): 按分类缓存**数据**(不只是"拉没拉过"的标记)。
  // 为什么必须存数据: 原实现只记 mediaLoaded[kind], 于是"切回已拉过的分类"时**跳过加载**,
  // 而列表 DOM 里还留着上一个分类的行 —— 表现为"点图片素材库却是视频、点视频素材库却是图片",
  // 必须手动点刷新(刷新直接调 mediaLoad, 不看这个标记)才恢复。现在改为: 有缓存就重画缓存,
  // 没缓存才请求; 请求响应回来时还会校验分类是否仍是发起时那一类(丢弃过期响应)。
  var mediaItems = {};        // {kind: {items, accept}}  仅在无关键词筛选时缓存

  /** 关掉素材库弹窗(页面的插入函数也用得上, 见文件末尾的 window.MediaLibrary)。 */
  function closeModal() {
    if (mediaModal && window.bootstrap && window.bootstrap.Modal) {
      var inst = window.bootstrap.Modal.getInstance(mediaModal);
      if (inst) { inst.hide(); }
    }
  }

  function mediaHumanSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) { return n + ' B'; }
    var units = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n = n / 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + ' ' + units[i];
  }

  function mediaSetHint(text, isError) {
    if (!mediaHintEl) { return; }
    mediaHintEl.className = isError ? 'small text-danger mb-2' : 'small text-muted mb-2';
    mediaHintEl.textContent = text || '';
  }

  // 用 DOM 建行(不用字符串拼 HTML): 文件名来自磁盘, 可能含引号/中文, 交给 textContent 最稳
  function mediaRow(item) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'list-group-item list-group-item-action d-flex align-items-center gap-2';
    btn.setAttribute('data-media-path', item.path || '');
    btn.setAttribute('data-media-kind', item.kind || '');
    // 图片多给一张缩略图(视频不做抽帧: 那要额外依赖 ffmpeg): 一眼认出是哪张, 少点错
    if (item.kind === 'image' && item.path) {
      var thumb = document.createElement('img');
      thumb.className = 'media-thumb';
      thumb.alt = '';
      // 2026-09-30(性能): 优先用后端下发的缩略图 —— 素材单张可达数十 MB, 直取原图时
      // 一个列表要等几十秒(日志实测单张 65~83 秒)。item.thumb 为空说明还没生成缩略图,
      // 此时回退原图, 行为与改前完全一致。站点根路径: 编辑页在 /admin/ 下, 不加 '/' 取不到图。
      thumb.src = '/' + (item.thumb || item.path);
      thumb.loading = 'lazy';
      thumb.onerror = function () { this.style.visibility = 'hidden'; };
      btn.appendChild(thumb);
    }
    var left = document.createElement('span');
    left.className = 'text-break small flex-grow-1';
    left.textContent = item.name || '';
    if (item.dir) {
      var badge = document.createElement('span');
      badge.className = 'badge bg-secondary ms-1';
      badge.textContent = item.dir;
      left.appendChild(badge);
    }
    var right = document.createElement('span');
    right.className = 'text-muted small flex-shrink-0';
    right.textContent = mediaHumanSize(item.size);
    btn.appendChild(left);
    btn.appendChild(right);
    return btn;
  }

  function mediaRender(items) {
    if (!mediaListEl) { return; }
    mediaListEl.innerHTML = '';
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'text-muted small p-3';
      empty.textContent = '没有匹配的' + (mediaKind === 'image' ? '图片' : '视频')
        + '素材。可换个关键词，或改用下面的「手工填写路径」。';
      mediaListEl.appendChild(empty);
      return;
    }
    var frag = document.createDocumentFragment();
    items.forEach(function (it) { frag.appendChild(mediaRow(it)); });
    mediaListEl.appendChild(frag);
  }

  /** 列表底部那行统计/可列出扩展名的提示(按当前分类措辞)。 */
  function mediaHintFor(count, accept) {
    mediaSetHint('共 ' + count + ' 个' + (mediaKind === 'image' ? '图片' : '视频')
      + '素材（按拷入时间倒序，最多显示 500 个）。可列出：'
      + ((accept || []).join(' / ') || '—'));
  }

  /**
   * 拉取/重画当前分类的素材列表。
   * @param {boolean} [force] true = 强制重新请求(刷新按钮、改关键词、用户点分类);
   *                          false/缺省 = 无关键词且有缓存时**直接重画缓存**(不重扫目录)
   */
  function mediaLoad(force) {
    if (!mediaListEl) { return; }
    var q = mediaQueryEl && mediaQueryEl.value ? mediaQueryEl.value.trim() : '';
    // 无关键词 + 有该类缓存 → 直接重画。这一步同时修掉"列表停在上一个分类"的老问题:
    // 每次打开/切到某分类都会走到这里, 保证屏幕上的行与 mediaKind 一致。
    if (force !== true && !q && mediaItems[mediaKind]) {
      mediaRender(mediaItems[mediaKind].items);
      mediaHintFor(mediaItems[mediaKind].items.length, mediaItems[mediaKind].accept);
      return;
    }
    // 记下"这次请求是为哪一类发的": 响应回来时用它判断是否已经过期
    var reqKind = mediaKind;
    mediaSetHint('正在读取' + (reqKind === 'image' ? '图片' : '视频') + '素材目录…');
    var url = '/admin/media_library?kind=' + encodeURIComponent(reqKind)
      + (q ? '&q=' + encodeURIComponent(q) : '');
    // X-Requested-With: 与后台其它 AJAX 同口径 —— 会话过期时后端回 JSON, 而不是 302 到登录页
    fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'same-origin' })
      .then(function (resp) { return resp.json(); })
      .then(function (d) {
        if (!d || d.success !== true) { throw new Error((d && d.message) || '读取失败'); }
        // 无关键词的结果才进缓存(有关键词的结果只反映那一次筛选, 不该被下次打开复用)
        if (!q) { mediaItems[reqKind] = { items: d.items || [], accept: d.accept || [] }; }
        mediaLoaded[reqKind] = true;
        // 关键: 等待期间分类若已改变(用户切了分类/关掉又开另一类), 这次响应**只入缓存不画面**,
        // 否则会把"图片的结果"画到"视频"的标题下(这正是需要手动刷新才能恢复的根因之一)。
        if (reqKind !== mediaKind) { return; }
        mediaRender(d.items || []);
        mediaHintFor(d.total || 0, d.accept || []);
      })
      .catch(function (err) {
        if (reqKind !== mediaKind) { return; }   // 过期请求的失败也不该影响当前分类的界面
        mediaRender([]);
        mediaSetHint('读取素材失败：' + ((err && err.message) || '网络异常')
          + '（不影响使用 —— 可直接用下面的「手工填写路径」）', true);
      });
  }

  // 切换分类(图片/视频): 同一份列表结构, 只换请求参数。
  // force=true(用户主动点分类)一定重新拉; 打开弹窗时按需拉 —— 每个分类本次会话只扫一次目录。
  // 2026-09-23(v2.3.1): 分类可被按钮**锁定**(图片素材库 / 视频素材库) ——
  //   fromOpen=true 表示"这是打开弹窗时由按钮指定的分类", 锁定时只有它能生效;
  //   用户点分类按钮(不带 fromOpen)在锁定态下直接忽略。
  function mediaSetKind(kind, force, fromOpen) {
    if (mediaKindLocked && !fromOpen && kind !== mediaKind) { return; }
    mediaKind = kind === 'video' ? 'video' : 'image';
    Array.prototype.forEach.call(mediaKindBtns, function (b) {
      b.classList.toggle('active', b.getAttribute('data-media-kind-btn') === mediaKind);
    });
    // 锁定时隐藏整块分类切换 —— UI 上就不给切, 与"只显示某一类素材"的口径一致
    if (mediaKindGroupEl) { mediaKindGroupEl.classList.toggle('d-none', mediaKindLocked); }
    if (mediaManualEl) {
      // 手工填写框的示例跟随分类与目录口径(避免误导: 图片分类下的示例却是 .mp4)
      mediaManualEl.placeholder = mediaKind === 'image' ? 'image/cover_xxx.png' : 'video/video_xxx.mp4';
    }
    // 2026-09-23(v2.3.2 修): 这里原来是 `if (force || !mediaLoaded[mediaKind]) mediaLoad();` ——
    // "拉过就不再拉", 但列表 DOM 里仍留着上一个分类的行, 于是切回来时画面与分类不符。
    // 现在无条件走 mediaLoad: 有缓存就按**当前分类**重画, 没缓存才请求(见 mediaLoad 注释)。
    mediaLoad(force === true);
  }

  function mediaApply(item) {
    if (!item || !item.path) { return; }
    if (mediaMode === 'input') {
      var input = mediaTarget ? document.querySelector(mediaTarget) : null;
      if (!input) {
        mediaSetHint('插入失败：页面上找不到要填入的字段（' + (mediaTarget || '未指定目标') + '）。', true);
        return;
      }
      input.value = item.path;          // 库内相对记录值, 与「本地上传」的结果完全同口径
      input.classList.remove('is-invalid');
      input.removeAttribute('aria-invalid');
      // 封面这类字段还带预览图: 一并刷新, 否则会出现"地址换了、预览还是旧的"
      var preview = mediaPreview ? document.querySelector(mediaPreview) : null;
      if (preview) {
        // 同上: 有缩略图就用缩略图, 否则原图(站点根路径, 编辑页在 /admin/ 下)
        preview.src = '/' + (item.thumb || item.path);
        preview.classList.remove('d-none');
      }
    } else {
      // editor 模式: 交给**页面**提供的插入函数(编辑页实现为 restoreSelection + insertNode)。
      // 共享脚本不碰编辑器 —— 有编辑器就插节点、没编辑器就报错, 由页面决定。
      var insertToEditor = window.MediaInsertFromLibrary;
      if (typeof insertToEditor !== 'function') {
        mediaSetHint('这个页面没有可插入的编辑器（未提供 MediaInsertFromLibrary）。', true);
        return;
      }
      insertToEditor(item.path, item.kind === 'video' ? 'video' : 'image');
      return;   // 关弹窗与播报由页面的插入函数负责(只有它知道这次插入的结果)
    }
    closeModal();
    if (window.a11yAnnounce) {
      window.a11yAnnounce((item.kind === 'video' ? '视频' : '图片') + '地址已填入');
    }
  }

  // 手工路径归一化: 去开头斜杠与反斜杠 → 没写目录就按当前分类补(image/ 或 video/) → 拒绝 ..
  function mediaNormalizeManual(value) {
    var v = (value || '').trim().replace(/^[/\\]+/, '').replace(/\\/g, '/');
    if (!v || v.indexOf('..') >= 0) { return ''; }
    var full = false;
    for (var i = 0; i < mediaPrefixes.length; i++) {
      if (v.indexOf(mediaPrefixes[i]) === 0) { full = true; break; }
    }
    if (!full) { v = (mediaKind === 'video' ? 'video/' : 'image/') + v; }
    return v;
  }

  // 手工填写时按扩展名判断是图片还是视频 —— 不该要求用户为一个路径再选一次分类
  var MEDIA_VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'ts', 'm3u8',
                          '3gp', 'avi', 'flv', 'wmv', 'f4v'];
  function mediaKindOfPath(path) {
    var m = /\.([a-z0-9]+)$/i.exec(path || '');
    var ext = m ? m[1].toLowerCase() : '';
    return MEDIA_VIDEO_EXTS.indexOf(ext) >= 0 ? 'video' : 'image';
  }

  (function bindMediaPicker() {
    if (!mediaModal) { return; }
    // 打开弹窗: 从**触发它的按钮**上取本次行为(三个入口共用本弹窗)
    mediaModal.addEventListener('show.bs.modal', function (e) {
      var btn = e.relatedTarget;
      function attr(name) { return (btn && btn.getAttribute) ? (btn.getAttribute(name) || '') : ''; }
      mediaMode = attr('data-media-mode') === 'input' ? 'input' : 'editor';
      mediaTarget = attr('data-media-target');
      mediaPreview = attr('data-media-preview');
      // 2026-09-23(v2.3.1): 「图片素材库」/「视频素材库」这类按钮带 data-media-lock-kind,
      // 打开后只显示对应类型素材(隐藏分类切换); 标题也写明是哪一类, 免得用户以为还能切。
      mediaKindLocked = attr('data-media-lock-kind') === '1';
      mediaSetKind(attr('data-media-kind') || 'image', false, true);
      if (mediaTitleEl) {
        mediaTitleEl.textContent = mediaKindLocked
          ? (mediaKind === 'video' ? '从视频素材库选择' : '从图片素材库选择')
          : '从素材库选择';
      }
    });
    if (mediaListEl) {
      mediaListEl.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-media-path]') : null;
        if (el) {
          mediaApply({
            path: el.getAttribute('data-media-path'),
            kind: el.getAttribute('data-media-kind') || mediaKind
          });
        }
      });
    }
    Array.prototype.forEach.call(mediaKindBtns, function (b) {
      b.addEventListener('click', function () {
        if (mediaKindLocked) { return; }   // 锁定时不给切(该按钮组此时也已隐藏)
        mediaSetKind(b.getAttribute('data-media-kind-btn'), true);
      });
    });
    // 2026-09-23(v2.3.2): 这三处必须**显式传 force=true** ——
    // 直接写 addEventListener('click', mediaLoad) 会把事件对象当 force 传进去(碰巧是真值),
    // 搜索框那两处则相反(事件对象不是 true, 会走"缓存优先"而不重新请求, 筛完还是老结果)。
    var reloadBtn = document.getElementById('mediaLibraryReload');
    if (reloadBtn) { reloadBtn.addEventListener('click', function () { mediaLoad(true); }); }
    if (mediaQueryEl) {
      mediaQueryEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); mediaLoad(true); }
      });
      mediaQueryEl.addEventListener('search', function () { mediaLoad(true); });  // 「×」清空也重新拉
    }
    var manualBtn = document.getElementById('mediaLibraryManualInsert');
    if (manualBtn) {
      manualBtn.addEventListener('click', function () {
        var rel = mediaNormalizeManual(mediaManualEl ? mediaManualEl.value : '');
        if (!rel) {
          mediaSetHint('路径不合法：应为 ' + mediaPrefixes.join(' 或 ') + ' 下的相对路径，且不能包含 ..', true);
          return;
        }
        mediaApply({ path: rel, kind: mediaKindOfPath(rel) });
      });
    }
    if (mediaManualEl && manualBtn) {
      mediaManualEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); manualBtn.click(); }
      });
    }
  })();

  // 给页面用的小 API(编辑页"插入失败"时把原因写回弹窗、插完关弹窗)
  window.MediaLibrary = {
    hint: mediaSetHint,
    close: closeModal,
    kindOfPath: mediaKindOfPath
  };
})();
