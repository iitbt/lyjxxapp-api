// 正文富文本编辑器(wangEditor): 只服务后台编辑页, 页面没有 #contentEditor 时整体空转
// 三件事: ① 初始化编辑器与工具栏; ② 内容在"浏览器形态(根路径)"与"库内形态(相对路径)"之间转换;
// ③ 给「本地上传」与「素材库」提供插入落点(MediaInsertFromUpload / MediaInsertFromLibrary)
// 资源来自 /admin/static/vendor/wangeditor/(自托管, 不走 CDN; 加载失败会回退普通文本域并给出提示)
(function () {
  'use strict';

  var editorEl = document.getElementById('contentEditor');
  var toolbarEl = document.getElementById('contentToolbar');
  var rawEl = document.getElementById('contentRaw');
  if (!editorEl || !toolbarEl || !rawEl) { return; }

  var editor = null;
  // 站内素材目录由页面下发(真值在 core/storage.js 的 MEDIA_PREFIXES, 与素材库弹窗读的是同一份清单)
  var mediaPrefixes = String(editorEl.getAttribute('data-media-prefixes') || 'image/,video/,news_uploads/')
    .split(',').map(function (item) { return item.trim(); }).filter(Boolean);
  // 拼进正则前先转义, 免得目录名里的特殊字符把表达式弄坏
  var alt = mediaPrefixes.map(function (item) { return item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|');
  var IMG_TAG_RE = /<img\b[^>]*>/gi;
  // 相对记录值(news_uploads/a.png / image/a.png) → 站点根路径, 以及反过来的还原
  var REL_ATTR_RE = new RegExp('(\\s(?:src|data-href)\\s*=\\s*["\'])((' + alt + ')[^"\']*)(["\'])', 'gi');
  var ABS_ATTR_RE = new RegExp('(\\s(?:src|data-href)\\s*=\\s*["\'])/(' + alt + ')([^"\']*)(["\'])', 'gi');

  // 编辑器解析"顶层连续 <img> 后面跟 <video>"时会把图片丢掉、甚至抛 path 越界:
  // 回显时把顶层图片各包一层 <p>(解析就正常了), 保存时再把"只有一张图"的段落拆回顶层 —— 库内格式不变
  var LONE_IMG_P_RE = /<p\b[^>]*>(?:\s|<br\s*\/?>)*<img\b[^>]*>(?:\s|<br\s*\/?>)*<\/p>/gi;

  function wrapTopLevelImages(html) {
    if (html.indexOf('<img') < 0) { return html; }
    var box = document.createElement('div');
    box.innerHTML = html;
    var imgs = box.querySelectorAll(':scope > img');
    for (var i = 0; i < imgs.length; i += 1) {
      var wrap = document.createElement('p');
      imgs[i].parentNode.insertBefore(wrap, imgs[i]);
      wrap.appendChild(imgs[i]);
    }
    return box.innerHTML;
  }

  /** 回显用: 站内相对图片补前导 "/"(编辑页在 /admin/ 下, 相对地址会取错), 并做上面那层段落包装。 */
  function toEditorPreview(html) {
    var fixed = String(html || '').replace(IMG_TAG_RE, function (tag) {
      return tag.replace(REL_ATTR_RE, '$1/$2$4');
    });
    return wrapTopLevelImages(fixed);
  }

  /** 入库用: 拆掉"只有一张图"的段落包装, 再把根路径图片还原成相对记录值(库内只存相对路径)。 */
  function toStoredHtml(html) {
    var plain = String(html || '').replace(LONE_IMG_P_RE, function (whole) {
      return (/<img\b[^>]*>/i.exec(whole) || [''])[0];
    });
    return plain.replace(IMG_TAG_RE, function (tag) {
      return tag.replace(ABS_ATTR_RE, '$1$2$3$4');
    });
  }

  /** 编辑过程中新粘进来/手填的相对地址图片也即时可见(否则要刷新重进才看得到)。 */
  function fixEditorImgPaths(container) {
    if (!container) { return; }
    var imgs = container.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i += 1) {
      ['src', 'data-href'].forEach(function (attr) {
        var value = imgs[i].getAttribute(attr);
        if (value && mediaPrefixes.some(function (prefix) { return value.indexOf(prefix) === 0; })) {
          imgs[i].setAttribute(attr, '/' + value);
        }
      });
    }
  }

  function watchEditorImgPaths() {
    if (!window.MutationObserver) { return; }
    fixEditorImgPaths(editorEl);
    var timer = null;
    var observer = new MutationObserver(function () {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(function () { timer = null; fixEditorImgPaths(editorEl); }, 30);
    });
    observer.observe(editorEl, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'data-href']
    });
  }

  /** 编辑器不可用(资源没加载/初始化失败)时的兜底: 露出普通文本域 + 说明原因, 保证还能编辑保存。 */
  function fallbackToTextarea(reason) {
    editorEl.classList.add('d-none');
    toolbarEl.classList.add('d-none');
    rawEl.classList.remove('d-none');
    rawEl.setAttribute('required', 'required');
    var warning = document.createElement('div');
    warning.className = 'alert alert-warning py-2 small';
    warning.setAttribute('role', 'alert');
    warning.textContent = '富文本编辑器未启用（' + reason + '），已退回普通文本域：可直接粘贴 HTML，保存与前台显示不受影响。'
      + '若需要编辑器，请确认部署包里的 /admin/static/vendor/wangeditor/ 资源可访问（见 DEPLOY.md「富文本编辑器」）。';
    if (toolbarEl.parentNode) { toolbarEl.parentNode.insertBefore(warning, toolbarEl); }
  }

  /** 工具栏「上传图片 / 上传视频」的原生入口: 与弹窗共用同一个上传器与同一个接口。 */
  function customUpload(purpose, kind) {
    return function (file, insertFn) {
      window.AdminImageUpload.uploadFile(file, purpose, function (errMsg, data) {
        if (errMsg) {
          window.AdminImageUpload.reportError(errMsg);
          window.AdminImageUpload.paintProgress(null, { phase: 'error', percent: 100, text: errMsg });
          window.AdminImageUpload.finishProgress(null, false);
          return;
        }
        // 交给编辑器的一律是站点根路径(编辑页在 /admin/ 下也能显示/播放), 入库时再还原成相对记录值
        var url = '/' + String(data.url || '').replace(/^\/+/, '');
        if (kind === 'video') { insertFn(url, ''); } else { insertFn(url, '', url); }
        window.AdminImageUpload.paintProgress(null, { phase: 'done', percent: 100 });
        window.AdminImageUpload.finishProgress(null, true);
      }, function (info) {
        // 编辑器内没有行内进度的位置: 传 null 用右下角浮层
        window.AdminImageUpload.paintProgress(null, info);
      }, kind === 'video' ? { kind: 'video' } : undefined);
    };
  }

  function initEditor() {
    if (!window.wangEditor || !window.wangEditor.createEditor) {
      fallbackToTextarea('编辑器资源未加载');
      return;
    }
    if (!window.AdminImageUpload) {
      fallbackToTextarea('上传脚本未加载');
      return;
    }
    try {
      editor = window.wangEditor.createEditor({
        selector: editorEl,
        html: toEditorPreview(rawEl.value || '<p><br></p>'),
        mode: 'default',
        config: {
          placeholder: '请输入正文内容…',
          MENU_CONF: {
            uploadImage: { customUpload: customUpload('content', 'image') },
            uploadVideo: { customUpload: customUpload('video', 'video') }
          }
        }
      });
      window.wangEditor.createToolbar({ editor: editor, selector: toolbarEl, mode: 'default', config: {} });
      watchEditorImgPaths();
    } catch (error) {
      console.error('富文本编辑器初始化失败, 已退回文本域', error);
      editor = null;
      fallbackToTextarea('初始化失败: ' + ((error && error.message) || '未知错误'));
    }
  }

  // 提交前把编辑器内容同步回隐藏文本域(name=content), 并还原成库内形态
  if (rawEl.form) {
    rawEl.form.addEventListener('submit', function () {
      if (editor) {
        var html = editor.getHtml() || '';
        rawEl.value = toStoredHtml(html.trim() ? html : '<p><br></p>');
      } else if (rawEl.value && rawEl.value.trim()) {
        rawEl.value = toStoredHtml(rawEl.value.trim());
      } else {
        rawEl.value = '<p><br></p>';
      }
    });
  }

  /** 失败原因写回素材库弹窗(弹窗是共享脚本的, 通过它的小 API 提示)。 */
  function hint(text, isError) {
    if (window.MediaLibrary) { window.MediaLibrary.hint(text, isError); }
  }

  /** 插入失败的提示: 素材库弹窗与上传弹窗各写一份, 用户在哪个弹窗操作就能看到。 */
  function reportInsertFailure(text) {
    hint(text, true);
    var box = document.querySelector('.modal.show [data-upload-result]');
    if (box) {
      box.className = 'mt-2 small text-danger';
      box.textContent = text;
    }
  }

  /**
   * 插一个节点并确认真的插进去了。
   * 编辑器对"失效选区"是**静默失败**的(上一次插入后编辑器会留一个旧选区, restoreSelection 把它还原回来,
   * 这时 insertNode 不报错也不生效) —— 所以插完比对模型, 没插进去就聚焦后重试一次。
   */
  function insertNode(node) {
    var before = JSON.stringify(editor.children);
    if (typeof editor.restoreSelection === 'function') { editor.restoreSelection(); }
    editor.insertNode(node);
    if (JSON.stringify(editor.children) !== before) { return true; }
    if (typeof editor.focus === 'function') { editor.focus(); }
    editor.insertNode(node);
    return JSON.stringify(editor.children) !== before;
  }

  /** 把素材插到正文光标处: 图片与视频各用编辑器原生节点, 任何失败都在弹窗里写明原因。 */
  function mediaInsertIntoEditor(item) {
    var url = '/' + String(item.path || '').replace(/^\/+/, '');
    var isVideo = item.kind === 'video';
    if (!editor) {
      // 没有编辑器(已回退文本域): 直接写库内形态的标签, 保存链路照样能处理
      rawEl.value = (rawEl.value || '') + (isVideo
        ? '<wx-video src="' + item.path + '" controls="true" show-center-play-btn="true" show-play-btn="true" object-fit="cover"></wx-video>'
        : '<img src="' + item.path + '" alt="">');
      return true;
    }
    try {
      var placed = isVideo
        ? insertNode({ type: 'video', src: url, poster: '', width: 'auto', height: 'auto', children: [{ text: '' }] })
        : insertNode({ type: 'image', src: url, alt: '', url: '', href: '', style: { width: '' }, children: [{ text: '' }] });
      if (placed) { insertNode({ type: 'paragraph', children: [{ text: '' }] }); }
      if (typeof editor.focus === 'function') { editor.focus(); }
      if (!placed) {
        reportInsertFailure('插入失败：编辑器当前没有可用的插入位置，请在正文里点一下光标后再试。');
        return false;
      }
      return true;
    } catch (error) {
      console.error('[素材库] 插入' + (isVideo ? '视频' : '图片') + '节点失败:', error);
      // 视频还有一条 HTML 兜底; 图片没有(编辑器会静默丢弃 dangerouslyInsertHtml 里的 img)
      if (isVideo && typeof editor.dangerouslyInsertHtml === 'function') {
        try {
          editor.dangerouslyInsertHtml('<video src="' + url + '" controls playsinline preload="metadata"></video><p><br></p>');
          if (typeof editor.focus === 'function') { editor.focus(); }
          return true;
        } catch (error2) {
          console.error('[素材库] 回退插入也失败:', error2);
        }
      }
      reportInsertFailure('插入失败：' + ((error && error.message) || '编辑器拒绝了这次操作')
        + (isVideo ? '。可改用工具栏「视频 → 上传视频」，或把路径填进上方「视频地址」字段。'
          : '。可改用工具栏「图片 → 上传图片」，或把路径填进封面图字段。'));
      return false;
    }
  }

  /** 插入并收尾(关弹窗 + 播报); 失败原因已写回弹窗。 */
  function insertAndClose(path, kind) {
    if (!path) { return; }
    if (!mediaInsertIntoEditor({ path: path, kind: kind })) { return; }
    if (window.MediaLibrary) { window.MediaLibrary.close(); }
    if (window.a11yAnnounce) { window.a11yAnnounce((kind === 'video' ? '视频' : '图片') + '已插入正文'); }
  }

  // 两个落点: 素材库点选(共享脚本在 editor 模式下回调) / 正文本地上传(上传弹窗 data-insert="editor")
  window.MediaInsertFromLibrary = function (path, kind) { insertAndClose(path, kind); };
  window.MediaInsertFromUpload = function (path, kind) {
    insertAndClose(path, kind === 'video' ? 'video' : 'image');
  };

  initEditor();
})();
