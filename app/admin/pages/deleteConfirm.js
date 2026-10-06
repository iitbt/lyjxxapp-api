// 服务端删除确认页(通用): 先摊开影响面, 再提交到原删除接口
// 为什么要这一页: 前端 confirm() 可被脚本绕过, 这一页保证"删除前一定看到影响面"(与旧站同思路)
// recoverable 的措辞必须分清: 只有"软删除进回收站"才说可恢复, 其余一律照实说不可恢复
import { all } from '../../core/db.js';
import { adminLayout } from '../lib/layout.js';
import { deleteConfirmCard } from '../lib/partials.js';
import { intOr, strOf } from '../lib/utils.js';

// fixed: 提交时必须一起带上的固定字段(与旧站按钮的 name 对齐)
// passthrough: 从地址栏透传的筛选/页码(回列表时保留)
const SPECS = {
  // ---- 配置类(不可恢复: 只删这条配置记录) ----
  notice: { label: '通知公告', submit: '/admin/notice_delete', back: '/admin/notice_manage', page: 'notice_manage' },
  featured: { label: '首页精选', submit: '/admin/app_featured_delete', back: '/admin/app_featured_manage', page: 'app_featured_manage' },
  home_section: {
    label: '首页板块入口', submit: '/admin/app_home_delete', back: '/admin/app_home_manage',
    page: 'app_home_manage', passthrough: ['section']
  },
  banner: { label: '轮播图', submit: '/admin/banner_delete', back: '/admin/banner_manage', page: 'banner_manage' },
  text: { label: '运营文案', submit: '/admin/app_text_delete', back: '/admin/app_text_manage', page: 'app_text_manage' },
  menu: { label: '我的页菜单项', submit: '/admin/app_menu_delete', back: '/admin/app_menu_manage', page: 'app_menu_manage' },
  motorcycle: { label: '摩旅精选', submit: '/admin/motorcycle_delete', back: '/admin/topics_manage', page: 'motorcycle_manage' },
  outdoor: { label: '户外精选', submit: '/admin/outdoor_delete', back: '/admin/topics_manage', page: 'outdoor_manage' },
  // ---- 用户与管理员(不可恢复, 且会级联清数据) ----
  user: {
    label: '用户', submit: '/admin/users', back: '/admin/users', page: 'users',
    idField: 'user_id', fixed: { delete_user: '1' }, cascade: 'user'
  },
  admin: {
    label: '管理员', submit: '/admin/admin_users', back: '/admin/admin_users', page: 'admin_users',
    idField: 'admin_id', fixed: { delete_admin: '1' }
  },
  // ---- 笔记类 ----
  news_row: {
    label: '笔记', submit: '/admin/news_delete', back: '/admin/news_manage', page: 'news_manage',
    recoverable: true, passthrough: ['category', 'status', 'keyword', 'page']
  },
  news: { label: '笔记', submit: '/admin/news_purge', back: '/admin/news_recycle', page: 'news_recycle' },
  // 留言是**物理删除、没有回收站**, 措辞必须照实(与其它 kind 区分开)
  comment_row: {
    label: '留言', submit: '/admin/comments_manage', back: '/admin/comments_manage',
    page: 'comments_manage', fixed: { action: 'delete' }
  }
};

// 回跳白名单: 只放行已知列表页, 防开放重定向
const ALLOWED_BACK = new Set(Object.values(SPECS).map((spec) => spec.back));

const CASCADE_TIP = '提示：这条记录及其关联数据会被一并清除，且无法恢复。';
const CONFIG_TIP = '提示：只删除这条配置记录，磁盘上的图片/视频文件会按素材保留策略留下（可能被其它记录引用）。'
  + '如果只是想暂时不展示，请返回列表改用「停用」。';
const NEWS_TIP = '提示：如果只是想下架而不是彻底清除，请返回回收站保留该笔记（超过保留期会自动清理）。';

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

// 用户彻底删除的影响面(与对外接口/后台删除同一份口径, 只统计未删笔记)
async function userImpact(env, userId) {
  const rows = await all(env,
    "SELECT '发布的笔记' AS label, COUNT(*) AS c FROM news WHERE user_id=? AND deleted_at IS NULL "
    + "UNION ALL SELECT '发表留言', COUNT(*) FROM news_comments WHERE user_id=? "
    + "UNION ALL SELECT '点赞记录', COUNT(*) FROM news_likes WHERE user_id=? "
    + "UNION ALL SELECT '收藏记录', COUNT(*) FROM news_favorites WHERE user_id=? "
    + "UNION ALL SELECT '浏览历史', COUNT(*) FROM news_view_history WHERE user_id=? "
    + "UNION ALL SELECT '分享记录', COUNT(*) FROM news_shares WHERE user_id=?",
    userId, userId, userId, userId, userId, userId).catch(() => []);
  return rows.map((row) => [strOf(row.label), intOr(row.c, 0)]);
}

async function confirmPage(ctx) {
  const kind = strOf(ctx.query.kind);
  const spec = SPECS[kind];
  const id = intOr(ctx.query.id, 0);
  if (!spec || id <= 0) {
    return redirect(`/admin/dashboard?error=${encodeURIComponent('无效的确认请求')}`);
  }
  const requested = strOf(ctx.query.back);
  const back = ALLOWED_BACK.has(requested) ? requested : spec.back;

  const idField = spec.idField || 'id';
  const hiddenFields = [[idField, String(id)]];
  for (const [name, value] of Object.entries(spec.fixed || {})) hiddenFields.push([name, value]);
  for (const name of spec.passthrough || []) {
    const value = strOf(ctx.query[name]);
    if (value && name !== 'page') hiddenFields.push([name, value]);
  }
  const page = intOr(ctx.query.page, 0);
  if (page > 0) hiddenFields.push(['page', String(page)]);

  let impact = [['该记录', 1]];
  if (spec.cascade === 'user') {
    const counted = await userImpact(ctx.env, id);
    impact = counted.length ? counted : impact;
  }
  const totalImpact = impact.reduce((sum, item) => sum + intOr(item[1], 0), 0);

  const tip = spec.recoverable ? '' : (spec.cascade === 'user' ? CASCADE_TIP : (kind === 'news' ? NEWS_TIP : CONFIG_TIP));
  const content = deleteConfirmCard({
    title: `${spec.label} #${id}`,
    impact,
    totalImpact,
    submitAction: spec.submit,
    hiddenFields,
    backUrl: back,
    recoverable: spec.recoverable === true,
    tip
  });
  return adminLayout({
    title: '删除确认', currentPage: spec.page, admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, content
  });
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: '/admin/delete_confirm', handler: confirmPage }
];
