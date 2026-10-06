// 素材地址: 库里只存相对路径, 下发时拼绝对地址; 素材本体走 R2 公开域(storage.250036.xyz)
import { settings } from './config.js';
import { thumbKeyOf } from './storage.js';

export const NEWS_COVER_THUMB_WIDTH = 480;

export function mediaBase(env) {
  return settings(env).mediaBase.replace(/\/+$/, '');
}

// 与旧站 asset_url 同口径: 空→default; http(s) 原样; 其它协议(wxfile://, data:) 原样; 相对路径拼媒体域
export function assetUrl(env, value, fallback = '') {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return fallback;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  const base = mediaBase(env);
  if (!base) return text;
  return `${base}/${text.replace(/^\/+/, '')}`;
}

// 菜单/精选图标: /images/ 开头的是包内资源, 原样下发
export function iconAssetUrl(env, value, fallback = '') {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (text.startsWith('/images/')) return text;
  return assetUrl(env, text, fallback);
}

// 缩略图口径: 目录随原图走(<素材目录>_thumb/<宽度>/), 外链与非素材路径不下发缩略图
export function thumbKey(relativePath, width = NEWS_COVER_THUMB_WIDTH) {
  const text = String(relativePath || '').trim();
  if (!text || text.includes('://')) return '';
  return thumbKeyOf(text, width);
}

// 缩略图存在才下发 image_thumb, 不存在则该键完全不出现(旧站行为, 小程序回退原图)
// 上限 20 个并发 head: 免费套餐单请求子请求数有限, 超出部分直接不发缩略图
export async function existingThumbs(env, rows, width = NEWS_COVER_THUMB_WIDTH, max = 20) {
  const picked = rows.slice(0, max).map((row) => thumbKey(row && row.image, width));
  const checks = await Promise.all(picked.map(async (key) => {
    if (!key) return false;
    try {
      return !!(await settings(env).storage.head(key));
    } catch (error) {
      return false;
    }
  }));
  return checks;
}

// R2 上传: 头像与后台图片统一走这里
export async function putObject(env, key, body, contentType) {
  await settings(env).storage.put(key, body, { httpMetadata: { contentType } });
  return key;
}
