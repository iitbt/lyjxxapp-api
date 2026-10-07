// 入口 —— 对照旧站 fastapi/main.py
//
// 旧站 main.py 只做三件事, 这里一一对应:
//   ① 装配中间件与路由(旧站 add_middleware + include_router, 见 core/middleware.js 的说明);
//   ② 媒体/静态直出(旧站 StaticFiles 挂载 /images、/news_uploads…);
//   ③ 统一异常处理与定时任务(旧站 exception_handler 与 lifespan 里的后台任务)。
//
// 纪律: **入口不写业务**。对外接口在 app/api/, 平台能力在 app/core/, 后台在 app/admin/。
import { createRouter } from './app/core/router.js';
import { fail } from './app/core/response.js';
import { handleAdmin } from './app/admin/index.js';
import { cleanupSql } from './app/core/ratelimit.js';
import { logError } from './app/core/logging.js';
import { bodyTooLarge, corsHeadersFor, preflight, requestIdOf, requestInput, tooLargeResponse, withHeaders } from './app/core/middleware.js';
import { registerStatusRoutes } from './app/api/service_status.js';
import { registerHealthRoutes } from './app/core/health.js';
import { registerMetricsRoutes } from './app/core/metrics.js';
import { registerPageRoutes } from './app/api/pages.js';
import { registerContentRoutes } from './app/api/content.js';
import { registerAppConfigRoutes } from './app/api/app_config.js';
import { registerNewsRoutes } from './app/api/news.js';
import { registerUserRoutes } from './app/api/user.js';
import { faviconResponse } from './app/core/favicon.js';
import { settings } from './app/core/config.js';
import { SERVED_PREFIXES } from './app/core/storage.js';

// 版本号(**唯一来源**): 与旧站 fastapi/main.py 的 APP_VERSION 同一处 ——
// 状态页 / /health/ready / /apitest 展示它, 后台静态资源的 ?v= 缓存键也用它。
// 改版本只改这一行; wrangler.toml 里不再有 API_VERSION, 也不再有第二份默认值。
export const API_VERSION = '2.2.1';

// ==== 路由装配(对应旧站 main.py 的 include_router 段) ====
const router = createRouter();
registerStatusRoutes(router, { version: API_VERSION });
registerHealthRoutes(router, { version: API_VERSION });
registerMetricsRoutes(router, { version: API_VERSION });
registerPageRoutes(router);
registerContentRoutes(router);
registerAppConfigRoutes(router);
registerNewsRoutes(router);
registerUserRoutes(router);

/** 供测试断言"对外接口恰好 33 条"(对应旧站的路由清单核对)。 */
export function routeTable() {
  return router.paths();
}

// ==== 媒体直出(旧站是 StaticFiles 挂载): 前缀清单见 core/storage.js ====
const MEDIA_PREFIXES = SERVED_PREFIXES;

//: R2 对象没带 httpMetadata 时按扩展名兜底(上传工具传上去的素材常常没有 content-type)
const CONTENT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm'
};

function contentTypeOf(key) {
  const text = String(key || '');
  return CONTENT_TYPES[text.slice(text.lastIndexOf('.') + 1).toLowerCase()] || '';
}

// 解析单段 Range: 旧站 StaticFiles 支持 Range, 视频拖动/续播依赖它
function rangeOf(header) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;
  const [, start, end] = match;
  if (start === '' && end === '') return null;
  if (start === '') return { suffix: Number(end) };
  const offset = Number(start);
  if (end === '') return { offset };
  const length = Number(end) - offset + 1;
  return length > 0 ? { offset, length } : null;
}

async function serveObject(env, key, request) {
  const bucket = settings(env).storage;
  if (!bucket) {
    logError('media.binding_missing', new Error('R2 绑定缺失'), { key });
    return new Response('storage not bound', { status: 502 });
  }
  try {
    const range = rangeOf(request && request.headers.get('range'));
    const object = range ? await bucket.get(key, { range }) : await bucket.get(key);
    if (!object) return new Response('not found', { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.get('content-type')) {
      const guess = contentTypeOf(key);
      if (guess) headers.set('content-type', guess);
    }
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'public, max-age=604800');
    headers.set('accept-ranges', 'bytes');
    if (range && object.range) {
      const offset = Number(object.range.offset) || 0;
      const length = object.range.length === undefined
        ? Math.max(0, Number(object.size) - offset)
        : Number(object.range.length);
      headers.set('content-range', `bytes ${offset}-${offset + Math.max(0, length - 1)}/${object.size}`);
      return new Response(object.body, { status: 206, headers });
    }
    return new Response(object.body, { headers });
  } catch (error) {
    logError('media.read_failed', error, { key });
    return new Response('bad gateway', { status: 502 });
  }
}

export default {
  // 定时任务(wrangler.toml 的 [triggers]): 清掉过期窗口的限流计数行
  async scheduled(event, env) {
    try {
      await env.DB.prepare(cleanupSql()).run();
    } catch (error) {
      logError('cron.rate_limit_cleanup_failed', error);
    }
  },

  async fetch(request, env, ctx) {
    const requestId = requestIdOf(request);
    const corsHeaders = corsHeadersFor(request, env);
    const url = new URL(request.url);

    // 中间件链(顺序见 core/middleware.js): 预检 → 前缀分发 → 请求体上限 → 路由 → 异常兜底
    if (request.method === 'OPTIONS') return preflight(requestId, corsHeaders);

    // 管理后台: 整个 /admin 前缀交给 admin/(不进对外 33 条路由表)
    // 版本号必须在这里注入: 后台侧栏与静态资源 ?v= 都读 ctx.version, 漏传就会显示成空的"v"
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      return withHeaders(await handleAdmin(request, env, { version: API_VERSION }), requestId, corsHeaders);
    }

    if (MEDIA_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return withHeaders(new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } }), requestId, corsHeaders);
      }
      let key = '';
      try {
        key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      } catch (error) {
        return withHeaders(new Response('bad request', { status: 400 }), requestId, corsHeaders);
      }
      return withHeaders(await serveObject(env, key, request), requestId, corsHeaders);
    }
    if (url.pathname === '/favicon.ico') {
      // 站点图标由 Worker 内联字节直出(见 core/favicon.js): 不依赖 R2 里有没有该对象, 也省一次子请求
      return withHeaders(faviconResponse(), requestId, corsHeaders);
    }

    const handler = router.match(request.method, url.pathname);
    if (!handler) {
      // 旧站是 FastAPI 默认 404(真 HTTP 状态码), 这里对齐 —— 监控/探针按 HTTP 码判定才不会看错
      return withHeaders(fail(404, '接口不存在', { httpStatus: 404 }), requestId, corsHeaders);
    }
    if (bodyTooLarge(request)) {
      return tooLargeResponse(requestId, corsHeaders);
    }

    try {
      const input = await requestInput(request, url);
      const response = await handler(request, env, ctx, input);
      return withHeaders(response, requestId, corsHeaders);
    } catch (error) {
      // 与旧站 unhandled_exception_handler 同口径: HTTP 500, 详情只进日志
      logError('unhandled', error, { path: url.pathname, method: request.method, requestId });
      return withHeaders(fail(500, '服务器错误，请稍后重试', { httpStatus: 500 }), requestId, corsHeaders);
    }
  }
};
