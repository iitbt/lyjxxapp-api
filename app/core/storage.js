// 素材存储(R2) —— 对照旧站 app/core/storage.py
//
// 旧站 storage.py 管三件事: 目录扫描(素材清单)、删除文件、路径归一化; 素材治理页与素材库弹窗都调它,
// 所以"素材清单只有一份实现"是旧站的硬约定(media_admin.py 头注释: 引用判定也只有一个来源)。
// Cloudflare 侧对应关系:
//   os.walk(目录)      → R2 桶 list({ prefix, cursor })
//   os.remove(文件)    → R2 桶 delete(key)
//   文件 mtime/size    → 对象 uploaded/size
import { settings } from './config.js';
import { MAX_SCAN_OBJECTS } from './overview.js';

//: 素材目录(真值只在这里): 新上传按类型分开, 历史素材留在旧目录继续读, 不搬动已有对象
export const IMAGE_PREFIX = 'image/';
export const VIDEO_PREFIX = 'video/';
export const AVATAR_PREFIX = 'avatar/';
export const LEGACY_PREFIX = 'news_uploads/';
export const LEGACY_AVATAR_PREFIX = 'avatar_uploads/';

//: 素材(图片/视频)目录清单: 新目录 + 旧目录(列举与引用判定都要覆盖两者, 否则历史素材会"消失")
export const MEDIA_PREFIXES = [IMAGE_PREFIX, VIDEO_PREFIX, LEGACY_PREFIX];

//: Worker 直出的路径前缀(页面与小程序拿到的地址都落在这里; 含历史目录, 老数据不用迁)
export const SERVED_PREFIXES = ['/images/', '/avatar/', '/avatar_uploads/', ...MEDIA_PREFIXES.map((prefix) => `/${prefix}`)];

/** 某一类素材该扫哪些目录(新目录按类型分开, 历史素材都混放在旧目录)。 */
export function mediaPrefixesFor(kind) {
  return kind === 'video' ? [VIDEO_PREFIX, LEGACY_PREFIX] : [IMAGE_PREFIX, LEGACY_PREFIX];
}

/** 取相对路径所在的素材目录(不在任何素材目录下就返回空串)。 */
export function mediaPrefixOf(relativePath) {
  const text = String(relativePath || '');
  return MEDIA_PREFIXES.find((prefix) => text.startsWith(prefix)) || '';
}

