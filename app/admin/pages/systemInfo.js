// 系统信息: 把"这套 Worker 上跑着什么、数据有多少"讲清楚
// 与旧站的差异(都是 Serverless 平台事实, 不编数字 —— 旧站也坚持"数不清就给 —"):
//   ① 没有进程/文件系统: 运行时长、PID、平台、Python 版本这些一律不显示或标注不适用;
//   ② 没有本地缓存: 缓存后端写明"未启用";
//   ③ 数据库大小没有文件概念 → 用"表数量 + 记录总数"表达容量;
//   ④ 素材占用列 R2(与旧站同一套"扫描上限"口径)。
import { escapeHtml } from '../../core/html.js';
import { settings } from '../../core/config.js';
import { EXPECTED_TABLES, countTables, coreCounts, fmtBytes } from '../../core/overview.js';
import { mediaUsage } from '../../core/storage.js';
import { adminLayout } from '../lib/layout.js';
import { backButton } from '../lib/partials.js';
import { auditLog } from '../lib/utils.js';

const PAGE_URL = '/admin/system_info';

function onOff(value, envName) {
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(value === undefined || value === null ? '' : value).toLowerCase());
  return `${enabled ? '已开启' : '已关闭'}${envName ? `（${envName}）` : ''}`;
}

function statCard(label, value, icon, color) {
  return `<div class="col-6 col-md-3"><div class="card-stat">
  <div class="lbl"><i class="bi ${icon} text-${color}" aria-hidden="true"></i> ${escapeHtml(label)}</div>
  <div class="num">${value}</div></div></div>`;
}

function group(title, icon, rows, footer = '') {
  const body = rows.map(([label, value, hint]) => `<tr>
  <th scope="row" class="text-nowrap">${escapeHtml(label)}</th>
  <td>${value}${hint ? `<div class="small text-muted">${escapeHtml(hint)}</div>` : ''}</td>
</tr>`).join('');
  return `<div class="card mt-3"><div class="card-body">
  <div class="form-label"><i class="bi ${icon}" aria-hidden="true"></i> ${escapeHtml(title)}</div>
  <div class="table-responsive"><table class="table table-sm align-middle mb-0"><tbody>${body}</tbody></table></div>
  ${footer}
</div></div>`;
}

