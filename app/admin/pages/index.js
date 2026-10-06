// 后台页面路由汇总: 每个页面模块导出自己的路由, 在这里合成一张表交给 admin/index.js 分发
// 路由形如 { methods: ['GET'], path: '/admin/banner_manage', handler: (ctx) => HTML|Response }
// 权限口径不在这里声明 —— 写在 admin/lib/entities.js 的三份清单里, 分发前统一拦截
import { routes as adminUsersRoutes } from './adminUsers.js';
import { routes as appFeaturedRoutes } from './appFeatured.js';
import { routes as appHomeRoutes } from './appHome.js';
import { routes as appMenuRoutes } from './appMenu.js';
import { routes as appTextRoutes } from './appText.js';
import { routes as appVersionRoutes } from './appVersion.js';
import { routes as bannerRoutes } from './banners.js';
import { routes as categoryRoutes } from './categories.js';
import { routes as commentRoutes } from './comments.js';
import { routes as dbToolsRoutes } from './dbTools.js';
import { routes as deleteConfirmRoutes } from './deleteConfirm.js';
import { routes as mediaGovernRoutes } from './mediaGovern.js';
// 注意: 这里的 media.js 是"后台素材页模块", 与 app/core/media_scheme.js(对外接口的地址拼装) 不是同一个文件
import { routes as mediaRoutes } from './media.js';
import { routes as newsRoutes } from './news.js';
import { routes as noticeRoutes } from './notices.js';
import { routes as settingsRoutes } from './settings.js';
import { routes as systemInfoRoutes } from './systemInfo.js';
import { routes as topicRoutes } from './topics.js';
import { routes as userNewsRoutes } from './userNews.js';
import { routes as userRoutes } from './users.js';

export const PAGE_ROUTES = [
  ...bannerRoutes,
  ...noticeRoutes,
  ...categoryRoutes,
  ...appHomeRoutes,
  ...appFeaturedRoutes,
  ...appVersionRoutes,
  ...appTextRoutes,
  ...appMenuRoutes,
  ...topicRoutes,
  ...settingsRoutes,
  ...systemInfoRoutes,
  ...userRoutes,
  ...adminUsersRoutes,
  ...userNewsRoutes,
  ...newsRoutes,
  ...commentRoutes,
  ...mediaRoutes,
  ...dbToolsRoutes,
  ...mediaGovernRoutes,
  ...deleteConfirmRoutes
];
