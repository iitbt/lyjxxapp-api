/**
 * 后台图片上传(唯一实现): 富文本插图 / 封面弹窗 / 各类图标上传都走这里。
 *
 * 2026-09-20(B15): 以前两套各写一份 —— news_edit.html 里富文本的 customUpload 与
 * _image_upload_field.html 里的弹窗表单 —— 都没有前端大小/类型校验(大文件要等传完
 * 才被服务端拒)、提示也各不相同(一个 alert()、一个写进结果框, 读屏都听不到)。
 * 现在收敛成一份: 统一的校验口径、统一的失败提示(可见文案 + 无障碍播报)。
 *
 * 2026-09-20(上传进度, 本次新增): 以前只有一句静态的"上传中…", 而手机端一次上传
 * 要经历"传文件 → 服务端解码/压缩/生成缩略图"(实测手机上一次 2~5 秒, 大 PNG 更久),
 * 用户完全不知道是卡住了还是在干活。现在:
 *   · `uploadFile(..., onProgress)` 会持续回调进度(阶段 + 百分比);
 *   · `paintProgress(容器, 进度)` 把进度画进模板给的容器; 容器传 null 时用右下角浮层
 *     (富文本插图那种没有行内位置的场景);
 *   · 关键区分两个阶段: `upload`(正在传输, 有百分比) → `processing`(文件已传完,
 *     服务端在压缩/生成缩略图, 进度条转为条纹动画并显示"服务器正在处理"),
 *     否则进度条停在 100% 会让人以为卡死。
 *
 * 阈值与白名单必须与后端同源, 否则前端放行的文件仍会被服务端拒。
 * **真值只有一处**: app/core/storage.py —— 后端(app/admin/news_admin.py 的 /image_upload)
 * 已直接 import 复用, 不再各写一份。本文件里仍留着一份"图片专用"的**前端副本**
 * (见下方 MAX_BYTES / ALLOWED_EXT), 改白名单或上限时**必须同步这一处**, 否则会出现
 * "前端放行、服务端拒"或反向的"前端先把合法文件拒掉":
 *   大小上限  storage.MAX_IMAGE_UPLOAD_BYTES (8MB)  ←→ 本文件 MAX_BYTES
 *   扩展名    storage.UPLOAD_IMAGE_EXTS            ←→ 本文件 ALLOWED_EXT
 * ⚠️ 视频上传**不走本脚本**: 视频的白名单/上限在 storage.UPLOAD_VIDEO_EXTS /
 *    MAX_VIDEO_UPLOAD_BYTES, 目前由 news_edit.html 的 uploadVideo 自建 XHR 调用,
 *    前端不做扩展名校验(只在服务端判)。
 * (2026-09-23 修正: 原注释把"扩展名白名单"指向 app/admin/news_admin.py, 而那里早已改为
 *  import storage 的常量、本身不再有白名单 —— 属于文档漂移, 已按真值改写。)
 *
 * 用法:
 *   AdminImageUpload.uploadFile(file, 'cover', function (errMsg, data) {
 *     if (errMsg) { AdminImageUpload.reportError(errMsg, 结果容器元素); return; }
 *     // data.url 是数据库相对记录值(news_uploads/xx.png), 可直接回填并提交保存
 *   }, function (info) {                 // 可选: 进度回调
 *     AdminImageUpload.paintProgress(进度容器, info);   // 传 null 则用右下角浮层
 *   });
 *
 *   // 视频(2026-09-23): 只在末尾多给一个口径参数, 其余调用方式完全相同
 *   AdminImageUpload.uploadFile(file, 'video', cb, onProgress, { kind: 'video' });
 */
