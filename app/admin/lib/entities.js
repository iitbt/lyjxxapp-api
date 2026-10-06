// 后台"实体注册表": 缓存前缀、超管写路径、审计前缀、状态注册项共用同一批实体
// 照搬旧站 fastapi/app/admin/entities.py 的口径(那是唯一来源, 别在别处再声明一遍)
//
// 为什么集中声明: 这几处只要漏改一处, 表现都是"看不出来"的问题 ——
// 缓存不失效(改了要等一分钟)、权限漏拦或漏放、审计查不到。所以声明一次、由它生成各处。
export const ADMIN_PREFIX = '/admin';

// 只有这些方法需要权限口径与来源(Origin)校验; GET/HEAD 不需要
export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// 13 个实体。tables 只作文档与自检用, 不参与 SQL 拼接。
// cachePrefixes: 旧站用它清进程内缓存; Workers 没有进程内缓存(先不加), 因此这里只作文档,
// 以及"将来真加 Cache API 时该清哪些前缀"的依据 —— 不要因为它当前没被读就删掉。
export const ENTITIES = {
  news: {
    label: '笔记',
    tables: ['news'],
    cachePrefixes: ['news:', 'dash:', 'config:'],
    auditPrefix: 'news',
    statusKinds: ['news'],
    note: 'config: 是因为首页板块/精选会引用笔记内容'
  },
  banner: {
    label: '轮播图',
    tables: ['banner_images'],
    cachePrefixes: ['banner:', 'dash:'],
    auditPrefix: 'banner',
    statusKinds: ['banner']
  },
  home_section: {
    label: '首页板块',
    tables: ['app_home_sections'],
    cachePrefixes: ['config:', 'dash:'],
    auditPrefix: 'app_home',
    statusKinds: ['home_section']
  },
  featured: {
    label: '首页精选',
    tables: ['app_featured_items'],
    cachePrefixes: ['config:', 'dash:'],
    auditPrefix: 'app_featured',
    statusKinds: ['app_featured'],
    note: '与首页板块同口径(接口直读数据库, 端上另有本地缓存, 属预期行为)'
  },
  text: {
    label: '运营文案',
    tables: ['app_texts'],
    cachePrefixes: ['config:', 'dash:'],
    auditPrefix: 'app_text',
    statusKinds: ['app_text']
  },
  menu: {
    label: '我的页菜单',
    tables: ['app_menu_items'],
    cachePrefixes: ['config:', 'dash:'],
    auditPrefix: 'app_menu',
    statusKinds: ['app_menu_item']
  },
  notice: {
    label: '通知公告',
    tables: ['app_notices'],
    cachePrefixes: ['notice:', 'config:', 'dash:'],
    auditPrefix: 'app_notice',
    statusKinds: ['app_notice'],
    note: 'notice: 是 /content/get_notices 的列表缓存; config:/dash: 前缀做兜底清理'
  },
  config: {
    label: '版本更新配置',
    tables: ['app_version_config'],
    cachePrefixes: ['config:', 'dash:'],
    auditPrefix: 'app_version',
    statusKinds: []
  },
  category: {
    label: '笔记分类',
    tables: ['app_categories'],
    cachePrefixes: ['category:', 'config:', 'dash:'],
    auditPrefix: 'app_category',
    statusKinds: ['app_category'],
    note: 'category: 是 /news/list 分类白名单的缓存; config: 分类名与排序会下发小程序'
  },
  topic: {
    label: '专题精选(摩旅/户外)',
    tables: ['motorcycle_trips', 'outdoor_activities'],
    cachePrefixes: ['topic:', 'dash:'],
    auditPrefix: 'topic',
    statusKinds: ['motorcycle', 'outdoor']
  },
  comment: {
    label: '留言',
    tables: ['news_comments'],
    cachePrefixes: ['comments:', 'dash:'],
    auditPrefix: 'comment',
    statusKinds: ['comment']
  },
  user: {
    label: '用户',
    tables: ['users'],
    cachePrefixes: ['users:', 'dash:'],
    auditPrefix: 'user',
    statusKinds: []
  },
  admin: {
    label: '管理员账号',
    tables: ['admin_users'],
    cachePrefixes: ['dash:'],
    auditPrefix: 'admin',
    statusKinds: [],
    note: '管理员变动只影响控制面板统计'
  }
};

export function entity(key) {
  return ENTITIES[String(key || '').trim()] || null;
}

// 审计动作名的唯一构造入口: admin.<实体前缀>.<动词>
// 动词约定: create / update / delete / status / copy / restore / purge
// 新代码请用它, 不要手拼字符串(拼错了在日志里很难发现)
export function auditAction(entityKey, verb) {
  const found = entity(entityKey);
  const prefix = found ? found.auditPrefix : String(entityKey || '-');
  return `admin.${prefix}.${verb}`;
}

// 实体 → 缓存前缀(旧站 generated 出来的映射, 这里同样由 ENTITIES 派生)
export const CACHE_PREFIX_BY_ENTITY = Object.fromEntries(
  Object.entries(ENTITIES).map(([key, value]) => [key, value.cachePrefixes])
);

// 状态 kind → 实体, 供状态注册表做"注册项与实体清单是否一致"的自检
export const STATUS_KIND_ENTITY = Object.fromEntries(
  Object.entries(ENTITIES).flatMap(([key, value]) => value.statusKinds.map((kind) => [kind, key]))
);

