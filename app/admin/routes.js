// 控制面板 + 未迁入口的占位页
// 统计口径与旧站 dashboard.py / overview.collect_counts 一致(13 张卡 + 2 张趋势 + 3 个最新列表):
// 数字一次 UNION 取回、趋势分开查、列表各一条 —— 一共 6 次 D1 往返, 免费套餐子请求预算内
import { escapeHtml } from '../core/html.js';
import { all, one } from '../core/db.js';
import { adminLayout } from './lib/layout.js';
import { migrationProgress } from './lib/nav.js';
import { intOr, strOf } from './lib/utils.js';

// 时间窗口按北京时间算(与对外接口的 stats.py 同口径): 直接用 UTC 方法读 +8 小时的时刻
function chinaNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

function chinaStamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function chinaMidnight(daysAgo = 0) {
  const now = chinaNow();
  return chinaStamp(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo)));
}

function chinaDaysAgo(days) {
  return chinaStamp(new Date(Date.now() + 8 * 3600 * 1000 - days * 24 * 3600 * 1000));
}

// 纯 SVG 折线(零依赖, 与旧站的 sparkline 宏等价): 固定 7 个点, 最高点贴顶
function sparkline(values) {
  const list = (values && values.length) ? values : [0];
  const max = Math.max(...list, 1);
  const points = list.map((value, index) => {
    const x = list.length === 1 ? 0 : (index / (list.length - 1)) * 120;
    const y = 30 - (Number(value) || 0) / max * 26;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="sparkline" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true">`
    + `<polyline fill="none" stroke="currentColor" stroke-width="2" points="${points}"></polyline></svg>`;
}

function num(value) {
  return (Number(value) || 0).toLocaleString('en-US');
}

async function collectCounts(env, windows) {
  const sql = 'SELECT '
    + '(SELECT COUNT(*) FROM users) AS total_users, '
    + '(SELECT COUNT(*) FROM users WHERE create_time >= ?) AS today_users, '
    + '(SELECT COUNT(*) FROM users WHERE create_time >= ?) AS week_users, '
    + '(SELECT COUNT(*) FROM users WHERE create_time >= ? AND create_time < ?) AS prev_week_users, '
    + '(SELECT COUNT(*) FROM users WHERE create_time >= ?) AS yesterday_users, '
    + '(SELECT COUNT(*) FROM news WHERE deleted_at IS NULL) AS total_news, '
    + "(SELECT COUNT(*) FROM news WHERE status='approved' AND deleted_at IS NULL) AS approved_news, "
    + "(SELECT COUNT(*) FROM news WHERE status='pending' AND deleted_at IS NULL) AS pending_news, "
    + '(SELECT COUNT(*) FROM news_comments) AS total_comments, '
    + "(SELECT COUNT(*) FROM news_comments WHERE status='pending') AS pending_comments, "
    + '(SELECT COUNT(*) FROM news_likes) AS total_likes, '
    + '(SELECT COUNT(*) FROM news_favorites) AS total_favorites, '
    + '(SELECT COUNT(*) FROM banner_images) AS total_banners, '
    + '(SELECT COUNT(*) FROM motorcycle_trips) AS motorcycle_total, '
    + '(SELECT COUNT(*) FROM outdoor_activities) AS outdoor_total';
  const row = await one(env, sql, windows.today, windows.week, windows.prevWeek, windows.week,
    windows.yesterday) || {};
  const counts = {};
  for (const [key, value] of Object.entries(row)) counts[key] = intOr(value, 0);
  return counts;
}

// 近 7 日每日新增(缺日期补 0): 用 substr 截日期, 两个驱动都支持(旧站踩过 SQLite 专有函数的坑)
async function trend(env, table, dateColumn, extraWhere = '') {
  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) days.push(chinaMidnight(offset).slice(0, 10));
  const rows = await all(env,
    `SELECT substr(${dateColumn},1,10) AS d, COUNT(*) AS c FROM ${table} `
    + `WHERE ${dateColumn} >= ?${extraWhere} GROUP BY d ORDER BY d`,
    `${days[0]} 00:00:00`).catch(() => []);
  const map = {};
  for (const row of rows) map[strOf(row.d)] = intOr(row.c, 0);
  return days.map((day) => map[day] || 0);
}

function card(label, value, hint = '', accent = '') {
  return `<div class="col-6 col-md-3"><div class="card-stat">
  <div class="lbl">${escapeHtml(label)}</div>
  <div class="num${accent ? ` text-${accent}` : ''}">${value}</div>
  ${hint ? `<div class="lbl">${hint}</div>` : ''}
</div></div>`;
}

function miniList(title, rows, renderRow, href) {
  const body = rows.length
    ? rows.map(renderRow).join('')
    : '<li class="list-group-item text-muted small">暂无数据</li>';
  return `<div class="card mt-3"><div class="card-body">
  <div class="d-flex align-items-center mb-2">
    <div class="form-label mb-0">${escapeHtml(title)}</div>
    <a class="ms-auto small" href="${href}">查看全部</a>
  </div>
  <ul class="list-group list-group-flush">${body}</ul>
</div></div>`;
}

export async function dashboardPage(ctx) {
  const progress = migrationProgress();
  const windows = {
    today: chinaMidnight(0),
    yesterday: chinaMidnight(1),
    week: chinaDaysAgo(7),
    prevWeek: chinaDaysAgo(14)
  };
  let counts = {};
  let trendUsers = [0, 0, 0, 0, 0, 0, 0];
  let trendNews = [0, 0, 0, 0, 0, 0, 0];
  let latestUsers = [];
  let latestNews = [];
  let latestComments = [];
  let error = '';
  try {
    counts = await collectCounts(ctx.env, windows);
    trendUsers = await trend(ctx.env, 'users', 'create_time');
    trendNews = await trend(ctx.env, 'news', 'publish_time', ' AND deleted_at IS NULL');
    latestUsers = await all(ctx.env, 'SELECT id, username, nickname, create_time FROM users ORDER BY id DESC LIMIT 8');
    latestNews = await all(ctx.env,
      'SELECT id, title, category, publish_time FROM news WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 8');
    latestComments = await all(ctx.env,
      'SELECT c.id, c.content, c.status, u.nickname FROM news_comments c LEFT JOIN users u ON c.user_id = u.id '
      + 'ORDER BY c.id DESC LIMIT 8');
  } catch (err) {
    console.error('统计数据加载失败', err && err.stack ? err.stack : err);
    error = '统计数据加载失败，以下数字可能不完整。请查看 Workers 日志或稍后刷新重试。';
  }

  const todayDelta = counts.today_users - counts.yesterday_users;
  const weekDelta = counts.week_users - counts.prev_week_users;
  const deltaText = (value) => (value > 0 ? `较上期 +${value}` : (value < 0 ? `较上期 ${value}` : '与上期持平'));

  const cards = [
    card('总用户数', num(counts.total_users)),
    card('今日新增用户', num(counts.today_users), deltaText(todayDelta)),
    card('近 7 日新增用户', num(counts.week_users), deltaText(weekDelta)),
    card('笔记总数', num(counts.total_news)),
    card('已显示笔记', num(counts.approved_news), '', 'success'),
    card('待审核笔记', num(counts.pending_news), '', counts.pending_news ? 'warning' : ''),
    card('留言总数', num(counts.total_comments)),
    card('待审核留言', num(counts.pending_comments), '', counts.pending_comments ? 'warning' : ''),
    card('总点赞', num(counts.total_likes)),
    card('总收藏', num(counts.total_favorites)),
    card('轮播图', num(counts.total_banners)),
    card('摩旅精选', num(counts.motorcycle_total)),
    card('户外精选', num(counts.outdoor_total)),
    card('管理页面', `${progress.ready}/${progress.total}`, '后台功能已全部迁移')
  ].join('');

  const trendCards = `<div class="row g-3 mt-1">
  <div class="col-md-6"><div class="card-stat">
    <div class="lbl">近 7 日新增用户趋势</div>
    <div class="num">${num(trendUsers.reduce((sum, value) => sum + value, 0))}</div>
    <div class="lbl">最近一天 ${num(trendUsers[trendUsers.length - 1])} 人</div>
    <div class="text-primary">${sparkline(trendUsers)}</div>
  </div></div>
  <div class="col-md-6"><div class="card-stat">
    <div class="lbl">近 7 日笔记发布趋势</div>
    <div class="num">${num(trendNews.reduce((sum, value) => sum + value, 0))}</div>
    <div class="lbl">最近一天 ${num(trendNews[trendNews.length - 1])} 篇</div>
    <div class="text-success">${sparkline(trendNews)}</div>
  </div></div>
</div>`;

  const lists = miniList('最新注册用户', latestUsers, (row) => `<li class="list-group-item d-flex">
    <span class="text-truncate">${escapeHtml(strOf(row.nickname) || strOf(row.username) || '-')}</span>
    <span class="ms-auto small text-muted">${escapeHtml(strOf(row.create_time).slice(5, 16))}</span>
  </li>`, '/admin/users')
    + miniList('最新笔记', latestNews, (row) => `<li class="list-group-item d-flex">
    <a class="text-truncate" href="/admin/news_preview?id=${row.id}">${escapeHtml(strOf(row.title) || '(无标题)')}</a>
    <span class="ms-auto small text-muted">${escapeHtml(strOf(row.publish_time).slice(5, 16))}</span>
  </li>`, '/admin/news_manage')
    + miniList('最新留言', latestComments, (row) => `<li class="list-group-item">
    <div class="text-truncate">${escapeHtml(strOf(row.content))}</div>
    <div class="small text-muted">${escapeHtml(strOf(row.nickname) || '匿名')} · ${escapeHtml(strOf(row.status))}</div>
  </li>`, '/admin/comments_manage');

  return adminLayout(Object.assign({}, ctx, {
    title: '控制面板', currentPage: 'dashboard',
    error: error || ctx.error,
    content: `<div class="row g-3">${cards}</div>${trendCards}${lists}`
  }));
}

export function pendingPage(ctx, item) {
  const content = `<div class="card-stat">
  <h5 class="mb-2">${escapeHtml(item.title)}</h5>
  <p class="mb-1">这个页面还没迁到 Cloudflare Workers。</p>
  <p class="mb-0 text-muted">旧站路径 <code>/admin/${escapeHtml(item.key)}</code>；排期与做法见 <code>app/api-cf/admin/README.md</code>。</p>
</div>`;
  return adminLayout(Object.assign({}, ctx, {
    title: item.title, currentPage: item.key, content
  }));
}
