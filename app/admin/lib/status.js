// 后台"状态切换"注册表(唯一来源, 照搬旧站 status.py)
// 文案/配色/按钮全在这里声明: 行片段只用 statusKind() 取渲染口径, 前端 status-toggle.js 只按响应更新 DOM
// 新增一个"可切换状态"的实体 = 这里加一条注册(并在 entities.js 的 statusKinds 里声明, 自检会核对两边)
import { run } from '../../core/db.js';
import { beijingNow } from '../../core/timeutil.js';
import { STATUS_KIND_ENTITY } from './entities.js';
import { auditLog, invalidateEntityCache, intOr } from './utils.js';

// 笔记类实体共用的动作(通过 / 待审核), 与旧站 NEWS_LIKE_ACTIONS 一致
const NEWS_LIKE_ACTIONS = [
  { value: 'approved', label: '通过', btnClass: 'outline-success', fromValues: ['pending'] },
  { value: 'pending', label: '待审核', btnClass: 'outline-warning', fromValues: ['approved'] }
];

// 启用 / 停用两级(状态列是整数 0/1)
function onOffActions() {
  return [
    { value: '1', label: '启用', btnClass: 'outline-success', fromValues: ['0'] },
    { value: '0', label: '停用', btnClass: 'outline-warning', fromValues: ['1'] }
  ];
}

export const STATUS_KINDS = {
  news: {
    key: 'news', table: 'news', itemLabel: '笔记',
    labels: { approved: ['显示', 'success'], pending: ['待审核', 'warning'], rejected: ['已拒绝', 'danger'] },
    actions: NEWS_LIKE_ACTIONS,
    audit: 'admin.news.status', cacheEntity: 'news', idKey: 'news_id',
    // 与其它笔记写操作一致: 只允许改官方笔记且未被软删除
    extraWhere: "type = 'admin_users' AND deleted_at IS NULL"
  },
  banner: {
    key: 'banner', table: 'banner_images', itemLabel: '轮播图',
    labels: { 1: ['启用', 'success'], 0: ['停用', 'secondary'] },
    actions: onOffActions(),
    audit: 'admin.banner.status', cacheEntity: 'banner', idKey: 'banner_id',
    touchCol: 'update_time', asInt: true
  },
  home_section: {
    key: 'home_section', table: 'app_home_sections', itemLabel: '首页板块',
    labels: { 1: ['启用', 'success'], 0: ['停用', 'secondary'] },
    actions: onOffActions(),
    audit: 'admin.app_home.status', cacheEntity: 'home_section', idKey: 'home_section_id',
    touchCol: 'update_time', asInt: true
  },
  app_featured: {
    key: 'app_featured', table: 'app_featured_items', itemLabel: '精选',
    labels: { 1: ['启用', 'success'], 0: ['停用', 'secondary'] },
    actions: onOffActions(),
    audit: 'admin.app_featured.status', cacheEntity: 'featured', idKey: 'featured_id',
    touchCol: 'update_time', asInt: true
  },
  app_category: {
    key: 'app_category', table: 'app_categories', itemLabel: '分类',
    labels: { 1: ['启用', 'success'], 0: ['停用', 'secondary'] },
    actions: onOffActions(),
    audit: 'admin.app_category.status', cacheEntity: 'category', idKey: 'category_id',
    touchCol: 'update_time', asInt: true
  },
  app_text: {
    key: 'app_text', table: 'app_texts', itemLabel: '文案',
    labels: { 1: ['启用', 'success'], 0: ['停用', 'secondary'] },
    actions: onOffActions(),
    audit: 'admin.app_text.status', cacheEntity: 'text', idKey: 'text_id',
    touchCol: 'update_time', asInt: true
  },
  app_menu_item: {
    key: 'app_menu_item', table: 'app_menu_items', itemLabel: '菜单',
    labels: { 1: ['启用', 'success'], 0: ['停用', 'secondary'] },
    actions: onOffActions(),
    audit: 'admin.app_menu.status', cacheEntity: 'menu', idKey: 'menu_id',
    touchCol: 'update_time', asInt: true
  },
  app_notice: {
    key: 'app_notice', table: 'app_notices', itemLabel: '公告',
    labels: { 1: ['启用', 'success'], 0: ['停用', 'secondary'] },
    actions: onOffActions(),
    audit: 'admin.app_notice.status', cacheEntity: 'notice', idKey: 'notice_id',
    touchCol: 'update_time', asInt: true
  },
  motorcycle: {
    key: 'motorcycle', table: 'motorcycle_trips', itemLabel: '摩旅路线',
    labels: { approved: ['显示', 'success'], pending: ['待审核', 'warning'], rejected: ['已拒绝', 'danger'] },
    actions: NEWS_LIKE_ACTIONS,
    audit: 'admin.motorcycle.status', cacheEntity: 'topic', idKey: 'item_id',
    touchCol: 'updated_at'
  },
  outdoor: {
    key: 'outdoor', table: 'outdoor_activities', itemLabel: '户外活动',
    labels: { approved: ['显示', 'success'], pending: ['待审核', 'warning'], rejected: ['已拒绝', 'danger'] },
    actions: NEWS_LIKE_ACTIONS,
    audit: 'admin.outdoor.status', cacheEntity: 'topic', idKey: 'item_id',
    touchCol: 'updated_at'
  },
  comment: {
    key: 'comment', table: 'news_comments', itemLabel: '留言',
    labels: { approved: ['已通过', 'success'], pending: ['待审核', 'warning'], rejected: ['已拒绝', 'danger'] },
    // 留言比笔记多一个"拒绝"动作: 待审核时通过/拒绝都可用
    actions: [
      { value: 'approved', label: '通过', btnClass: 'outline-success', fromValues: ['pending', 'rejected'] },
      { value: 'rejected', label: '拒绝', btnClass: 'outline-warning', fromValues: ['pending', 'approved'] }
    ],
    audit: 'admin.comment.status', cacheEntity: 'comment', idKey: 'comment_id',
    // 留言审核在模块页面是超管专属, 统一接口必须同口径
    superOnly: true
  }
};

