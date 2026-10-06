// 静态页外壳: 移动端可读、零外部依赖(不引 CDN, 免费套餐下也不额外耗流量)
// 两套外壳都注入站点图标: pageShell/contentPage 是极简内容页, statusPage 是服务状态页(/)

/** 站点图标: 所有页面都必须带上(路径固定 /favicon.ico, 由入口 main.js 直出, 见 DEPLOY.md)。 */
export const FAVICON_LINK = '<link rel="icon" href="/favicon.ico" type="image/x-icon">';

const STYLE = [
  '*{box-sizing:border-box}',
  'body{margin:0;padding:20px 16px 48px;font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2329;background:#f7f8fa}',
  'header{font-size:20px;font-weight:600;margin:0 0 6px}',
  '.sub{color:#8a9099;font-size:13px;margin-bottom:18px}',
  'main{background:#fff;border-radius:12px;padding:18px 16px;white-space:pre-wrap;word-break:break-word}',
  'h1{font-size:22px;margin:0 0 4px}',
  'table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden}',
  'th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #f0f1f3;font-size:15px}',
  'th{color:#8a9099;font-weight:500;width:38%}',
  'td.ok{color:#12805c}td.bad{color:#c0392b}',
  'a.btn{display:inline-block;margin:18px 0 0;padding:12px 20px;border-radius:10px;background:#1f6feb;color:#fff;text-decoration:none;font-size:16px}',
  'footer{margin-top:22px;color:#8a9099;font-size:12px;text-align:center}',
  'ul{margin:0;padding-left:20px}'
].join('');

/** HTML 转义: 全站唯一实现(页面外壳与各页面模块都从这里引)。 */
export function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function pageShell(title, body, footer = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
${FAVICON_LINK}
<style>${STYLE}</style>
</head>
<body>
${body}
${footer ? `<footer>${escapeHtml(footer)}</footer>` : ''}
</body>
</html>`;
}

// 状态页 / 下载页 / 协议 / 隐私 都复用这个内容页
export function contentPage(title, text, footer = '') {
  return pageShell(title, `<h1>${escapeHtml(title)}</h1><main>${escapeHtml(text)}</main>`, footer);
}

// ==== 服务状态页(对照旧站 templates/status.html): 深色渐变 + 卡片 + 统计小卡 + 六列表格 ====
const STATUS_STYLE = [
  '*{box-sizing:border-box;margin:0;padding:0}',
  'body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:linear-gradient(135deg,#1a2332,#24344d);color:#e6edf5;min-height:100vh;padding:24px}',
  '.wrap{max-width:860px;margin:0 auto}',
  '.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:22px 26px;margin-bottom:18px;backdrop-filter:blur(4px)}',
  'h1{font-size:22px;margin-bottom:6px}',
  'h2{font-size:15px;color:#93b4e0;margin-bottom:12px}',
  '.muted{color:#9fb2c9;font-size:13px}',
  '.pill{display:inline-block;background:#22c55e;color:#06210f;border-radius:20px;padding:2px 12px;font-size:13px;margin-left:8px}',
  '.pill.bad{background:#f87171;color:#2b0b0b}',
  '.stats{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px}',
  '.stat{flex:1 1 130px;background:rgba(255,255,255,.05);border-radius:8px;padding:12px;text-align:center}',
  '.stat b{font-size:22px;color:#7dd3fc;display:block}',
  '.stat span{font-size:12px;color:#9fb2c9}',
  'table{width:100%;border-collapse:collapse;font-size:13px}',
  'th,td{text-align:left;padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.08)}',
  'th{color:#93b4e0;font-weight:500}',
  '.ok{color:#4ade80}.bad{color:#f87171}',
  'a{color:#7dd3fc;text-decoration:none}',
  'code{background:rgba(255,255,255,.08);padding:1px 6px;border-radius:4px}',
  '.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}',
  // 手机端适配只作用于 ≤640px, 桌面端规则一条都不动
  '@media (max-width:640px){body{padding:16px 12px}h1{font-size:19px}.card{padding:16px 14px;margin-bottom:14px}'
  + '.table-scroll table{min-width:520px}code{word-break:break-all}}'
].join('');

/** 服务状态页: 统计与依赖数据由调用方(service_status.js)准备好, 这里只负责渲染。 */
export function statusPage(options = {}) {
  const stats = (options.stats || [])
    .map(([value, label]) => `<div class="stat"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`)
    .join('');
  const depRows = (options.deps || []).map((dep, index) => `<tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(dep.name)}</td>
        <td>${escapeHtml(dep.type)}</td>
        <td>${dep.active ? '✔' : '-'}</td>
        <td>${escapeHtml(dep.responseTime)} ms</td>
        <td class="${dep.ok ? 'ok' : 'bad'}">${escapeHtml(dep.status)}</td>
      </tr>`).join('');
  const overall = options.overallOk
    ? '<span class="ok">正常</span>'
    : `<span class="bad">异常</span>${options.overallMessage ? ` - ${escapeHtml(options.overallMessage)}` : ''}`;
  const version = String(options.version || '');
  const mediaLine = options.mediaBase
    ? `<p class="muted" style="margin-top:8px">素材域: <code>${escapeHtml(options.mediaBase)}</code></p>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.name)} - 服务状态</title>
${FAVICON_LINK}
<style>${STATUS_STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>${escapeHtml(options.name)} <span class="pill${options.overallOk ? '' : ' bad'}">${escapeHtml(options.status)}</span></h1>
    <div class="muted">服务器时间 <span id="server-time" data-live="clock">${escapeHtml(options.serverTime)}</span>${version ? ` · 服务版本 v${escapeHtml(version)}` : ''}</div>
    <div class="muted">进程启动时间 <span id="process-start-time">${escapeHtml(options.startedAt || '-')}</span>${options.startedAtNote ? ` <span class="muted">${escapeHtml(options.startedAtNote)}</span>` : ''}</div>
    <div class="muted" style="margin-top:8px">${escapeHtml(options.description)}</div>
    <span hidden data-live-anchor="${escapeHtml(options.wallMs)}"></span>
  </div>

  <div class="card">
    <h2>数据统计</h2>
    <div class="stats">${stats}</div>
  </div>

  <div class="card">
    <h2>依赖状态监控</h2>
    <div class="table-scroll">
    <table>
      <tr><th>序号</th><th>配置</th><th>类型</th><th>当前使用</th><th>响应时间</th><th>状态</th></tr>
      ${depRows}
    </table>
    </div>
    <div class="muted" style="margin-top:10px">总连接状态: ${overall}</div>
  </div>

  <div class="card">
    <h2>使用说明</h2>
    <p class="muted">${escapeHtml(options.description)}</p>
    <p class="muted" style="margin-top:8px">本服务为狼牙极限运动笔记微信小程序提供后端 API 支持。</p>
    <p class="muted" style="margin-top:8px">
      常用接口: <code>/user/login</code> · <code>/news/list</code> · <code>/news/detail?id=1</code> ·
      <code>/content/get_banners</code> ·
      <a href="/apitest">接口测试 /apitest</a> ·
      <a href="/test">服务器状态 /test</a>
    </p>
${mediaLine}
  </div>
</div>
<script src="/admin/static/js/live_time.js?v=${encodeURIComponent(version)}"></script>
</body>
</html>`;
}
