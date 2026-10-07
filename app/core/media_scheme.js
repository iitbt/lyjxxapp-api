// 素材地址: 库里只存相对路径, 下发时拼绝对地址; 素材本体走 R2 公开域(storage.250036.xyz)
import { settings } from './config.js';
import { normRel, thumbKeyOf } from './storage.js';

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

//: 预览页用的宽度(与旧站 render.py 的 PREVIEW_BODY_THUMB_WIDTH 同值): 预览框就是 800px 宽
export const PREVIEW_BODY_THUMB_WIDTH = 800;
//: 正文配图最多替换几张: 旧站逐个探测、没有上限, 而 Workers 每次请求的子请求数有限,
//: 所以这里按预算封顶 —— 超出的图保持原图(只是加载慢一点, 页面照常)
const PREVIEW_BODY_THUMB_MAX = 30;

/** 站内素材地址: 配了素材域就拼绝对地址, 没配就给站点根路径(后台页在 /admin/ 下, 相对地址会解析错)。 */
function stationUrl(env, value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text) || /^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  return mediaBase(env) ? assetUrl(env, text) : `/${text.replace(/^\/+/, '')}`;
}

/** 该素材在 R2 里有没有指定宽度的缩略图(探测失败一律当"没有")。 */
async function hasThumb(env, value, width) {
  const rel = normRel(value);
  const key = rel ? thumbKeyOf(rel, width) : '';
  if (!key) return '';
  try {
    return (await settings(env).storage.head(key)) ? key : '';
  } catch (error) {
    return '';
  }
}

/** 预览用地址: 有 800px 缩略图就用缩略图, 否则回退原地址(与旧站 media_thumb_url 同口径)。 */
export async function previewThumbUrl(env, value, width = PREVIEW_BODY_THUMB_WIDTH) {
  const key = await hasThumb(env, value, width);
  return stationUrl(env, key || value);
}

/**
 * 正文里的本地配图换成同宽缩略图(只影响本次渲染, 不改库、不改地址形态)。
 * 本站素材单张可达数十 MB, 预览页直取原图会等几十秒; 预览框只有 800px 宽, 用 800px 缩略图看不出差别。
 * 只给**只读**的预览页用: 编辑页不能这么做(编辑器会把当前 DOM 回存, 存进去就变成缩略图路径了)。
 */
export async function previewBodyThumbs(env, html, width = PREVIEW_BODY_THUMB_WIDTH, max = PREVIEW_BODY_THUMB_MAX) {
  const text = String(html || '');
  const srcs = [...new Set([...text.matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]))]
    .slice(0, max);
  if (!srcs.length) return text;
  const swapped = new Map();
  await Promise.all(srcs.map(async (src) => {
    const key = await hasThumb(env, src, width);
    if (key) swapped.set(src, stationUrl(env, key));
  }));
  if (!swapped.size) return text;
  return text.replace(/(<img\b[^>]*?\ssrc\s*=\s*["'])([^"']+)(["'])/gi,
    (whole, head, src, tail) => (swapped.has(src) ? head + swapped.get(src) + tail : whole));
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
