// 小程序整包配置: /config/get_app_config (响应用 message 键, 并带 timestamp)
// 兜底常量取自旧站 fastapi/app/core/catalog.py, 保证"表空/查库失败"时首页不空白
import { okMessageWithTimestamp } from '../core/response.js';
import { all, one, str } from '../core/db.js';
import { assetUrl, iconAssetUrl } from '../core/media_scheme.js';
import { nowEpoch } from '../core/timeutil.js';

const NOTE_CATEGORIES = [
  { id: 'outdoor', name: '户外' }, { id: 'motorcycle', name: '摩旅' }, { id: 'fitness', name: '健身' },
  { id: 'skateboard', name: '滑板' }, { id: 'football', name: '足球' }, { id: 'swimming', name: '游泳' },
  { id: 'diving', name: '潜水' }, { id: 'food', name: '聚餐' }, { id: 'other', name: '其它' }
];

const HOME_SECTION_ORDER = ['main', 'ext'];

const DEFAULT_HOME_SECTIONS = [
  { key: 'main', items: [
    { id: 'outdoor', name: '户外', image_url: '/news_uploads/home/hw.jpg' },
    { id: 'motorcycle', name: '摩旅', image_url: '/news_uploads/home/ml.png' },
    { id: 'fitness', name: '健身', image_url: '/news_uploads/home/js.png' },
    { id: 'skateboard', name: '滑板', image_url: '/news_uploads/home/sk8.png' }
  ] },
  { key: 'ext', items: [
    { id: 'football', name: '足球', image_url: '/news_uploads/home/zq.jpg' },
    { id: 'swimming', name: '游泳', image_url: '/news_uploads/home/yy.jpg' },
    { id: 'diving', name: '潜水', image_url: '/news_uploads/home/qs.jpg' },
    { id: 'food', name: '聚餐', image_url: '/news_uploads/home/ms.jpg' }
  ] }
];

const DEFAULT_FEATURED = [
  { id: 'outdoor', name: '户外精选', image_url: 'https://gitee.com/iitbt/picui/raw/master/lyjx/hw.png', page_path: '/subpackages/content/outdoor/outdoor' },
  { id: 'motorcycle', name: '摩旅精选', image_url: 'https://gitee.com/iitbt/picui/raw/master/lyjx/moto.gif', page_path: '/subpackages/content/motorcycle/motorcycle' }
];

const DEFAULT_VERSION = { latest: '', min: '', update_tip: '发现新版本，更新后体验更好', update_content: '' };

const DEFAULT_TEXTS = {
  'login.wx_auth_info': '将获取您的微信公开信息（昵称、头像等）用于登录和账号关联，同时个性化您的使用体验。',
  'login.prompt': '需要微信登录才能使用小程序功能，是否现在授权登录？',
  'privacy.fallback': '本小程序仅收集您的微信昵称与头像用于展示身份，收集浏览/点赞/收藏记录用于向您展示个人记录。不会向第三方提供您的个人信息。',
  'agreement.content': '一、账号：使用微信登录即完成注册，你可以在「我的 → 注销账号」随时注销账号。\n二、使用：本小程序仅提供内容浏览、点赞、收藏等功能，不提供用户发布内容功能。\n三、隐私：我们仅收集展示身份所需的昵称与头像、以及你的浏览/点赞/收藏记录，不向第三方提供。\n四、免责：本小程序展示的笔记内容仅供参考；户外、摩旅等活动存在风险，请量力而行并做好安全防护。',
  'about.content': '一个记录户外、摩旅、健身的兴趣社区。\n\n问题反馈：请在微信中联系管理员。',
  'share.default_title': '狼牙极限运动笔记 - 户外·摩旅·健身',
  'share.default_image': '',
  'share.topic_template': '{title} - 狼牙极限运动笔记'
};

const DEFAULT_MENU = [
  { menu_key: 'likes', title: '我的点赞', icon: '/images/like.png', link_type: 'page', link_value: '/subpackages/content/like/like', need_login: 1, trusted_only: 0 },
  { menu_key: 'favorites', title: '我的收藏', icon: '/images/favorite.png', link_type: 'page', link_value: '/subpackages/content/favorites/favorites', need_login: 1, trusted_only: 0 },
  { menu_key: 'history', title: '浏览历史', icon: '/images/history.png', link_type: 'page', link_value: '/subpackages/content/history/history', need_login: 1, trusted_only: 0 },
  { menu_key: 'notices', title: '通知公告', icon: '/images/Notice.png', link_type: 'page', link_value: '/subpackages/content/notices/notices', need_login: 0, trusted_only: 0 },
  { menu_key: 'privacy', title: '隐私政策', icon: '/images/Privacy.png', link_type: 'action', link_value: 'show_privacy', need_login: 0, trusted_only: 0 },
  { menu_key: 'about', title: '关于与反馈', icon: '/images/About.png', link_type: 'action', link_value: 'show_about', need_login: 0, trusted_only: 0 },
  { menu_key: 'delete_account', title: '注销账号', icon: '/images/Delete.png', link_type: 'action', link_value: 'delete_account', need_login: 1, trusted_only: 0 }
];

