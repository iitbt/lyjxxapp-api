// 数据库工具 / 数据库管理 —— 逐条对齐旧站 app/admin/dbadmin.py(表浏览 + SQL) 与 maint.py(安全内核)
//
// 旧站的入口是「系统设置 → 数据库工具」聚合页: `?tab=manage` 打开数据库管理页。
// Cloudflare 侧没有"本地库文件"概念(没有备份/压缩/VACUUM), 所以两页合并成一页:
//   /admin/db_tools   —— 旧站侧栏入口(保持菜单地址不变)
//   /admin/db_manage  —— 旧站数据库管理页地址(保持可达)
// 两处渲染同一份页面, 能力 = 表列表(含行数) + 表结构/索引/数据分页(只读, 敏感列脱敏) + SQL 执行。
//
// 权限(与旧站三道闸同款):
//   ① 页面: superOnly(GET 不被写路径中间件拦, 必须自己判 —— 旧站注释专门强调过这点);
//   ② 执行 SQL: 写路径 /admin/db_manage 已登记在 entities.SUPER_ONLY_WRITE_PATHS(分发前拦一道);
//   ③ 开关: ENABLE_SQL_TOOL=1 才开放(旧站生产默认关).
import { escapeHtml } from '../../core/html.js';
import { settings } from '../../core/config.js';
import { countTables } from '../../core/overview.js';
import { adminLayout } from '../lib/layout.js';
import { backButton, pageHeader } from '../lib/partials.js';
import { auditLog, buildListUrl, strOf } from '../lib/utils.js';
import { SAFE_TABLES, tableMeta, tablePage, classifyStatement, runStatement } from '../lib/dbTool.js';

const PAGE_URL = '/admin/db_manage';
const ALIAS_URL = '/admin/db_tools';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

// 页面级闸门: 非超管回控制面板; 开关关闭时给明确说明而不是空白页
function gate(ctx, env) {
  if (!ctx.session.isSuper) {
    return '/admin/dashboard?error=' + encodeURIComponent('该页面仅超级管理员可访问');
  }
  if (!settings(env).enableSqlTool) {
    return null;
  }
  return undefined;
}

function disabledPage(ctx) {
  return adminLayout(Object.assign({}, ctx, {
    title: '数据库工具',
    currentPage: 'db_tools',
    content: `<div class="card"><div class="card-body">
  <h5 class="card-title">数据库工具未开启</h5>
  <p class="mb-2">这一页能浏览全表数据、也能执行 SQL，因此与旧后台同口径：<b>默认关闭</b>。</p>
  <p class="mb-0">需要时在 Cloudflare 的变量里把 <code>ENABLE_SQL_TOOL</code> 设为 <code>1</code> 再部署；用完建议改回 <code>0</code>。</p>
</div></div>`
  }));
}

function link(url, label, extra = '') {
  return `<a class="btn btn-sm btn-outline-secondary ${extra}" href="${url}">${escapeHtml(label)}</a>`;
}

async function renderTableList(env) {
  const tables = await countTables(env);
  if (tables.failed) {
    return '<div class="alert alert-danger mb-0">读取表清单失败（数据库可能暂时不可用，详见 Workers 日志）</div>';
  }
  const rows = tables.rows.map(([name, count]) => `<tr>
    <td><code>${escapeHtml(name)}</code></td>
    <td>${count}</td>
    <td class="text-end">${link(buildListUrl(PAGE_URL, { filters: { table: name } }), '浏览数据')}</td>
  </tr>`).join('');
  return `<div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0">
    <thead><tr><th>表名</th><th>行数</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="text-muted">库里还没有表</td></tr>'}</tbody>
  </table></div>
  <div class="small text-muted mt-2">共 ${tables.rows.length} 张表 · 合计 ${tables.total.toLocaleString('en-US')} 行；浏览范围是全部表，执行 SQL 只允许白名单业务表（${SAFE_TABLES.length} 张）。</div>`;
}

