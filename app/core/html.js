// 静态页外壳: 移动端可读、零外部依赖(不引 CDN, 免费套餐下也不额外耗流量)
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

export function statusPage(rows, footer = '') {
  const body = rows
    .map(([label, value, state]) => `<tr><th>${escapeHtml(label)}</th><td class="${state || ''}">${escapeHtml(value)}</td></tr>`)
    .join('');
  return pageShell('服务状态', `<header>服务状态</header><table>${body}</table>`, footer);
}