/** 缩略图 key: 目录随原图走 —— <素材目录>_thumb/<宽度>/<文件名>.webp(Cloudflare 侧只读, 不生成)。 */
export function thumbKeyOf(relativePath, width = 480) {
  const text = String(relativePath || '').replace(/^\/+/, '');
  if (text.includes('/_thumb/')) return text;
  const prefix = mediaPrefixOf(text);
  if (!prefix) return '';
  const name = text.split('/').pop();
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${prefix}_thumb/${width}/${stem}.webp`;
}

//: 可列举的图片/视频扩展名(与旧站 storage.LISTABLE_*_EXTS 同口径)
export const LISTABLE_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
export const LISTABLE_VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'ts', 'm3u8', '3gp', 'avi', 'flv', 'wmv', 'f4v'];

export function extOf(name) {
  const text = String(name || '');
  const dot = text.lastIndexOf('.');
  return dot < 0 ? '' : text.slice(dot + 1).toLowerCase();
}

/** 扩展名 → 'video' | 'image' | ''(与旧站 kind 判定一致, 顺序: 先视频)。 */
export function kindOfExt(ext) {
  const value = String(ext || '').toLowerCase();
  if (LISTABLE_VIDEO_EXTS.includes(value)) return 'video';
  if (LISTABLE_IMAGE_EXTS.includes(value)) return 'image';
  return '';
}

/** 枚举 kind 对应的扩展名白名单(素材库弹窗的 accept 用)。 */
export function listableExts(kind) {
  return kind === 'video' ? LISTABLE_VIDEO_EXTS : LISTABLE_IMAGE_EXTS;
}

/**
 * 素材清单: 列该类型的原始文件(跳过 _thumb/ 派生文件), 按修改时间倒序。
 *
 * 为什么分页: R2 单次 list 上限 1000; 旧站扫描也有 _MAX_SCAN_FILES 上限, 两边都只"尽量数清",
 * 数不清时返回 truncated=true 让页面标注"至少这么多", 不编数字。
 */
export async function listNewsMedia(env, kind = 'image', options = {}) {
  const max = options.max || MAX_SCAN_OBJECTS;
  const wanted = kind === 'video' ? 'video' : 'image';
  const items = [];
  let truncated = false;
  try {
    // 逐目录逐页拉取: 单次 1000 上限, 直到取够 max+1 或没有 next 游标
    for (const prefix of mediaPrefixesFor(wanted)) {
      let cursor;
      for (let round = 0; round < 5; round += 1) {
        const listed = await settings(env).storage.list({ prefix, limit: 1000, cursor });
        const objects = (listed && listed.objects) || [];
        for (const object of objects) {
          const key = String(object.key || '');
          if (!key || !key.startsWith(prefix) || key.includes('/_thumb/')) continue;
          if (kindOfExt(extOf(key)) !== wanted) continue;
          items.push({
            path: key,
            name: key.slice(prefix.length),
            dir: prefix.replace(/\/$/, ''),
            kind: wanted,
            size: Number(object.size) || 0,
            mtime: object.uploaded ? new Date(object.uploaded).getTime() : 0,
            uploaded: object.uploaded || ''
          });
        }
        cursor = listed && listed.truncated ? listed.cursor : undefined;
        if (!cursor || items.length > max) break;
      }
      if (items.length > max) break;
    }
  } catch (error) {
    console.error('列举素材失败', error && error.message);
    return { items: [], total: 0, truncated: false, failed: true };
  }
  items.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  truncated = items.length > max;
  const used = truncated ? items.slice(0, max) : items;
  return { items: used, total: used.length, truncated, failed: false };
}

/** R2 素材占用(与系统信息/素材治理页共用一个口径)。 */
export async function mediaUsage(env) {
  const listed = await listNewsMedia(env, 'image');
  const videos = await listNewsMedia(env, 'video');
  if (listed.failed && videos.failed) {
    return { count: 0, bytes: 0, truncated: false, failed: true };
  }
  const all = listed.items.concat(videos.items);
  let bytes = 0;
  for (const item of all) bytes += Number(item.size) || 0;
  return {
    count: all.length,
    bytes,
    truncated: Boolean(listed.truncated || videos.truncated),
    failed: false
  };
}

/** 删除素材对象(调用方必须先做完引用检查 —— 删了不可恢复)。 */
export async function removeMediaFile(env, relativePath) {
  const key = normRel(relativePath);
  if (!key || key.includes('..')) return false;
  await settings(env).storage.delete(key);
  return true;
}

/**
 * 把"可能装着素材路径的字符串"规整成库内相对记录值; 不是素材则返回空串。
 *
 * 库里同一个素材有几种历史形态, **必须先归一化再比较**(旧站 storage/media_admin 同口径):
 *   news_uploads/a.png / /news_uploads/a.png / https://host/news_uploads/a.png /
 *   <wx-video src="news_uploads/a.mp4">…(富文本里的一段)
 */
export function normRel(value) {
  let text = String(value === undefined || value === null ? '' : value).trim().replace(/^["']|["']$/g, '');
  if (!text) return '';
  text = text.split('?')[0].split('#')[0].replace(/\\/g, '/');
  // 可能整串是绝对地址, 也可能是富文本里的一段: 从最早出现的那个素材目录开始截
  const offsets = MEDIA_PREFIXES.map((prefix) => text.indexOf(prefix)).filter((at) => at > 0);
  if (offsets.length) text = text.slice(Math.min(...offsets));
  text = text.replace(/^\/+/, '');
  if (!mediaPrefixOf(text) || text.includes('..')) return '';
  return text;
}

//: 从富文本 HTML 里抽素材路径: 认全部素材目录、到引号/空白/尖括号/括号为止的一段
const RICH_PATH_RE = new RegExp(`(?:${MEDIA_PREFIXES.join('|')})[^\\s"'<>()[\\]{},;]+`, 'gi');

/** 从一个字段值里抽出**所有**素材相对记录值(富文本可能引用多个)。 */
export function relPathsIn(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (!text || !MEDIA_PREFIXES.some((prefix) => text.includes(prefix))) return [];
  if (text.includes('<') || text.includes('>')) {
    return RICH_PATH_RE_SAFE(text).map(normRel).filter(Boolean);
  }
  const one = normRel(text);
  return one ? [one] : [];
}

// 每次调用重置 lastIndex, 避免全局正则跨次匹配出现漏项
function RICH_PATH_RE_SAFE(text) {
  RICH_PATH_RE.lastIndex = 0;
  return Array.from(text.matchAll(RICH_PATH_RE), (match) => match[0]);
}

/** 预览/下载用的绝对地址由 media_scheme 负责, 这里只做 key 到公开 URL 的拼接(公开域)。 */
export function publicUrl(mediaBase, relativePath) {
  const base = String(mediaBase || '').replace(/\/+$/, '');
  const key = String(relativePath || '').replace(/^\/+/, '');
  if (!base || !key) return '';
  return `${base}/${key}`;
}