const PAGE_PREFIXES = ['/pages/', '/subpackages/'];
const isPagePath = (value) => PAGE_PREFIXES.some((prefix) => str(value).startsWith(prefix));

async function safeAll(env, sql, ...args) {
  try {
    return await all(env, sql, ...args);
  } catch (error) {
    return null;
  }
}

export function registerAppConfigRoutes(router) {
  router.any('/config/get_app_config', async (request, env) => {
    // 分类: 表空/异常回退内置
    const categoryRows = await safeAll(env, 'SELECT category_key, name FROM app_categories WHERE status=1 ORDER BY sort_order ASC, id ASC');
    const categories = (categoryRows && categoryRows.length ? categoryRows : NOTE_CATEGORIES)
      .map((row) => ({ id: str(row.category_key || row.id), name: str(row.name) }));
    const nameOf = {};
    categories.forEach((item) => { nameOf[item.id] = item.name; });

    // 首页板块: 只取启用行, 顺序固定 main → ext, 名称实时取自分类表
    const sectionRows = await safeAll(env, 'SELECT section_key,item_id,image_url,status FROM app_home_sections ORDER BY section_key ASC, sort_order ASC, id ASC');
    const flatSections = [];
    if (sectionRows && sectionRows.length) {
      sectionRows.forEach((row) => {
        if (Number(row.status) !== 1) return;
        flatSections.push({ key: str(row.section_key), id: str(row.item_id), image_url: str(row.image_url) });
      });
    } else {
      DEFAULT_HOME_SECTIONS.forEach((section) => {
        section.items.forEach((item) => {
          flatSections.push({ key: section.key, id: item.id, image_url: item.image_url });
        });
      });
    }
    const homeSections = [];
    HOME_SECTION_ORDER.forEach((key) => {
      const items = flatSections.filter((row) => row.key === key);
      if (!items.length) return;
      homeSections.push({
        key,
        items: items.map((row) => ({
          id: row.id,
          name: nameOf[row.id] || row.id,
          icon: assetUrl(env, row.image_url, '')
        }))
      });
    });

    // 精选: 独立模块, 只取启用行
    const featuredRows = await safeAll(env, 'SELECT item_key,name,image_url,page_path,status FROM app_featured_items ORDER BY sort_order ASC, id ASC');
    const featuredSource = featuredRows && featuredRows.length ? featuredRows : DEFAULT_FEATURED;
    const featured = featuredSource
      .filter((row) => Number(row.status === undefined ? 1 : row.status) === 1)
      .map((row) => ({
        id: str(row.item_key || row.id),
        name: str(row.name),
        image: assetUrl(env, row.image_url),
        page_path: str(row.page_path)
      }));

    // 版本更新配置
    const versionRow = await one(env, 'SELECT latest_version,min_version,update_tip,update_content FROM app_version_config WHERE id=1').catch(() => null);
    const version = versionRow ? {
      latest: str(versionRow.latest_version),
      min: str(versionRow.min_version),
      update_tip: str(versionRow.update_tip) || DEFAULT_VERSION.update_tip,
      update_content: str(versionRow.update_content)
    } : Object.assign({}, DEFAULT_VERSION);

    // 文案: 内置打底, 库中启用行覆盖
    const textRows = await safeAll(env, 'SELECT text_key,content,status FROM app_texts ORDER BY group_name ASC, sort_order ASC, id ASC');
    const texts = Object.assign({}, DEFAULT_TEXTS);
    (textRows || []).forEach((row) => {
      if (Number(row.status) !== 1) return;
      const key = str(row.text_key);
      if (key) texts[key] = str(row.content);
    });

    // 菜单: 只取启用行, page 型必须是小程序页面路径, 图标 /images/ 前缀原样
    const menuRows = await safeAll(env, 'SELECT menu_key,title,icon,link_type,link_value,need_login,trusted_only,status FROM app_menu_items ORDER BY sort_order ASC, id ASC');
    const menuSource = menuRows && menuRows.length ? menuRows : DEFAULT_MENU;
    const menu = menuSource
      .filter((row) => Number(row.status === undefined ? 1 : row.status) === 1)
      .filter((row) => str(row.link_type) !== 'page' || isPagePath(row.link_value))
      .map((row) => ({
        key: str(row.menu_key),
        title: str(row.title),
        icon: iconAssetUrl(env, row.icon),
        link_type: str(row.link_type) || 'page',
        link_value: str(row.link_value),
        need_login: Number(row.need_login) === 1,
        trusted_only: Number(row.trusted_only) === 1
      }));

    return okMessageWithTimestamp(
      { categories, home_sections: homeSections, featured, version, texts, menu },
      '获取应用配置成功',
      nowEpoch()
    );
  });
}
