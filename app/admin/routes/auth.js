// 登录 / 登出 / 首次初始化: 与旧站同一套(账号在 D1 的 admin_users, 签名 Cookie 会话, 失败限速)
// 页面结构/文案/交互对照旧站 templates/login.html: 卡片 + 品牌图标 + 输入组, 样式复用 bootstrap 与 admin.css
import { escapeHtml } from '../../core/html.js';
import { settings } from '../../core/config.js';
import {
  LOGIN_LIMIT, checkQuota, loginClearStatement, loginFailStatement, loginLockState, quotaStatement
} from '../../core/ratelimit.js';
import { nowEpoch, windowStart } from '../../core/timeutil.js';
import { adminCount, createAdmin, findAdmin, touchLogin } from '../lib/auth-store.js';
import { BOOTSTRAP_PATH, DASHBOARD_PATH, LOGIN_PATH, sameOrigin } from '../lib/guard.js';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../lib/password.js';
import { clearSessionCookie, createSessionCookie, secureFlagOf, sessionSecret } from '../lib/session.js';

// 同一账号 15 分钟内最多 10 次(IP 级锁定沿用 app/core/ratelimit.js 的 login 那套)
const ACCOUNT_QUOTA = { limit: 10, windowSec: 900 };
// 与旧站 auth.py 逐字一致: 不区分"账号不存在"与"口令错误", 免得被用来枚举管理员用户名
const BAD_CREDENTIALS = '用户名或密码错误';

// 登录页特有样式(与旧站 login.html 的 <style> 同一份: 居中布局、卡片圆角、品牌图标)
const LOGIN_STYLE = [
  'body{min-height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%)}',
  '.login-card{width:100%;max-width:400px;border:0;border-radius:16px;box-shadow:0 20px 60px rgba(15,23,42,.35)}',
  '.login-card .card-body{padding:2rem}',
  '.login-card .form-control,.login-card .btn{border-radius:8px}',
  '.brand-icon{position:relative;width:64px;height:64px;border-radius:16px;background:var(--accent);color:#fff;'
  + 'font-size:30px;display:flex;align-items:center;justify-content:center;margin:0 auto 12px}',
  '.brand-icon.logo-wrap{background:rgba(255,255,255,.95);padding:4px}',
  '.brand-logo{position:relative;z-index:1;width:100%;height:100%;object-fit:contain;display:block}',
  // R2 里还没有 logo.png 时的兜底: img 被 onerror 摘掉, 露出下面这枚盾牌图标, 页面不会出现裂图
  '.brand-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--accent)}',
  '@media (max-width:575.98px){body{padding:16px}.login-card .card-body{padding:1.25rem}}'
].join('');

