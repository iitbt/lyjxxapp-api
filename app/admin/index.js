// 管理后台入口: /admin 前缀的所有请求都在这里分发
// 为什么独立成目录: 后台与对外 API 的职责、鉴权方式、改动节奏都不同, 放一起会让 src/ 变成杂物间
import staticAssets from './assets/static-assets.js';
import { adminLayout } from './lib/layout.js';
import { WRITE_METHODS, classifyWritePath } from './lib/entities.js';
import { applyStatus, statusKind } from './lib/status.js';
import { BOOTSTRAP_PATH, DASHBOARD_PATH, LOGIN_PATH, LOGOUT_PATH, currentAdmin } from './lib/guard.js';
import { PAGE_ROUTES } from './pages/index.js';
import { bootstrapPage, bootstrapSubmit, loginPage, loginSubmit, logoutSubmit } from './routes/auth.js';
import { dashboardPage, pendingPage } from './routes.js';
import { NAV_GROUPS } from './lib/nav.js';

const PREFIX = '/admin';
const STATIC_PREFIX = `${PREFIX}/static/`;

const CONTENT_TYPES = {
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8'
};

//: data:URL 资源(图标字体)的解码缓存 —— isolate 内存里只有一份(字体内容不随请求变)
const decodedBinary = new Map();

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function redirect(location, cookie) {
  const headers = { location };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

// routes/auth.js 里有的分支回字符串、有的回 Response(跳转), 这里统一成全成 Response
function asResponse(value, status = 200) {
  return value instanceof Response ? value : htmlResponse(value, status);
}

function serveStatic(path) {
  const key = path.slice(STATIC_PREFIX.length);
  if (!Object.prototype.hasOwnProperty.call(staticAssets, key)) {
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const value = staticAssets[key];
  // 图标字体是二进制资源: 生成阶段包成了 data:URL, 这里解码回二进制原样返回
  // (字体内容不随代码变, 所以缓存一年; css/js 仍走 ?v= 版本号, 缓存一天)
  if (typeof value === 'string' && value.startsWith('data:')) {
    let hit = decodedBinary.get(key);
    if (!hit) {
      const marker = value.indexOf(';base64,');
      const mime = value.slice(5, marker) || 'application/octet-stream';
      const binary = atob(value.slice(marker + 8));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      hit = { mime, bytes };
      decodedBinary.set(key, hit);
    }
    return new Response(hit.bytes, {
      headers: { 'content-type': hit.mime, 'cache-control': 'public, max-age=31536000' }
    });
  }
  const ext = key.slice(key.lastIndexOf('.') + 1);
  return new Response(value, {
    headers: {
      'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
      // 资源地址带 ?v=<API_VERSION>, 改了样式/脚本要升版本号(见 admin/README.md)
      'cache-control': 'public, max-age=86400'
    }
  });
}

// 表单解析: urlencoded(页面表单)与 JSON(数据库工具的 SQL 控制台)都认;
// multipart 由具体处理器自己读(formData 只能读一次)
async function readForm(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (type.includes('application/json')) {
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const body = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (['string', 'number', 'boolean'].includes(typeof value)) body[key] = String(value);
      }
      return body;
    } catch (error) {
      return {};
    }
  }
  if (!type.includes('application/x-www-form-urlencoded')) return {};
  try {
    const form = await request.formData();
    const body = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') body[key] = value;
    }
    return body;
  } catch (error) {
    return {};
  }
}

function findNavItem(path) {
  const key = path.slice(PREFIX.length + 1);
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.key === key) return item;
    }
  }
  return null;
}

