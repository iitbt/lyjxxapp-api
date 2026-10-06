// 上传与素材库: 旧站把文件写到本地磁盘, 这里写到 R2(桶 lyjxxapp-r2, 公开域 media.250036.xyz)
// 关键差异: Workers 没有 Pillow, 上传时**不生成缩略图** —— 列表按"有则用、无则回退原图"的口径自动降级
// 白名单与大小上限照旧站 core/storage.py: 图片 8MB / 视频 64MB, 并且**不看扩展名只看内容**(前端 accept 可绕过)
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
export const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm'];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

// 素材库能"列出来"的扩展名(比上传白名单宽: 历史素材里有 bmp/avi 这类)
export const LISTABLE_IMAGE_EXTS = IMAGE_EXTS.concat(['bmp']);
export const LISTABLE_VIDEO_EXTS = VIDEO_EXTS.concat(['mkv', 'ts', 'm3u8', '3gp', 'avi', 'flv', 'wmv', 'f4v']);

const NEWS_PREFIX = 'news_uploads/';
const THUMB_WIDTH = 480;

export function extOf(name) {
  const text = String(name || '').toLowerCase();
  const dot = text.lastIndexOf('.');
  return dot < 0 ? '' : text.slice(dot + 1);
}

export function kindOfExt(ext) {
  const value = String(ext || '').toLowerCase();
  if (LISTABLE_VIDEO_EXTS.includes(value)) return 'video';
  if (LISTABLE_IMAGE_EXTS.includes(value)) return 'image';
  return '';
}

// 内容嗅探: 图片看 RIFF/WEBP、JPEG、PNG、GIF8、BM
export function looksLikeImage(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const head = bytes;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;                     // JPEG
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true; // PNG
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return true; // GIF8
  if (head[0] === 0x42 && head[1] === 0x4d) return true;                                        // BM
  if (bytes.length >= 12
    && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46      // RIFF
    && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return true; // WEBP
  return false;
}

// 内容嗅探: 视频看 ISO-BMFF(ftyp/moov/…)或 EBML(webm/mkv)
export function looksLikeVideo(bytes) {
  if (!bytes || bytes.length < 12) return false;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true; // EBML
  const brand = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  return ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(brand);
}

function reject(message) {
  return { ok: false, message };
}

// 保存一次上传。返回 { ok, url, message }; url 是**相对记录值**(如 news_uploads/cover_123.png),
// 与旧站一致, 可直接写进数据库字段(下发时再拼媒体域)
export async function saveUpload(env, options) {
  const file = options.file;
  const purpose = String(options.purpose || 'cover');
  if (!file || typeof file.arrayBuffer !== 'function') return reject('未收到文件');
  const isVideoPurpose = purpose === 'video';
  const ext = extOf(file.name);
  const size = Number(file.size) || 0;

  if (isVideoPurpose && !VIDEO_EXTS.includes(ext)) {
    return reject('该字段只能上传视频（支持 mp4 / mov / m4v / webm）');
  }
  if (!isVideoPurpose && !IMAGE_EXTS.includes(ext)) {
    return reject('该字段只能上传图片，视频请改用「视频素材库」或正文区的「本地上传」');
  }

  const limit = isVideoPurpose ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (size > limit) return reject(`文件过大，最大允许 ${Math.floor(limit / 1024 / 1024)} MB`);

  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    return reject('文件读取失败，请重新上传');
  }
  const sniffOk = isVideoPurpose ? looksLikeVideo(bytes) : looksLikeImage(bytes);
  if (!sniffOk) {
    return reject(isVideoPurpose ? '文件内容不是有效视频，请重新上传' : '文件内容不是有效图片，请重新上传');
  }

  const prefix = isVideoPurpose ? 'video' : ({ cover: 'cover', content: 'content' }[purpose] || 'img');
  const name = `${prefix}_${Date.now()}.${ext}`;
  const key = `${NEWS_PREFIX}${name}`;
  try {
    await env.MEDIA.put(key, bytes, {
      httpMetadata: { contentType: file.type || (isVideoPurpose ? 'video/mp4' : 'image/jpeg') }
    });
  } catch (error) {
    console.error('上传写 R2 失败', error && error.message);
    return reject('保存失败，请稍后重试');
  }
  return { ok: true, url: key, message: '上传成功' };
}

// 素材库列举: R2 没有目录, 靠"前缀 + 扩展名"分类(与旧站按扩展名分图片/视频同口径)
// 单次最多 1000 个对象(R2 list 的页大小), 后台素材量级远小于此, 不做分页
export async function listMedia(env, kind, query) {
  const wanted = kind === 'video' ? 'video' : 'image';
  const keyword = String(query || '').trim().toLowerCase();
  let objects = [];
  try {
    const listed = await env.MEDIA.list({ prefix: NEWS_PREFIX, limit: 1000 });
    objects = (listed && listed.objects) || [];
  } catch (error) {
    console.error('列举素材失败', error && error.message);
    return { success: false, message: '读取素材失败，请稍后重试' };
  }
  const items = [];
  for (const object of objects) {
    const key = String(object.key || '');
    if (!key.startsWith(NEWS_PREFIX)) continue;
    const relative = key.slice(NEWS_PREFIX.length);
    if (relative.startsWith('_thumb/')) continue;          // 缩略图不算素材
    const ext = extOf(relative);
    if (kindOfExt(ext) !== wanted) continue;
    if (keyword && !relative.toLowerCase().includes(keyword)) continue;
    items.push({
      path: key,
      name: relative,
      size: Number(object.size) || 0,
      mtime: object.uploaded ? new Date(object.uploaded).toISOString() : ''
    });
  }
  // 按时间倒序(最近的素材排前面), 与旧站一致
  items.sort((left, right) => String(right.mtime).localeCompare(String(left.mtime)));
  const accept = wanted === 'video' ? LISTABLE_VIDEO_EXTS : LISTABLE_IMAGE_EXTS;
  return { success: true, kind: wanted, items, total: items.length, accept };
}

// 缩略图 key: 与对外接口 app/core/media_scheme.js 的口径一致(目录固定 _thumb/<宽度>/<stem>.webp)
export function thumbKeyOf(relativePath) {
  const text = String(relativePath || '').replace(/^\/+/, '');
  if (!text.startsWith(NEWS_PREFIX)) return '';
  const name = text.split('/').pop();
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${NEWS_PREFIX}_thumb/${THUMB_WIDTH}/${stem}.webp`;
}

// 素材库行里"有缩略图就给缩略图地址", 没有就留空(前端回退原图)
export async function thumbUrlOf(env, item) {
  const key = thumbKeyOf(item.path);
  if (!key) return '';
  try {
    const found = await env.MEDIA.head(key);
    return found ? key : '';
  } catch (error) {
    return '';
  }
}