function redirect(location, cookie) {
  const headers = { location };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

function alertBox(kind, text, icon) {
  if (!text) return '';
  const role = kind === 'danger' ? 'assertive' : 'polite';
  return `<div class="alert alert-${kind} py-2" role="alert" aria-live="${role}">`
    + `<i class="bi ${icon}" aria-hidden="true"></i> ${escapeHtml(text)}</div>`;
}

/** 后台登录/初始化页外壳: 结构照搬旧站 login.html, 版本号由入口注入, redirect 回显走隐藏域。 */
function authDocument(options = {}) {
  const env = options.env;
  const cfg = settings(env);
  const version = String(options.version || '');
  const v = encodeURIComponent(version);
  const title = options.title || '后台登录';
  const icon = options.icon || 'bi bi-box-arrow-in-right';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - ${escapeHtml(cfg.siteName)}</title>
<link rel="icon" href="/favicon.ico" type="image/x-icon">
<link href="/admin/static/vendor/bootstrap.min.css?v=${v}" rel="stylesheet">
<link href="/admin/static/vendor/bootstrap-icons.min.css?v=${v}" rel="stylesheet">
<link href="/admin/static/css/admin.css?v=${v}" rel="stylesheet">
<style>${LOGIN_STYLE}</style>
</head>
<body>
<div class="card login-card shadow">
  <div class="card-body">
    <div class="text-center mb-3">
      <div class="brand-icon logo-wrap">
        <i class="bi bi-shield-check brand-fallback" aria-hidden="true"></i>
        <img src="/images/logo.png" alt="${escapeHtml(cfg.siteShort)}" class="brand-logo" onerror="this.remove()">
      </div>
      <h4 class="mb-1">${escapeHtml(options.heading || cfg.siteName)}</h4>
      <small class="text-muted">${escapeHtml(options.subtitle || '请输入管理员账号登录')}</small>
    </div>
${alertBox('success', options.message, 'bi-check-circle')}
${alertBox('danger', options.error, options.errorIcon || 'bi-exclamation-circle')}
${options.body || ''}
    <div class="text-center mt-3">
      <small class="text-muted">忘记密码请联系超级管理员重置</small>
    </div>
${version ? `    <div class="text-center mt-2">
      <small class="text-muted">系统版本 v${escapeHtml(version)}</small>
    </div>
` : ''}  </div>
</div>
</body>
</html>`;
}

/** 登录表单(字段名与旧站一致: admin_username / admin_password)。 */
function loginForm(view = {}) {
  const redirectField = view.redirect
    ? `        <input type="hidden" name="redirect" value="${escapeHtml(view.redirect)}">\n`
    : '';
  return `${authDocument(Object.assign({}, view, {
    title: '后台登录',
    body: `    <form method="post" action="${LOGIN_PATH}">
      <div class="mb-3">
        <label class="form-label" for="loginUsername">用户名</label>
        <div class="input-group">
          <span class="input-group-text"><i class="bi bi-person" aria-hidden="true"></i></span>
          <input type="text" class="form-control" name="admin_username" id="loginUsername" placeholder="请输入管理员账号"
                 value="${escapeHtml(view.username || '')}" required aria-required="true" autofocus autocomplete="username">
        </div>
      </div>
      <div class="mb-3">
        <label class="form-label" for="loginPassword">密码</label>
        <div class="input-group">
          <span class="input-group-text"><i class="bi bi-lock" aria-hidden="true"></i></span>
          <input type="password" class="form-control" name="admin_password" id="loginPassword" placeholder="请输入密码"
                 required aria-required="true" autocomplete="current-password">
        </div>
      </div>
${redirectField}      <button type="submit" class="btn btn-primary w-100 py-2"><i class="bi bi-box-arrow-in-right" aria-hidden="true"></i> 登 录</button>
    </form>`
  }))}`;
}

/** 初始化表单(旧站用 .env 的 ADMIN_INIT_PASSWORD 播种, 这里沿用同一张卡片)。 */
function bootstrapForm(view = {}) {
  return `${authDocument(Object.assign({}, view, {
    title: '初始化管理员',
    heading: '初始化管理员',
    subtitle: '当前还没有任何管理员账号，在这里建第一个超级管理员',
    errorIcon: 'bi-exclamation-triangle',
    body: `    <form method="post" action="${BOOTSTRAP_PATH}">
      <div class="mb-3">
        <label class="form-label" for="bootUsername">用户名</label>
        <div class="input-group">
          <span class="input-group-text"><i class="bi bi-person" aria-hidden="true"></i></span>
          <input type="text" class="form-control" name="username" id="bootUsername" value="${escapeHtml(view.username || 'admin')}"
                 required aria-required="true" autofocus autocomplete="username">
        </div>
      </div>
      <div class="mb-3">
        <label class="form-label" for="bootNickname">昵称</label>
        <input type="text" class="form-control" name="nickname" id="bootNickname" placeholder="可留空">
      </div>
      <div class="mb-3">
        <label class="form-label" for="bootPassword">口令（至少 ${MIN_PASSWORD_LENGTH} 位）</label>
        <div class="input-group">
          <span class="input-group-text"><i class="bi bi-lock" aria-hidden="true"></i></span>
          <input type="password" class="form-control" name="password" id="bootPassword" required
                 aria-required="true" autocomplete="new-password">
        </div>
      </div>
      <button type="submit" class="btn btn-primary w-100 py-2"><i class="bi bi-person-plus" aria-hidden="true"></i> 创建并登录</button>
    </form>`
  }))}`;
}

/** 登录限速剩余时间 → 旧站 _lock_message 的同一句话术。 */
function lockMessage() {
  const remaining = windowStart(LOGIN_LIMIT.windowSec) + LOGIN_LIMIT.windowSec - nowEpoch();
  if (remaining <= 0) return '尝试过于频繁，请稍后再试';
  return `尝试次数过多，请 ${Math.max(1, Math.round(remaining / 60))} 分钟后再试`;
}

/** 登录后跳回被拦截的原页面: 只接受站内 /admin 路径, 且不允许以 // 开头(防开放重定向)。 */
function safeTarget(value) {
  const target = String(value || '');
  if (!target.startsWith('/admin') || target.startsWith('//')) return DASHBOARD_PATH;
  return target;
}

async function bumpFailures(env, request, username) {
  const statements = [loginFailStatement(env, request)];
  if (username) statements.push(quotaStatement(env, 'admin_login', `u:${username}`, ACCOUNT_QUOTA));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // 计数写失败不该拦住"拒绝登录"这个结果, 只记日志
    console.error('admin login counter failed', error && error.message);
  }
}

async function tooManyAttempts(env, request, username) {
  const byIp = await loginLockState(env, request).catch(() => ({ locked: false }));
  if (byIp.locked) return true;
  if (!username) return false;
  const byAccount = await checkQuota(env, 'admin_login', `u:${username}`, ACCOUNT_QUOTA).catch(() => ({ allowed: true }));
  return !byAccount.allowed;
}

export async function loginPage(view = {}) {
  if (!sessionSecret(view.env)) {
    // 没配会话密钥就直接说清楚(不用默认值放行) —— 页面仍是同一张卡片, 只是换成说明文字
    return authDocument(Object.assign({}, view, {
      title: '后台未就绪',
      heading: '后台未就绪',
      subtitle: '还没配置会话密钥',
      errorIcon: 'bi-exclamation-triangle',
      error: `还没配置会话密钥 ADMIN_SESSION_SECRET，请在 Cloudflare 控制台把它加成一个加密变量（Secret）后重新部署。`,
      body: ''
    }));
  }
  return loginForm(view);
}

export async function loginSubmit(request, env, body, view = {}) {
  if (!sameOrigin(request)) return new Response('来源校验失败', { status: 403 });
  // 字段名与旧站一致(admin_username / admin_password); 同时容忍首版的 username / password
  const username = String(body.admin_username || body.username || '').trim();
  const password = String(body.admin_password || body.password || '');
  // 失败重渲染要带上这次提交的回跳地址(它在隐藏域里, 不在 query 里), 否则重试后就丢了回跳意图
  const redirectTo = String(body.redirect || body.next || view.redirect || '');
  const failed = Object.assign({}, view, { missing: '1', username: '', redirect: redirectTo });

  if (await tooManyAttempts(env, request, username)) {
    return loginForm(Object.assign({}, failed, { error: lockMessage(), errorIcon: 'bi-hourglass-split' }));
  }
  if (!username || !password) {
    // 旧站口径: 空账号/空口令也走"用户名或密码错误"(不额外提示哪一项为空, 避免暴露判定细节)
    return loginForm(Object.assign({}, failed, { error: BAD_CREDENTIALS }));
  }

  const admin = await findAdmin(env, username).catch(() => null);
  const passOk = admin ? await verifyPassword(password, admin.password) : false;
  if (!admin || !passOk) {
    await bumpFailures(env, request, username);
    return loginForm(Object.assign({}, failed, { error: BAD_CREDENTIALS }));
  }

  const cookie = await createSessionCookie(env, admin, secureFlagOf(request));
  await env.DB.batch([loginClearStatement(env, request)]).catch(() => null);
  await touchLogin(env, admin.id).catch(() => null);
  return redirect(safeTarget(body.redirect || body.next), cookie);
}

export function logoutSubmit(request) {
  // 与旧站一致: 登出后回登录页并给出"已退出登录"提示(页面第二行不再是空白)
  const target = `${LOGIN_PATH}?message=${encodeURIComponent('已退出登录')}`;
  return redirect(target, clearSessionCookie(secureFlagOf(request)));
}

export async function bootstrapPage(view = {}) {
  const count = await adminCount(view.env).catch(() => 0);
  if (count > 0) {
    return authDocument(Object.assign({}, view, {
      title: '已初始化', heading: '已经初始化过', subtitle: '管理员账号已存在，请直接登录', body: ''
    }));
  }
  if (!sessionSecret(view.env)) return loginPage(view);
  return bootstrapForm(view);
}

export async function bootstrapSubmit(request, env, body, view = {}) {
  if (!sameOrigin(request)) return new Response('来源校验失败', { status: 403 });
  const count = await adminCount(env).catch(() => 1);
  if (count > 0) return new Response('管理员账号已存在', { status: 403 });
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const nickname = String(body.nickname || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    return bootstrapForm(Object.assign({}, view, { username, error: '用户名只能用字母数字与 _ . -（3~32 位）。' }));
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return bootstrapForm(Object.assign({}, view, { username, error: `口令至少 ${MIN_PASSWORD_LENGTH} 位。` }));
  }
  await createAdmin(env, { username, nickname, password: await hashPassword(password), role: 'super' });
  return redirect(`${LOGIN_PATH}?message=${encodeURIComponent('管理员已创建，请登录')}`);
}

export { BOOTSTRAP_PATH };
