// 中间件等价物 —— 对照旧站 app/core/middleware.py
//
// 旧站是一串 Starlette 中间件(RequestId / Metrics / RateLimit / BodyLimit / Compress /
// MediaCacheHeaders / Session / OriginGuard / AccessLog / SecurityHeaders …), 由 add_middleware 装配;
// Worker 只有单一 fetch 入口, 无法"挂"中间件, 所以这里是**在入口里按同一顺序调用的函数**:
//
//   请求ID → 预检(OPTIONS) → 读请求体/查询串 → 分发 → 安全头 + CORS 落回响应 → 异常兜底
//
// 差异(平台边界, 已在 README「已知差异」声明):
//   · gzip: 交 Cloudflare 边缘自动压缩, 不实现;
//   · 访问日志/慢请求: Workers Logs 侧看, 不在这里逐请求打点;
//   · 请求体大小限制: 见 enforceBodyLimit() —— 与旧站 BODY_LIMIT_BYTES 同口径。
import { fail } from './response.js';
import { settings } from './config.js';

//: 请求头里的请求 ID: 只接受安全字符集, 防日志注入(与旧站 middleware.py 的同名校验一致)
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

//: 三个安全响应头(与旧站 SecurityHeadersMiddleware 同口径)
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN'
};

/**
 * CORS: 旧站按 settings.cors_origins 白名单(生产=同源), 小程序无 Origin 不受影响。
 * 白名单由 ALLOWED_ORIGINS 配置, 值为 `*` 时保持现状(默认, 与迁移前的行为一致)。
 */
export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization'
};

/**
 * 按 ALLOWED_ORIGINS 解析本次请求该回哪个 allow-origin。
 *
 * 默认 `*`(与迁移前一致) —— 小程序不带 Origin, 不受影响;
 * 填了域名后就等价于旧站 `allow_origins` 白名单: 不在白名单里的 Origin **不回该头**(浏览器自行拦截),
 * 且不启用 allow-credentials(旧站也是 False)。
 */
export function corsHeadersFor(request, env) {
  const configured = String(settings(env).allowedOrigins || '*').trim();
  if (!configured || configured === '*') return CORS_HEADERS;
  const list = configured.split(',').map((item) => item.trim()).filter(Boolean);
  const origin = String(request.headers.get('origin') || '').trim();
  if (origin && list.includes(origin)) {
    return Object.assign({}, CORS_HEADERS, { 'access-control-allow-origin': origin });
  }
  const headers = Object.assign({}, CORS_HEADERS);
  delete headers['access-control-allow-origin'];
  return headers;
}

/** 请求 ID: 优先透传客户端/边缘的 X-Request-Id(便于跨链路排查), 否则新生成。 */
export function requestIdOf(request) {
  const incoming = String((request.headers && request.headers.get('x-request-id')) || '');
  if (REQUEST_ID_RE.test(incoming)) return incoming;
  return crypto.randomUUID();
}

/** 把安全头 / CORS / 请求 ID 落到**任意**响应上(含 404/500/静态资源)。 */
export function withHeaders(response, requestId, corsHeaders = CORS_HEADERS) {
  const headers = new Headers(response.headers);
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => headers.set(name, value));
  Object.entries(corsHeaders).forEach(([name, value]) => headers.set(name, value));
  headers.set('x-request-id', requestId);
  return new Response(response.body, { status: response.status, headers });
}

/** OPTIONS 预检: 直接 204(与旧站 CORSMiddleware 的行为一致)。 */
export function preflight(requestId, corsHeaders = CORS_HEADERS) {
  return withHeaders(new Response(null, { status: 204 }), requestId, corsHeaders);
}

/** 请求体上限(与旧站 BODY_LIMIT_BYTES 默认 5MB 一致); multipart 交给上传接口按字段校验。 */
const BODY_LIMIT_BYTES = 5 * 1024 * 1024;

export function isMultipart(request) {
  return String(request.headers.get('content-type') || '').toLowerCase().includes('multipart/form-data');
}

/**
 * 请求体超限 → 413(与旧站 RequestBodyLimitMiddleware 同码同文案)。
 * 只按 Content-Length 判断: Worker 里流式累计需要读完整个 body, 得不偿失。
 */
export function bodyTooLarge(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return false;
  if (isMultipart(request)) return false;
  const size = Number(request.headers.get('content-length') || 0);
  return Number.isFinite(size) && size > BODY_LIMIT_BYTES;
}

export function tooLargeResponse(requestId, corsHeaders = CORS_HEADERS) {
  return withHeaders(fail(413, '请求体过大', { httpStatus: 413 }), requestId, corsHeaders);
}

/** 读 JSON / 表单体; 解析失败一律当空对象(与旧站"坏 body 不 500"的口径一致)。 */
export async function readBody(request) {
  const type = String(request.headers.get('content-type') || '').toLowerCase();
  if (type.includes('application/json')) {
    try {
      const parsed = await request.json();
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    try {
      const form = await request.formData();
      return stringFields(form);
    } catch (error) {
      return {};
    }
  }
  return {};
}

/** 从 FormData 里取出普通字符串字段(multipart 只读一次, 文件另由处理器取)。 */
export function stringFields(form) {
  const body = {};
  if (!form) return body;
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') body[key] = value;
  }
  return body;
}

/**
 * 组装处理器入参: query 与 body 合并, **body 优先**(与旧站 FastAPI 取参顺序一致),
 * 并额外把 query / form 原样透传(上传接口与签名校验要用)。
 */
export async function requestInput(request, url) {
  const query = Object.fromEntries(url.searchParams.entries());
  let form = null;
  let parsed = {};
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (isMultipart(request)) {
      form = await request.formData().catch(() => null);
      parsed = stringFields(form);
    } else {
      parsed = await readBody(request);
    }
  }
  return { body: Object.assign({}, query, parsed), query, form };
}