export async function handleAdmin(request, env, options = {}) {
  const url = new URL(request.url);
  // 去掉末尾斜杠, 只留一个规范形式(/admin/ 与 /admin 等价)
  const path = url.pathname.replace(/\/+$/, '') || PREFIX;
  const method = request.method.toUpperCase();

  // 样式与脚本: 白名单精确匹配(不从磁盘/R2 拼路径, 无穿越面), 不要求登录
  if (path.startsWith(STATIC_PREFIX)) return serveStatic(path);

  const session = await currentAdmin(request, env);

  // 登录页要的入参与旧站 login.html 的模板变量一一对应: 版本号(与后台侧栏同源)、
  // 提示条(message=成功 / error=失败)、redirect=登录后回跳的原地址。
  const authView = {
    env,
    version: String(options.version || ''),
    message: url.searchParams.get('message') || '',
    error: url.searchParams.get('error') || '',
    // 旧站用 ?redirect=, 首版 CF 用 ?next=: 两个都认(只接受站内 /admin 路径, auth.js 里兜底校验)
    redirect: url.searchParams.get('redirect') || url.searchParams.get('next') || ''
  };

  // 未登录也要能打开的页面: 登录页与首次初始化
  if (path === LOGIN_PATH) {
    if (session.ok) return redirect(DASHBOARD_PATH);
    if (method === 'POST') return asResponse(await loginSubmit(request, env, await readForm(request), authView));
    return asResponse(await loginPage(authView));
  }
  if (path === BOOTSTRAP_PATH) {
    if (method === 'POST') return asResponse(await bootstrapSubmit(request, env, await readForm(request), authView));
    return asResponse(await bootstrapPage(authView));
  }
  if (path === LOGOUT_PATH) {
    // 只收 POST: 否则第三方页面用 <img src="/admin/logout"> 就能把人踢下线
    if (method === 'POST') return logoutSubmit(request);
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }

  // 其余一律要求登录(未登录回登录页, 带上原地址方便登录后跳回)
  if (!session.ok) {
    const next = encodeURIComponent(path === PREFIX ? DASHBOARD_PATH : path);
    return redirect(`${LOGIN_PATH}?next=${next}`);
  }

  const ctx = {
    request,
    env,
    method,
    path,
    url,
    query: Object.fromEntries(url.searchParams.entries()),
    form: method === 'POST' ? await readForm(request) : {},
    session: { id: session.id, username: session.username, role: session.role, isSuper: session.isSuper },
    // 版本号由入口注入(main.js 的 API_VERSION 是唯一来源, 也是静态资源 ?v= 的缓存键)
    version: String(options.version || ''),
    message: url.searchParams.get('message') || '',
    error: url.searchParams.get('error') || ''
  };

  // 写请求的权限口径: 分发前统一拦截(清单见 lib/entities.js)
  // route_super 也在这里拦: 只靠页面自查时, 漏一页就是一个越权口子(管理员增删/重置口令就漏过)
  if (WRITE_METHODS.has(method)) {
    const kind = classifyWritePath(path);
    if ((kind === 'super' || kind === 'route_super') && !session.isSuper) {
      return htmlResponse(adminLayout(Object.assign({}, ctx, {
        title: '没有权限', currentPage: '', error: '该操作仅超级管理员可执行',
        content: '<div class="card-stat">你的账号不是超级管理员，这个操作被拒绝了。</div>'
      })), 403);
    }
    // 没登记口径的写入口一律拒绝并记日志 —— 宁可拒绝, 也不静默放行(自检会点名)
    if (kind === 'unregistered') {
      console.error(`[admin] 未登记权限口径的写入口: ${method} ${path}`);
      return htmlResponse(adminLayout(Object.assign({}, ctx, {
        title: '未登记的写入口', currentPage: '', error: '这个写入口没有登记权限口径，已拒绝执行',
        content: '<div class="card-stat">请在 <code>admin/lib/entities.js</code> 的三份写路径清单里登记它。</div>'
      })), 403);
    }
  }

  if (path === PREFIX) return redirect(DASHBOARD_PATH);

  // 统一状态切换(全后台唯一的写接口, 前端 status-toggle.js 调用)
  if (path === `${PREFIX}/status_update`) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    const kind = statusKind(ctx.form.kind);
    if (!kind) return jsonResponse({ success: false, message: '参数错误' });
    const payload = await applyStatus(env, ctx.session, kind, ctx.form.id, ctx.form.status);
    return jsonResponse(payload, payload.forbidden ? 403 : 200);
  }

  // 页面路由表(精确匹配; 后台路径没有参数, 够用)
  const route = PAGE_ROUTES.find((item) => item.path === path && item.methods.includes(method));
  if (route) return asResponse(await route.handler(ctx));

  // 控制面板: P0 就有的页面, 暂留在 routes.js
  if (path === DASHBOARD_PATH && (method === 'GET' || method === 'HEAD')) {
    return htmlResponse(await dashboardPage(ctx));
  }

  // 还没迁的菜单入口: 给"待迁"占位页, 不是 404
  const item = findNavItem(path);
  if (item && (method === 'GET' || method === 'HEAD')) return htmlResponse(pendingPage(ctx, item));

  return htmlResponse(adminLayout(Object.assign({}, ctx, {
    title: '页面不存在',
    currentPage: '',
    error: '没有这个页面',
    content: '<div class="card-stat">后台里没有这个地址，请从左侧菜单进入。</div>'
  })), 404);
}
