// 素材上传与素材库: 旧站的两个端点在这里等价实现
//   POST /admin/image_upload(旧地址 /admin/news_image_upload) —— 与静态脚本 image_upload.js 对接
//   GET  /admin/media_library(旧地址 /admin/media_videos)     —— 与静态脚本 media_library.js 对接
import { listMedia, saveUpload, thumbUrlOf } from '../lib/mediaUpload.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

// multipart 只解析一次: 字段名 file 或 image 都收(旧站两种都认)
async function uploadHandler(ctx) {
  let form = null;
  try {
    form = await ctx.request.formData();
  } catch (error) {
    return json({ success: false, message: '未收到文件' });
  }
  const file = form.get('file') || form.get('image');
  const result = await saveUpload(ctx.env, { file, purpose: form.get('purpose') });
  if (!result.ok) return json({ success: false, message: result.message });
  // 旧站返回的是 {success, message, url}, url 是相对记录值, 前端直接回填输入框
  return json({ success: true, message: result.message, url: result.url });
}

async function libraryHandler(ctx) {
  const kind = ctx.query.kind === 'video' ? 'video' : 'image';
  const listed = await listMedia(ctx.env, kind, ctx.query.q);
  if (!listed.success) return json(listed);
  // thumb 只在缩略图已存在时给(Workers 不生成缩略图, 缺了就回退原图)
  const items = [];
  for (const item of listed.items) {
    items.push(Object.assign({}, item, { thumb: await thumbUrlOf(ctx.env, item) }));
  }
  return json({ success: true, kind: listed.kind, items, total: items.length, accept: listed.accept });
}

// 旧地址: 视频素材库(等价于 kind=video)
const videosHandler = (ctx) => libraryHandler({ query: Object.assign({}, ctx.query, { kind: 'video' }), env: ctx.env });

export const routes = [
  { methods: ['POST'], path: '/admin/image_upload', handler: uploadHandler },
  { methods: ['POST'], path: '/admin/news_image_upload', handler: uploadHandler },
  { methods: ['GET', 'HEAD'], path: '/admin/media_library', handler: libraryHandler },
  { methods: ['GET', 'HEAD'], path: '/admin/media_videos', handler: videosHandler }
];