// ---------------------------------------------------------------------------
// 后台写操作的权限口径: 刻意分四份, 因为"执行者"不同
//   ① SUPER_ONLY_WRITE_PATHS       分发前拦截(第一道闸)
//   ② ROUTE_SUPER_ONLY_WRITE_PATHS 页面函数内自查(第二道闸)
//   ③ NORMAL_WRITE_PATHS           登录即可; 个别接口再按业务规则细分(如状态切换按 kind)
//   ④ EXEMPT_WRITE_PATHS           不纳入权限口径(登录/登出这类, 原因写在旁边)
// 四者相加必须覆盖全部 /admin 写路由 —— 由 tests/admin.test.mjs 里"写入口是否都登记了口径"断言核对
// ---------------------------------------------------------------------------

// ① 分发前拦截: 非超管直接拒绝
export const SUPER_ONLY_WRITE_PATHS = [
  '/admin/news_batch_action', // 批量删除/批量改状态
  '/admin/news_delete',       // 删除官方笔记(软删除进回收站)
  '/admin/news_restore',      // 回收站恢复
  '/admin/news_purge',        // 回收站彻底删除(不可恢复)
  '/admin/news_copy',         // 复制笔记(会新增内容)
  '/admin/banner_delete',     // 删除轮播图
  '/admin/banner_copy',       // 复制轮播图
  '/admin/motorcycle_delete', // 删除摩旅精选
  '/admin/outdoor_delete',    // 删除户外精选
  '/admin/comments_manage',   // 留言审核/删除(POST)
  '/admin/users',             // 用户管理写操作(设/取消内部测试、恢复已注销、删用户)
  // 下面两条属于本次"不迁移"的页面(数据库管理 / 素材库删除)。照旧保留:
  // 将来真要补这两页时, 权限口径已经就位, 不会因为漏登记而被自检拦下
  '/admin/db_manage',
  '/admin/media_manage_delete'
];

// ② 页面函数内自查(仅超管, 但拦在页面里而不是分发前)
export const ROUTE_SUPER_ONLY_WRITE_PATHS = [
  '/admin/admin_users', // 管理员账号增删/重置口令
  '/admin/fix_db'       // 一键补表(本次未迁移, 清单照旧保留)
];

// ③ 登录即可的写入口
export const NORMAL_WRITE_PATHS = [
  '/admin/settings',                 // 改自己的资料/口令(任何登录管理员)
  '/admin/news_edit',                // 发布/编辑官方笔记
  '/admin/image_upload',             // 素材上传(笔记封面/正文插图/轮播图共用)
  '/admin/news_image_upload',        // 同上, 历史地址
  '/admin/banner_edit',
  '/admin/app_home_edit',
  '/admin/app_home_delete',
  '/admin/app_featured_edit',
  '/admin/app_featured_delete',
  '/admin/app_category_edit',
  '/admin/app_category_delete',
  '/admin/app_version_edit',
  '/admin/app_text_edit',
  '/admin/app_text_delete',
  '/admin/app_menu_edit',
  '/admin/app_menu_delete',
  '/admin/app_menu_restore_missing', // 补齐内置菜单项(只新增, 不改已有行)
  '/admin/notice_edit',
  '/admin/notice_delete',
  '/admin/motorcycle_edit',
  '/admin/outdoor_edit',
  '/admin/status_update',            // 全后台统一状态切换(部分 kind 在接口内按 superOnly 再判)
  '/admin/sql_tool'                  // 本次未迁移, 清单照旧保留
];

// ④ 不纳入权限口径的写方法路由(原因写清楚, 避免"看起来像漏登记")
export const EXEMPT_WRITE_PATHS = [
  '/admin/login',   // 登录本身(此时还没有登录态)
  '/admin/logout',  // 登出(任何已登录管理员都应能退出)
  '/admin/index'    // 旧登录入口, 仅 302 到 /admin/login
];

const BUCKETS = [
  ['super', SUPER_ONLY_WRITE_PATHS],
  ['route_super', ROUTE_SUPER_ONLY_WRITE_PATHS],
  ['normal', NORMAL_WRITE_PATHS],
  ['exempt', EXEMPT_WRITE_PATHS]
];

// 给一个后台写路由归类: super / route_super / normal / exempt / unregistered
// 匹配规则: 按"路径边界"前缀匹配, 避免 /admin/users 误伤 /admin/users_xxx;
// 多条命中时取最长的那条(例如 /admin/db_manage/exec 命中 /admin/db_manage)
export function classifyWritePath(path) {
  const target = String(path || '');
  if (!target.startsWith(ADMIN_PREFIX)) return 'unregistered';
  if (target === ADMIN_PREFIX || target === `${ADMIN_PREFIX}/`) return 'exempt';
  let best = null;
  for (const [kind, prefixes] of BUCKETS) {
    for (const prefix of prefixes) {
      if (target === prefix || target.startsWith(`${prefix}/`)) {
        if (!best || prefix.length > best.prefix.length) best = { kind, prefix };
      }
    }
  }
  return best ? best.kind : 'unregistered';
}

// 自检: 对照真实注册的写路由, 找出"没登记权限口径"的路径(旧站启动时会调 audit_admin_write_routes)
// 入参 routes 形如 [['POST', '/admin/banner_edit'], ...]
export function auditAdminWriteRoutes(routes) {
  const result = { checked: 0, unregistered: [] };
  for (const [method, path] of routes || []) {
    if (!WRITE_METHODS.has(String(method || '').toUpperCase())) continue;
    if (!String(path || '').startsWith(ADMIN_PREFIX)) continue;
    result.checked += 1;
    if (classifyWritePath(path) === 'unregistered') result.unregistered.push(path);
  }
  result.unregistered = [...new Set(result.unregistered)].sort();
  return result;
}