(function (global) {
  'use strict';

  // 口径预设(2026-09-23 统一"选/传"这一段): 图片(默认)与视频各一份。
  // 真值与后端同源 —— 见 app/core/storage.py 的 UPLOAD_IMAGE_EXTS / MAX_IMAGE_UPLOAD_BYTES
  // 与 UPLOAD_VIDEO_EXTS / MAX_VIDEO_UPLOAD_BYTES;**改后端常量时必须同步这里**。
  // 为什么要有视频口径: 编辑器里上传视频原先是一段自建 XHR, 与这里重复了一遍
  // (进度/CSRF/错误提示各写一份)。现在视频也能走本脚本, 差别只在 opts。
  var PRESETS = {
    image: { kind: 'image', label: '图片',
             exts: ['jpg', 'jpeg', 'png', 'gif', 'webp'], maxBytes: 8 * 1024 * 1024,
             timeoutMs: 2 * 60 * 1000 },
    // 视频单独给更长的超时: 上限 64MB, 弱网手机上 2 分钟可能真的不够(原先视频那段自建 XHR
    // 干脆没有超时, 统一到本脚本后必须把这条补上, 否则会把"传得慢"错判成"上传超时")
    video: { kind: 'video', label: '视频',
             exts: ['mp4', 'mov', 'm4v', 'webm'], maxBytes: 64 * 1024 * 1024,
             timeoutMs: 10 * 60 * 1000 }
  };
  // 默认口径 = 图片。历史调用不带 opts, 行为与改动前逐字一致。
  var MAX_BYTES = PRESETS.image.maxBytes;
  var ALLOWED_EXT = PRESETS.image.exts;

  /** 把调用方的 opts 与预设合并: 不传 opts / 传空 → 图片口径(向后兼容)。 */
  function resolveOpts(opts) {
    var o = opts || {};
    var preset = PRESETS[o.kind === 'video' ? 'video' : 'image'];
    return {
      kind: preset.kind,
      label: preset.label,
      exts: (o.exts && o.exts.length) ? o.exts : preset.exts,
      maxBytes: (o.maxBytes > 0) ? o.maxBytes : preset.maxBytes,
      timeoutMs: (o.timeoutMs > 0) ? o.timeoutMs : preset.timeoutMs
    };
  }
  var ENDPOINT = '/admin/image_upload';
  // 超时口径(原先这里是唯一的 TIMEOUT_MS)已随类型放进上面的 PRESETS:
  // 图片 2 分钟(弱网 + 服务端压缩, 手机可能好几秒) / 视频 10 分钟。
  // 超时后由 xhr.ontimeout 给出明确提示, 不会一直转圈。
  var FLOAT_ID = 'imageUploadFloatProgress';

  function extOf(name) {
    var lower = String(name || '').toLowerCase();
    return lower.indexOf('.') === -1 ? '' : lower.split('.').pop();
  }
  function humanSize(bytes) {
    return bytes >= 1024 * 1024
      ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
      : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  /** 进度文案: 阶段 → 给用户看的一句话。 */
  function phaseText(info) {
    var percent = Math.max(0, Math.min(100, Math.round(info.percent || 0)));
    if (info.phase === 'processing') {
      // 视频不压缩/不生成缩略图, 所以这里不写具体在做什么, 只说明"还在服务器处理"
      return (info.label || '文件') + '已上传，服务器正在处理…（大文件可能需要几秒，请勿关闭页面）';
    }
    if (info.phase === 'done') { return '上传成功'; }
    if (info.phase === 'error') { return info.text || '上传失败'; }
    var size = info.total ? '（' + humanSize(info.total) + '）' : '';
    return '正在上传 ' + percent + '%' + size;
  }

  /** 把进度写进一个"进度条容器"(模板里带 [data-upload-progress] 的那个 div)。 */
  function paintInto(container, info) {
    if (!container) { return; }
    container.classList.remove('d-none');
    // 结构见 _image_upload_field.html: .progress > .progress-bar + [data-upload-progress-text]
    var wrap = container.querySelector('.progress') || container;
    var bar = container.querySelector('.progress-bar');
    var text = container.querySelector('[data-upload-progress-text]');
    var percent = Math.max(0, Math.min(100, Math.round(info.percent || 0)));
    if (bar) {
      bar.style.width = percent + '%';
      bar.className = 'progress-bar';
      if (info.phase === 'processing') {
        bar.className += ' progress-bar-striped progress-bar-animated bg-secondary';
      } else if (info.phase === 'done') {
        bar.className += ' bg-success';
      } else if (info.phase === 'error') {
        bar.className += ' bg-danger';
      }
      bar.setAttribute('aria-valuenow', String(percent));
    }
    if (wrap && wrap.setAttribute) { wrap.setAttribute('aria-valuenow', String(percent)); }
    if (text) { text.textContent = phaseText(info); }
  }

  /** 没有行内进度容器时的兜底: 右下角浮层(富文本插图上传用)。 */
  function floatEl() {
    var el = document.getElementById(FLOAT_ID);
    if (el) { return el; }
    el = document.createElement('div');
    el.id = FLOAT_ID;
    el.className = 'upload-progress-float card shadow-sm d-none';
    el.innerHTML =
      '<div class="card-body p-2">' +
      '  <div class="progress mb-1" role="progressbar" aria-label="上传进度"' +
      '       aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" style="height:6px">' +
      '    <div class="progress-bar" style="width:0%"></div>' +
      '  </div>' +
      '  <div class="small text-muted" data-upload-progress-text aria-live="polite"></div>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }

  var AdminImageUpload = {
    presets: PRESETS,        // {image:{exts,maxBytes,label}, video:{...}} —— 页面用来自动写提示文案
    maxBytes: MAX_BYTES,     // 兼容旧引用: 图片口径
    allowedExt: ALLOWED_EXT, // 兼容旧引用: 图片口径

    /** 前端预校验: 返回空串表示通过, 否则是给用户看的提示。
     *  @param {File} file
     *  @param {{kind?:string, exts?:string[], maxBytes?:number}} [opts] 不传 = 图片口径 */
    validate: function (file, opts) {
      var opt = resolveOpts(opts);
      if (!file) return '未选择文件';
      var ext = extOf(file.name);
      // 拿不到扩展名时交给服务端判定(如某些系统产出的无扩展名临时文件)
      if (ext && opt.exts.indexOf(ext) === -1) {
        return '仅支持 ' + opt.exts.join(' / ').toUpperCase() + ' ' + opt.label;
      }
      if (file.size && file.size > opt.maxBytes) {
        return opt.label + '大小 ' + humanSize(file.size) + '，超过 ' + humanSize(opt.maxBytes)
          + ' 上限' + (opt.kind === 'video'
            ? '，请压缩；手机本地更大的视频可拷进服务器后用「素材库」直接引用'
            : '，请压缩后再上传');
      }
      return '';
    },

    /** 统一的失败提示: 写入可见的结果框(如有) + 无障碍播报 + 控制台。 */
    reportError: function (msg, resultEl) {
      if (resultEl) {
        resultEl.className = 'mt-2 small text-danger';
        resultEl.textContent = msg;
      }
      if (global.a11yAnnounce) { global.a11yAnnounce(msg); }
      if (global.console && global.console.error) { global.console.error('[image_upload] ' + msg); }
    },

    /**
     * 画进度: 容器传 null/取不到时自动用右下角浮层。
     * @param {Element|null} container 模板里的 [data-upload-progress] 容器
     * @param {{phase:string, percent:number, total?:number, text?:string}} info
     */
    paintProgress: function (container, info) {
      var box = container;
      if (!box) {
        box = floatEl();
        box.classList.remove('d-none');
      }
      paintInto(box, info || {});
    },

    /** 结束时收起浮层(浮层会自动消失, 行内容器保留最终状态给用户看)。 */
    finishProgress: function (container, ok) {
      if (!container) {
        var el = document.getElementById(FLOAT_ID);
        if (el) {
          global.setTimeout(function () { el.classList.add('d-none'); }, ok ? 800 : 4000);
        }
      }
    },

    /**
     * 提交按钮的"处理中"态: 与 base.html 里整页提交的观感完全一致
     * (禁用 + spinner + "处理中…"), 上传结束由返回的函数复位。
     *
     * ⚠️ 必须"接管"而不是"新建": base.html 的全局提交处理器(base.html 里两段
     * document 级监听)会**先于**本脚本执行 —— 它已经把按钮禁用并换成 spinner 了。
     * 所以这里即使发现按钮已是禁用态, 也必须返回一个"能还原"的句柄; 否则上传失败后
     * 按钮会永远卡在"处理中…"(用户只能刷新页面)。
     * 还原用的原始标签取自 btn.dataset.originHtml(该属性由 base.html 写入, 两边共用一份)。
     */
    beginBusy: function (btn) {
      if (!btn) { return { end: function () {} }; }
      var originHtml = btn.dataset.originHtml || btn.innerHTML;
      btn.dataset.originHtml = originHtml;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span> 处理中…';
      return {
        end: function () {
          btn.disabled = false;
          btn.innerHTML = originHtml;
        }
      };
    },

    /**
     * 上传一个文件(XHR: 只有 XHR 能拿到上传进度, fetch 不支持)。
     * @param {File} file
     * @param {string} purpose cover=封面/轮播/图标(预生成缩略图) content=正文插图(不生成)
     *                  video=视频(后端按扩展名落视频分支, 不做缩略图、不重编码)
     * @param {Function} cb (errMsg, data)
     * @param {Function} [onProgress] 进度回调, 形参 {phase, percent, loaded, total}
     * @param {{kind?:string, exts?:string[], maxBytes?:number}} [opts] 不传 = 图片口径
     */
    uploadFile: function (file, purpose, cb, onProgress, opts) {
      var opt = resolveOpts(opts);
      var errMsg = this.validate(file, opts);
      if (errMsg) { cb(errMsg, null); return; }
      var notify = function (info) {
        if (typeof onProgress !== 'function') { return; }
        info.label = opt.label;   // 进度文案用它区分"图片/视频"
        try { onProgress(info); } catch (e) { /* 进度回调出错不影响上传本身 */ }
      };
      var fd = new FormData();
      fd.append('file', file);
      fd.append('purpose', purpose || 'cover');
      notify({ phase: 'upload', percent: 0, loaded: 0, total: file.size || 0 });

      var xhr = new XMLHttpRequest();
      xhr.open('POST', ENDPOINT, true);
      xhr.timeout = opt.timeoutMs;   // 超时口径随类型(图片 2 分钟 / 视频 10 分钟)
      // CSRF: multipart 请求体服务端取不到令牌字段, 必须走 X-CSRF-Token 头
      // (生产 ADMIN_CSRF_ENFORCE=true 时漏带会被 403, 表现为"上传没反应")
      var headers = global.csrfHeaders ? global.csrfHeaders() : {};
      for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k)) { xhr.setRequestHeader(k, headers[k]); }
      }
      xhr.upload.onprogress = function (e) {
        if (!e.lengthComputable) { notify({ phase: 'upload', percent: 0, loaded: e.loaded, total: 0 }); return; }
        notify({
          phase: 'upload', loaded: e.loaded, total: e.total,
          percent: Math.round((e.loaded / e.total) * 100)
        });
      };
      // 字节发完 ≠ 上传完成: 服务端还要解码/压缩/生成缩略图(手机上可 1~3 秒),
      // 这里切到 processing, 进度条转为"条纹动画", 明确告诉用户还在处理。
      xhr.upload.onload = function () {
        notify({ phase: 'processing', percent: 100, total: file.size || 0 });
      };
      xhr.onload = function () {
        var d = null;
        try { d = JSON.parse(xhr.responseText); } catch (e) { d = null; }
        if (!d) {
          // 403 通常是令牌/登录态问题(页面停留过久), 单独给一句可操作的提示
          cb(xhr.status === 403
            ? '校验失败或登录已过期，请刷新页面后重试'
            : '上传失败（服务端返回 ' + xhr.status + '）', null);
          return;
        }
        if (!d.success) { cb((d && d.message) || '上传失败', null); return; }
        cb(null, d);
      };
      xhr.onerror = function () { cb('上传失败，请检查网络后重试', null); };
      xhr.ontimeout = function () { cb('上传超时，请检查网络后重试', null); };
      xhr.onabort = function () { cb('上传已取消', null); };
      xhr.send(fd);
    }
  };

  global.AdminImageUpload = AdminImageUpload;
})(window);