async function renderTableDetail(env, name, page) {
  const meta = await tableMeta(env, name);
  if (!meta.ok) {
    return `<div class="alert alert-warning mb-0">${escapeHtml(meta.reason)}</div>`;
  }
  const data = await tablePage(env, name, page, 20);
  if (!data.ok) {
    return `<div class="alert alert-warning mb-0">${escapeHtml(data.reason)}</div>`;
  }
  const colRows = meta.columns.map((col) => `<tr>
    <td><code>${escapeHtml(col.name)}</code></td>
    <td>${escapeHtml(col.type || '—')}</td>
    <td>${col.pk ? '主键' : ''}${col.notnull ? ' 非空' : ''}</td>
    <td class="text-muted">${escapeHtml(col.comment || '—')}</td>
  </tr>`).join('');
  const head = data.rowKeys.map((key) => `<th>${escapeHtml(key)}</th>`).join('');
  const body = data.rows.map((row) => `<tr>${data.rowKeys
    .map((key) => `<td>${escapeHtml(strOf(row[key]).slice(0, 120)) || '—'}</td>`).join('')}</tr>`).join('');
  const prev = data.page > 1 ? link(buildListUrl(PAGE_URL, { filters: { table: name, page: data.page - 1 } }), '上一页') : '';
  const next = data.page < data.pages ? link(buildListUrl(PAGE_URL, { filters: { table: name, page: data.page + 1 } }), '下一页') : '';
  return `<div class="card mb-3"><div class="card-body">
    <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
      <h6 class="mb-0"><code>${escapeHtml(name)}</code> 结构</h6>
      <span class="small text-muted">${meta.viaPragma ? 'PRAGMA 读取' : '解析建表语句（PRAGMA 不可用）'} · 索引 ${meta.indexes.length} 个</span>
    </div>
    <div class="table-responsive"><table class="table table-sm mb-0">
      <thead><tr><th>列</th><th>类型</th><th>约束</th><th>说明</th></tr></thead>
      <tbody>${colRows}</tbody>
    </table></div>
  </div></div>
  <div class="card"><div class="card-body">
    <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
      <h6 class="mb-0">数据（第 ${data.page}/${data.pages} 页，共 ${data.total} 行，单页 20）</h6>
      <span class="ms-auto d-flex gap-2">${prev}${next}</span>
    </div>
    <div class="table-responsive"><table class="table table-sm table-striped mb-0">
      <thead><tr>${head}</tr></thead>
      <tbody>${body || `<tr><td colspan="${data.rowKeys.length || 1}" class="text-muted">这张表还没有数据</td></tr>`}</tbody>
    </table></div>
    <div class="small text-muted mt-2">敏感列（token / password / secret / openid 等）已自动打码。</div>
  </div></div>`;
}

function sqlConsole() {
  return `<div class="card mt-3"><div class="card-body">
    <h6 class="mb-2">执行 SQL</h6>
    <p class="small text-muted mb-2">只允许 SELECT / INSERT / UPDATE / DELETE，且只能操作白名单业务表；写操作会二次确认。</p>
    <form id="sqlForm">
      <textarea class="form-control font-monospace" id="sqlText" rows="4" placeholder="SELECT id, title FROM news LIMIT 5"></textarea>
      <div class="d-flex gap-2 mt-2">
        <button class="btn btn-primary btn-sm" type="submit">执行</button>
        <span class="small text-muted align-self-center" id="sqlOut"></span>
      </div>
    </form>
    <div id="sqlResult" class="mt-3"></div>
  </div></div>
  <script>
  (function () {
    var form = document.getElementById('sqlForm');
    if (!form) return;
    var out = document.getElementById('sqlOut');
    var box = document.getElementById('sqlResult');
    // 查询结果直接进 innerHTML, 必须转义: 库里的标题等字段带 <img onerror> 就能在超管的会话里执行
    function esc(value) {
      return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var sql = document.getElementById('sqlText').value.trim();
      if (!sql) { out.textContent = '请输入要执行的 SQL'; return; }
      var isWrite = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)/i.test(sql);
      if (isWrite && !window.confirm('这是写操作（会改动数据），确认执行？')) return;
      out.textContent = '执行中…';
      box.innerHTML = '';
      fetch('/admin/db_manage/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sql, confirm: isWrite ? '1' : '' })
      }).then(function (res) { return res.json(); }).then(function (data) {
        out.textContent = data.msg || '';
        var rows = (data.data && data.data.rows) || [];
        if (!rows.length) return;
        var keys = Object.keys(rows[0]);
        var head = keys.map(function (k) { return '<th>' + esc(k) + '</th>'; }).join('');
        var body = rows.map(function (row) {
          return '<tr>' + keys.map(function (k) { return '<td>' + esc(row[k]) + '</td>'; }).join('') + '</tr>';
        }).join('');
        box.innerHTML = '<div class="table-responsive"><table class="table table-sm table-bordered mb-0"><thead><tr>'
          + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
      }).catch(function () { out.textContent = '请求失败，请稍后重试'; });
    });
  })();
  </script>`;
}