export function statusKind(key) {
  return STATUS_KINDS[String(key || '').trim()] || null;
}

// 显示文案 / 徽章配色: 未知值原样返回(与旧站一致, 便于发现异常数据)
export function statusLabel(kind, value) {
  const found = kind.labels[String(value)];
  return found ? found[0] : String(value);
}

export function statusBadgeClass(kind, value) {
  const found = kind.labels[String(value)];
  return found ? found[1] : 'secondary';
}

// 该状态下应展示的动作(供行片段渲染: 不可见的加 hidden, 由前端按响应显隐)
export function statusActions(kind, value) {
  const current = String(value);
  return kind.actions.map((action) => ({
    value: action.value,
    label: action.label,
    btnClass: action.btnClass,
    visible: action.fromValues.includes(current)
  }));
}

// 成功响应体: 前端只依赖这里返回的文案/配色/可用按钮, 不硬编码任何模块口径
export function statusPayload(kind, target, message = '') {
  return {
    success: true,
    message: message || `${kind.itemLabel}状态已更新为「${statusLabel(kind, target)}」`,
    status: String(target),
    status_text: statusLabel(kind, target),
    badge_class: statusBadgeClass(kind, target),
    actions: kind.actions.filter((action) => action.fromValues.includes(String(target))).map((action) => action.value)
  };
}

// 执行状态切换(唯一实现)。失败一律返回 { success:false }, 不把 500 抛给前端
export async function applyStatus(env, session, kind, recordId, target) {
  if (kind.superOnly && !session.isSuper) {
    auditLog('admin.denied', { user: session.username, reason: 'super_only', kind: kind.key });
    return { success: false, forbidden: true, message: '该操作仅超级管理员可执行' };
  }
  const wanted = String(target === undefined || target === null ? '' : target);
  if (!kind.actions.some((action) => action.value === wanted)) {
    return { success: false, message: '无效的状态值' };
  }
  const rawId = String(recordId === undefined || recordId === null ? '' : recordId);
  if (!/^\d+$/.test(rawId.replace('-', ''))) return { success: false, message: '参数错误' };

  const id = intOr(rawId, 0);
  const statusCol = kind.statusCol || 'status';
  const idCol = kind.idCol || 'id';
  let sql = `UPDATE ${kind.table} SET ${statusCol} = ?`;
  const args = [kind.asInt ? intOr(wanted, 0) : wanted];
  if (kind.touchCol) {
    sql += `, ${kind.touchCol} = ?`;
    args.push(beijingNow());
  }
  sql += ` WHERE ${idCol} = ?`;
  args.push(id);
  if (kind.extraWhere) sql += ` AND ${kind.extraWhere}`;

  let affected = 0;
  try {
    const result = await run(env, sql, ...args);
    affected = Number((result && result.meta && result.meta.changes) || 0);
  } catch (error) {
    console.error(`切换${kind.itemLabel}状态失败 kind=${kind.key} id=${id}`, error && error.message);
    return { success: false, message: '操作失败，请稍后重试' };
  }
  // 影响行数为 0 必须报错: 记录已被删 / 不满足 extraWhere / 状态没变化时,
  // 旧实现会照样提示"状态已更新", 运营以为改成功了
  if (!affected) {
    return { success: false, message: '未更新任何记录（可能已被删除、不满足操作条件，或状态未发生变化）' };
  }
  invalidateEntityCache(kind.cacheEntity);
  auditLog(kind.audit, { user: session.username, [kind.idKey]: id, status: wanted });
  return statusPayload(kind, wanted);
}

// 自检: 状态注册表与实体注册表必须双向对齐(旧站在启动时直接抛错)。
// 漏登记时"状态切换后清缓存"会静默失效, 页面上看不出来, 所以在测试里点名。
export function auditStatusKinds() {
  const problems = [];
  for (const [key, kind] of Object.entries(STATUS_KINDS)) {
    const declared = STATUS_KIND_ENTITY[key];
    if (!declared) problems.push(`状态 kind 未在实体注册表声明: ${key}`);
    else if (declared !== kind.cacheEntity) problems.push(`kind 与实体注册表的 cacheEntity 不一致: ${key}`);
  }
  return problems;
}
