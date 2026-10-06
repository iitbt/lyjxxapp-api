// 富文本正文的媒体处理: 视频标签来回转换 + 摘要生成(照搬旧站 app/api/helpers.py 的唯一实现)
//
// 为什么必须转换: 库内视频按小程序约定存成自定义标签 `<wx-video src="news_uploads/x.mp4" ...>`,
// 浏览器与富文本编辑器都不认识它 —— 直接拿到编辑页会被编辑器丢掉("打开看不到视频, 一保存就没了"),
// 预览页则什么都不显示。所以三处复用同一套转换: 编辑页回显 / 入库还原 / 预览页渲染。
import { assetUrl } from '../../core/media_scheme.js';
import { AVATAR_PREFIX, LEGACY_AVATAR_PREFIX, MEDIA_PREFIXES } from '../../core/storage.js';
import { strOf } from './utils.js';

const WX_VIDEO_TAG_RE = /<wx-video\b[^>]*>\s*(?:<\/wx-video\s*>)?/gi;
const VIDEO_BLOCK_RE = /<video\b[^>]*>[\s\S]*?<\/video\s*>|<video\b[^>]*>/gi;
const VIDEO_WRAPPER_RE = /<div\b([^>]*)>\s*(<video\b[\s\S]*?<\/video\s*>)\s*<\/div>/gi;
const SOURCE_TAG_RE = /<source\b[^>]*>/gi;
const DATA_WE_ATTR_RE = /data-w-e-[a-z-]+(?:\s*=\s*["'][^"']*["'])?/gi;
const TAG_ATTR_RE = /([a-zA-Z-:]+)\s*=\s*(["'])(.*?)\2/g;
const IMG_TAG_RE = /(<img\b[^>]*\bsrc=)(["'])([^"']+)\2/gi;

// 站内素材目录(真值在 core/storage.js): 新目录 image//video/ 与历史 news_uploads/ 都要能来回转换,
// 否则新上传的图片/视频会带着前导 "/" 落库、或回显时被解析到 /admin/ 下而裂图
const STATION_REL_PREFIXES = MEDIA_PREFIXES.concat([AVATAR_PREFIX, LEGACY_AVATAR_PREFIX]);

// 只搬运双方都认的属性; wx-video 侧补回与库内历史数据同形的属性(都在净化白名单里)
const WX_VIDEO_ATTRS = ['src', 'poster', 'controls', 'show-center-play-btn', 'show-play-btn', 'object-fit'];
const BROWSER_VIDEO_ATTRS = ['src', 'poster', 'controls', 'playsinline', 'preload'];

function readAttrs(tag) {
  const attrs = {};
  for (const match of String(tag || '').matchAll(TAG_ATTR_RE)) {
    attrs[match[1].toLowerCase()] = match[3];
  }
  return attrs;
}

function buildTag(name, allowed, attrs) {
  const parts = [];
  for (const key of allowed) {
    const value = attrs[key];
    if (value !== undefined && value !== '') parts.push(`${key}="${String(value).replace(/"/g, '&quot;')}"`);
  }
  return `<${name}${parts.length ? ` ${parts.join(' ')}` : ''}>`;
}

// 站内相对素材 → 可访问地址: base 为空时给根路径(编辑页在 /admin/ 下, 相对地址会解析错), 否则拼绝对地址
function srcForBrowser(src, base) {
  const text = strOf(src).trim();
  if (!text || !STATION_REL_PREFIXES.some((prefix) => text.startsWith(prefix))) return text;
  return base ? assetUrl({ MEDIA_BASE: base }, text) : `/${text}`;
}

// 浏览器/编辑器地址 → 数据库相对记录值(与图片同口径: 库里只存相对路径)
function srcForStorage(src) {
  const text = strOf(src).trim();
  for (const prefix of STATION_REL_PREFIXES) {
    if (text.startsWith(`/${prefix}`)) return text.slice(1);
  }
  // 完整地址(含媒体域/站点域)里取出相对部分
  const matched = new RegExp(`https?://[^/]+/((?:${STATION_REL_PREFIXES.join('|')})[^"'\\s]*)`, 'i').exec(text);
  return matched ? matched[1] : text;
}

// 摘要: 去掉标签取前 100 字, 超出补省略号(旧站 _plain_desc 同口径)
export function plainDesc(html) {
  const text = strOf(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 100 ? `${text.slice(0, 100)}...` : text;
}

// `<wx-video>` → `<video controls playsinline preload="metadata">`: 给浏览器侧(编辑页回显 / 预览页)
// 没有 src 的直接删掉 —— 空标签在编辑器里是个"看不见但会吃掉正文"的坑
export function videoForBrowser(html, base = '') {
  const text = strOf(html);
  if (!text || !/wx-video/i.test(text)) return text;
  return text.replace(WX_VIDEO_TAG_RE, (whole) => {
    const attrs = readAttrs(whole);
    const src = srcForBrowser(attrs.src, base);
    if (!src) return '';
    const next = Object.assign({}, attrs, { src, controls: 'controls', playsinline: 'playsinline', preload: 'metadata' });
    if (attrs.poster) next.poster = srcForBrowser(attrs.poster, base);
    return buildTag('video', BROWSER_VIDEO_ATTRS, next) + '</video>';
  });
}

// 编辑页回显用: 与预览页同一转换, 但地址给站点根路径
export function videoForEditor(html) {
  return videoForBrowser(html, '');
}

// `<video>`(编辑器产物) → `<wx-video>`: 入库前还原成小程序约定的存储格式
// 编辑器的产物是带容器 div 与嵌套 <source src> 的整块, 地址往往在 source 上 —— 两种都要认
export function videoForStorage(html) {
  const text = strOf(html);
  if (!text || !/video/i.test(text)) return text;
  // 先拆掉纯容器 div(只对编辑器有意义, 落库会留个空块); 带 class/style 等其它属性的一律不拆
  const unwrapped = text.replace(VIDEO_WRAPPER_RE, (whole, attrs, inner) => {
    const leftover = strOf(attrs).replace(DATA_WE_ATTR_RE, '').trim();
    return leftover ? whole : inner;
  });
  return unwrapped.replace(VIDEO_BLOCK_RE, (block) => {
    const openEnd = block.indexOf('>');
    const openTag = openEnd >= 0 ? block.slice(0, openEnd + 1) : block;
    const attrs = readAttrs(openTag);
    let src = attrs.src || '';
    if (!src) {
      for (const tag of block.match(SOURCE_TAG_RE) || []) {
        const found = readAttrs(tag).src;
        if (found) { src = found; break; }
      }
    }
    src = srcForStorage(src);
    if (!src) return '';
    const next = {
      src,
      poster: attrs.poster ? srcForStorage(attrs.poster) : '',
      controls: 'true',
      'show-center-play-btn': 'true',
      'show-play-btn': 'true',
      'object-fit': 'cover'
    };
    return buildTag('wx-video', WX_VIDEO_ATTRS, next);
  });
}

// 正文里的图片绝对地址 → 相对记录值(入库前调用, 保持"库内只存相对路径")
export function imagesForStorage(html) {
  return strOf(html).replace(IMG_TAG_RE, (whole, head, quote, src) => head + quote + srcForStorage(src) + quote);
}