async function systemInfoPage(ctx) {
  const counts = await coreCounts(ctx.env);
  const tables = await countTables(ctx.env);
  const media = await mediaUsage(ctx.env);
  const missing = EXPECTED_TABLES.filter((name) => !tables.rows.some(([table]) => table === name));
  const anchorMs = Date.now();
  const serverTime = new Date(anchorMs + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  const cards = [
    statCard('业务表数量', `${tables.rows.length} 张`, 'bi-table', 'primary'),
    statCard('记录总数', String(tables.total), 'bi-database', 'secondary'),
    statCard('对外可见笔记', String(counts.visibleNews), 'bi-file-earmark-richtext', 'success'),
    statCard('回收站笔记', String(counts.recycledNews), 'bi-trash3', 'warning')
  ].join('');

  const runtime = group('服务与运行环境', 'bi-hdd', [
    ['服务器时间', `<span data-live="clock">${escapeHtml(serverTime)}</span>`],
    ['运行环境', 'Cloudflare Workers（Serverless）'],
    ['运行时长 / 进程 PID / 平台', '<span class="text-muted">不适用 —— 每次请求由边缘按需拉起，没有常驻进程</span>'],
    // 版本号由入口注入到 ctx(唯一来源是 main.js 的 API_VERSION)
    ['接口版本', escapeHtml(ctx.version)],
    ['请求时间', escapeHtml(new Date(anchorMs).toISOString())]
  ]);

  const database = group('数据库', 'bi-database', [
    ['数据库驱动', 'Cloudflare D1（SQLite 兼容）'],
    // 统计没跑通时**不要**照常显示 "0 张 / 缺失 N 张" —— 那看起来像"表全丢了",
    // 实际只是这一条统计失败(2026-10-06 线上就被这个误导过)。这里一律标"无法判定"并给出原因。
    ['业务表数量', tables.failed
      ? '<span class="text-danger">统计失败，无法判定</span>'
      : (tables.empty ? '0 张（库里确实没有业务表）' : `${tables.rows.length} 张`)],
    ['记录总数', tables.failed
      ? '<span class="text-danger">统计失败，无法判定</span>'
      : `${tables.total.toLocaleString('en-US')}<div class="small text-muted">含回收站与配置表</div>`],
    ['其中：对外可见笔记', `${counts.visibleNews.toLocaleString('en-US')}<div class="small text-muted">不含回收站，与控制面板「笔记总数」是同一个数</div>`],
    ['其中：回收站笔记', `${counts.recycledNews.toLocaleString('en-US')}<div class="small text-muted">已删除待清理，计入上面的记录总数</div>`],
    ['表行数明细', tables.failed
      ? `<span class="text-danger">统计失败：${escapeHtml(tables.reason || '详见 Workers 日志')}</span>`
      : (tables.empty
        ? '<span class="text-muted">库里没有业务表（还没建表？见 DEPLOY 的 A4）</span>'
        : `<details><summary class="small">展开 ${tables.rows.length} 张表</summary><div class="small">${tables.rows.map(([name, count]) => `<code>${escapeHtml(name)}</code> ${count}`).join('　')}</div></details>`)],
    ['应有数据表缺失', tables.failed
      ? '<span class="text-muted">无法判定（上面的行数统计失败）</span>'
      : (missing.length ? `<span class="text-danger">${missing.length} 张：${missing.map((name) => escapeHtml(name)).join(', ')}</span>` : '无')]
  ]);

  const storage = group('缓存与存储', 'bi-hdd-stack', [
    ['接口缓存', '<span class="text-muted">未启用 —— Workers 无进程内缓存，接口层当前不缓存</span>'],
    ['素材存储', 'Cloudflare R2（桶随部署绑定，公开域由 MEDIA_BASE 决定）'],
    ['素材占用', media.failed
      ? '<span class="text-danger">读取失败，请稍后重试</span>'
      : `${fmtBytes(media.bytes)}（${media.count} 个文件${media.truncated ? '，已达扫描上限，实际可能更多' : ''}）`],
    ['媒体域', escapeHtml(settings(ctx.env).mediaBase || '未配置')]
  ]);

  const toggles = group('运行开关与配置概览', 'bi-sliders', [
    ['当前登录管理员', `${escapeHtml(ctx.session.username)}${ctx.session.isSuper ? '（超级管理员）' : ''}`],
    ['模式开关 DEV_WECHAT_MOCK', escapeHtml(onOff(settings(ctx.env).devWechatMock ? '1' : '0', 'DEV_WECHAT_MOCK'))],
    ['对外探测页 /apitest', escapeHtml(onOff(settings(ctx.env).enablePublicProbe ? '1' : '0', 'ENABLE_PUBLIC_PROBE'))],
    ['可观测性 /metrics', escapeHtml(onOff(settings(ctx.env).observabilityEnabled ? '1' : '0', 'OBSERVABILITY_ENABLED'))],
    ['头像上传上限', `${Math.floor(settings(ctx.env).uploadMaxBytes / 1024 / 1024)} MB（UPLOAD_MAX_BYTES）`],
    ['日志', 'Cloudflare Workers Logs（控制台 → 部署 → Logs；没有本地日志文件）']
  ], `<div class="small text-muted mt-2">口径说明：记录总数含回收站与配置表（运维容量口径），「对外可见笔记」不含回收站（对外可见口径），两个数不一样是正常的。</div>`);

  const content = `<div class="row g-3">${cards}</div>
  <span hidden data-live-anchor="${anchorMs}"></span>
  ${runtime}${database}${storage}${toggles}
  <div class="card mt-3"><div class="card-body d-flex flex-wrap gap-2">
    ${backButton('/admin/dashboard', '返回控制面板')}
    <a class="btn btn-outline-secondary" href="/admin/static/js/live_time.js" target="_blank" rel="noopener">查看实时时钟脚本</a>
  </div></div>
  <script src="/admin/static/js/live_time.js?v=${encodeURIComponent(String(ctx.version || ''))}" defer></script>`;
  auditLog('admin.system_info.view', { user: ctx.session.username });
  return adminLayout({
    title: '系统信息', currentPage: 'system_info', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, content
  });
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: PAGE_URL, handler: systemInfoPage }
];
