// 后台侧栏菜单的唯一来源(照搬旧站 base.html 的菜单项、分组与权限口径)
// status: 'ready' = 本 Worker 已实现; 'todo' = 还没迁(页面上会标"待迁")
export const NAV_GROUPS = [
  {
    key: 'overview',
    title: '概览',
    items: [
      { key: 'dashboard', title: '控制面板', href: '/admin/dashboard', icon: 'bi-speedometer2', status: 'ready' }
    ]
  },
  {
    key: 'user',
    title: '用户与审核',
    items: [
      { key: 'users', title: '用户管理', href: '/admin/users', icon: 'bi-people', status: 'ready' },
      { key: 'user_news_manage', title: '用户笔记审核', href: '/admin/user_news_manage', icon: 'bi-check2-square', status: 'ready' },
      { key: 'admin_users', title: '管理员管理', href: '/admin/admin_users', icon: 'bi-person-gear', superOnly: true, status: 'ready' }
    ]
  },
  {
    key: 'content',
    title: '内容管理',
    items: [
      { key: 'news_manage', title: '笔记管理', href: '/admin/news_manage', icon: 'bi-file-earmark-richtext', status: 'ready' },
      { key: 'app_category_manage', title: '分类管理', href: '/admin/app_category_manage', icon: 'bi-tags', status: 'ready' },
      { key: 'notice_manage', title: '通知公告', href: '/admin/notice_manage', icon: 'bi-megaphone', status: 'ready' },
      { key: 'comments_manage', title: '留言管理', href: '/admin/comments_manage', icon: 'bi-chat-left-text', status: 'ready' }
    ]
  },
  {
    key: 'app',
    title: '小程序配置',
    items: [
      { key: 'app_version_edit', title: '版本更新配置', href: '/admin/app_version_edit', icon: 'bi-arrow-repeat', status: 'ready' },
      { key: 'app_text_manage', title: '运营文案配置', href: '/admin/app_text_manage', icon: 'bi-chat-square-quote', status: 'ready' },
      { key: 'app_menu_manage', title: '我的页菜单配置', href: '/admin/app_menu_manage', icon: 'bi-list-ul', status: 'ready' },
      { key: 'banner_manage', title: '轮播图管理', href: '/admin/banner_manage', icon: 'bi-images', status: 'ready' },
      { key: 'app_home_manage', title: '首页板块管理', href: '/admin/app_home_manage', icon: 'bi-grid-3x3-gap', status: 'ready' },
      { key: 'app_featured_manage', title: '首页精选管理', href: '/admin/app_featured_manage', icon: 'bi-star', status: 'ready' },
      { key: 'topics_manage', title: '专题精选管理', href: '/admin/topics_manage', icon: 'bi-signpost-2', status: 'ready' }
    ]
  },
  {
    key: 'system',
    title: '系统设置',
    items: [
      { key: 'settings', title: '管理员设置', href: '/admin/settings', icon: 'bi-gear', status: 'ready' },
      { key: 'system_info', title: '系统信息', href: '/admin/system_info', icon: 'bi-hdd', status: 'ready' },
      // 这两页与旧站同为"超管工具位": 数据库工具受 ENABLE_SQL_TOOL 开关约束(默认关),
      // 素材库管理页自身在 GET 里再判一次超管(写路径由 entities 的 SUPER_ONLY_WRITE_PATHS 拦)。
      { key: 'db_tools', title: '数据库工具', href: '/admin/db_tools', icon: 'bi-database-gear', superOnly: true, status: 'ready' },
      { key: 'media_manage', title: '素材库管理', href: '/admin/media_manage', icon: 'bi-collection-play', superOnly: true, status: 'ready' }
    ]
  }
];

// 待迁页面总数: 控制面板用它显示进度
export function migrationProgress() {
  const all = NAV_GROUPS.flatMap((group) => group.items);
  const ready = all.filter((item) => item.status === 'ready').length;
  return { ready, total: all.length };
}
