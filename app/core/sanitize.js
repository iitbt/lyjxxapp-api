// 富文本净化: 旧站在无 nh3 时走加固正则, 这里同口径(白名单标签 + 去事件属性 + 去危险协议)
import { assetUrl } from './media_scheme.js';

// wx-video/video/source: 后台正文里的视频容器。库内约定存 <wx-video>, 编辑/预览时转成 <video>
// —— 不放行它们, 后台保存一次笔记就会把整段视频删掉
const ALLOWED = new Set(['p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's',
  'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'img', 'a', 'section', 'figure', 'figcaption',
  'wx-video', 'video', 'source']);

// 各标签允许保留的属性(其余一律丢掉): 只留渲染真正需要的
const KEEP_ATTRS = {
  img: ['src', 'alt'],
  a: ['href'],
  'wx-video': ['src', 'poster', 'controls', 'show-center-play-btn', 'show-play-btn', 'object-fit'],
  video: ['src', 'poster', 'controls', 'playsinline', 'preload', 'width', 'height'],
  source: ['src', 'type']
};

function attrOf(rest, name) {
  const matched = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(rest);
  if (!matched) return '';
  return String(matched[2] || matched[3] || '').replace(/"/g, '&quot;');
}

export function sanitizeHtml(input) {
  let text = String(input === undefined || input === null ? '' : input);
  // 整块去掉脚本/样式/内嵌框架
  text = text.replace(/<(script|style|iframe|object|embed|link|meta)[\s\S]*?<\/\1\s*>/gi, '');
  text = text.replace(/<(script|style|iframe|object|embed|link|meta)[^>]*\/?>/gi, '');
  // 事件属性与 javascript: 协议
  text = text.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  text = text.replace(/(href|src)\s*=\s*("|')\s*(javascript|data):[^"']*\2/gi, '$1="#"');
  // 标签白名单: 其余标签只留文字; 标签名允许连字符(否则 wx-video 这类自定义标签匹配不到)
  text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (match, tagName, rest) => {
    const name = String(tagName).toLowerCase();
    if (!ALLOWED.has(name)) return '';
    if (match.startsWith('</')) return `</${name}>`;
    const keep = [];
    for (const attr of KEEP_ATTRS[name] || []) {
      const value = attrOf(rest, attr);
      if (value) keep.push(`${attr}="${value}"`);
    }
    return `<${name}${keep.length ? ` ${keep.join(' ')}` : ''}>`;
  });
  return text;
}

// 正文里的图片改写成绝对地址(库里存的是相对路径)
export function absolutizeImages(env, htmlText) {
  return String(htmlText || '').replace(/(<img[^>]+src=["'])([^"']+)(["'])/gi,
    (all, head, src, tail) => head + assetUrl(env, src) + tail);
}
