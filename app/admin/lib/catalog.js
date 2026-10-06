// 后台用到的目录/文案/菜单常量: 唯一来源(照搬旧站 fastapi/app/core/catalog.py)
// 为什么放这里而不是各页面各写一份: 这些值同时被"后台下拉/服务端校验/下发接口"三方读,
// 分散声明就会漂移 —— 旧站为此专门写了三处对齐的注释
import { strOf } from './utils.js';

// 运营文案分组(后台筛选用; 顺序即展示顺序)
export const TEXT_GROUPS = ['登录授权', '隐私与关于', '分享'];

// 内置文案的 key 清单: 用于判断"表里缺哪些内置文案"(接口正在用内置默认值)
// 只留 key —— 具体文案由小程序端兜底, 后台不需要它的正文
export const BUILTIN_TEXT_KEYS = [
  'login.wx_auth_info',
  'login.prompt',
  'privacy.fallback',
  'agreement.content',
  'share.default_title',
  'share.default_image',
  'share.topic_template'
];

// 内置菜单项(「补齐内置菜单项」按钮的写入来源; 已有 key 一律不动)
export const DEFAULT_APP_MENU = [
  {
    menu_key: 'likes', title: '我的点赞', icon: '/images/like.png', link_type: 'page',
    link_value: '/subpackages/content/like/like', need_login: 1, trusted_only: 0, sort_order: 10
  },
  {
    menu_key: 'favorites', title: '我的收藏', icon: '/images/favorite.png', link_type: 'page',
    link_value: '/subpackages/content/favorites/favorites', need_login: 1, trusted_only: 0, sort_order: 20
  },
  {
    menu_key: 'history', title: '浏览历史', icon: '/images/history.png', link_type: 'page',
    link_value: '/subpackages/content/history/history', need_login: 1, trusted_only: 0, sort_order: 30
  },
  {
    menu_key: 'notices', title: '通知公告', icon: '/images/Notice.png', link_type: 'page',
    link_value: '/subpackages/content/notices/notices', need_login: 0, trusted_only: 0, sort_order: 40
  },
  {
    menu_key: 'privacy', title: '隐私政策', icon: '/images/Privacy.png', link_type: 'action',
    link_value: 'show_privacy', need_login: 0, trusted_only: 0, sort_order: 50
  },
  {
    menu_key: 'about', title: '关于与反馈', icon: '/images/About.png', link_type: 'action',
    link_value: 'show_about', need_login: 0, trusted_only: 0, sort_order: 60
  },
  {
    menu_key: 'delete_account', title: '注销账号', icon: '/images/Delete.png', link_type: 'action',
    link_value: 'delete_account', need_login: 1, trusted_only: 0, sort_order: 70
  }
];

// 允许配置的"内置动作"(后台下拉 + 服务端校验共用)
export const MENU_ACTIONS = [
  ['show_privacy', '显示隐私政策'],
  ['show_about', '显示关于与反馈'],
  ['delete_account', '注销账号（需二次确认）']
];

// 菜单可见性(同时是接口字段 need_login 的正式语义: 0 未登录可见 / 1 登录可见)
export const MENU_VISIBILITY = [
  ['0', '未登录可见'],
  ['1', '登录可见']
];

// 必须设为"登录可见"的动作(未登录的人根本没账号可注销)
export const LOGIN_REQUIRED_ACTIONS = new Set(['delete_account']);

// 跳转类型
export const MENU_LINK_TYPES = [['page', '页面路径'], ['action', '内置动作']];

// 小程序页面路径前缀: 主包与分包都算合法(旧路径要保留兼容, 分享卡片还指向它们)
export const PAGE_PATH_PREFIXES = ['/pages/', '/subpackages/'];

// 包内图标前缀: 全站媒体地址规则的唯一例外(命中则原样下发, 不拼站点域名)
export const MENU_LOCAL_ICON_PREFIX = '/images/';

export const isPagePath = (value) => PAGE_PATH_PREFIXES.some((prefix) => strOf(value).startsWith(prefix));

export const pagePathHint = () => PAGE_PATH_PREFIXES.join(' 或 ');

// 版本更新配置的默认值(表里还没有这一行时用它渲染)
export const DEFAULT_VERSION_INFO = {
  latest_version: '',
  min_version: '',
  update_tip: '发现新版本，更新后体验更好',
  update_content: ''
};

export const menuActionLabel = (value) => {
  const found = MENU_ACTIONS.find(([key]) => key === strOf(value));
  return found ? found[1] : strOf(value);
};