async function pageHandler(ctx) {
  const verdict = gate(ctx, ctx.env);
  if (typeof verdict === 'string') return Response.redirect(new URL(verdict, ctx.url.origin).toString(), 302);
  if (verdict === null) return disabledPage(ctx);

  const table = strOf(ctx.query.table);
  const page = strOf(ctx.query.page);
  const content = `<div class="card mb-3"><div class="card-body">
    <h6 class="mb-2">数据表状态</h6>
    ${await renderTableList(ctx.env)}
  </div></div>
  ${table ? await renderTableDetail(ctx.env, table, page) : ''}
  ${sqlConsole()}`;

  return adminLayout(Object.assign({}, ctx, {
    title: '数据库工具',
    currentPage: 'db_tools',
    content: pageHeader({ icon: 'bi-database-gear', title: '数据库工具', actions: backButton('/admin/dashboard') }) + content
  }));
}

// 表详情(JSON): 与旧站 /admin/db_manage/table 同形状
async function tableJson(ctx) {
  if (!ctx.session.isSuper) return json({ code: 403, msg: '该操作仅超级管理员可执行' });
  if (!settings(ctx.env).enableSqlTool) return json({ code: 403, msg: '数据库工具未开启' });
  const name = strOf(ctx.query.table || ctx.query.name);
  const data = await tablePage(ctx.env, name, strOf(ctx.query.page) || 1, strOf(ctx.query.page_size) || 20);
  if (!data.ok) return json({ code: 404, msg: data.reason });
  return json({ code: 200, data: {
    name: data.name,
    columns: (await tableMeta(ctx.env, name)).columns,
    rows: data.rows,
    row_keys: data.rowKeys,
    total: data.total,
    page: data.page,
    pages: data.pages,
    page_size: data.page_size
  } });
}

// 执行 SQL(JSON): 复用唯一安全内核; 写语句必须 confirm=1(后端再验, 防绕过前端)
async function execHandler(ctx) {
  if (!ctx.session.isSuper) return json({ code: 403, msg: '该操作仅超级管理员可执行' });
  if (!settings(ctx.env).enableSqlTool) return json({ code: 403, msg: '数据库工具未开启' });

  const body = ctx.form && Object.keys(ctx.form).length ? ctx.form : ctx.body || {};
  const sql = strOf(body.sql);
  const confirmed = String(body.confirm || '') === '1';
  if (!sql) return json({ code: 400, msg: '请输入要执行的 SQL' });
  if (classifyStatement(sql).kind === 'write' && !confirmed) {
    return json({ code: 403, msg: '写操作需要二次确认：请在前端确认后重试' });
  }

  const result = await runStatement(ctx.env, sql);
  const username = ctx.session.username;
  if (result.error) {
    auditLog('admin.db_manage', { username, sql: sql.slice(0, 300), ok: false });
    return json({ code: 400, msg: result.error });
  }
  auditLog('admin.db_manage', { username, sql: sql.slice(0, 300), ok: true, affected: result.affected, cost_ms: result.costMs });
  return json({ code: 200, msg: result.message, data: {
    ran: result.ran,
    row_keys: result.rowKeys,
    rows: result.rows,
    affected: result.affected,
    cost_ms: result.costMs
  } });
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: ALIAS_URL, handler: pageHandler },
  { methods: ['GET', 'HEAD'], path: PAGE_URL, handler: pageHandler },
  // 旧站是 /admin/db_manage/table; 后台分发是精确匹配, 这里登记两个写法都能用
  { methods: ['GET', 'HEAD'], path: '/admin/db_manage/table', handler: tableJson },
  { methods: ['GET', 'HEAD'], path: '/admin/db_manage_table_json', handler: tableJson },
  { methods: ['POST'], path: '/admin/db_manage/exec', handler: execHandler }
];
