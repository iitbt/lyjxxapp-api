// 登录 / 登出 / 首次初始化: 与旧站同一套(账号在 D1 的 admin_users, 签名 Cookie 会话, 失败限速)
import { escapeHtml, pageShell } from '../../core/html.js';
import {
  checkQuota, loginClearStatement, loginFailStatement, loginLockState, quotaStatement
} from '../../core/ratelimit.js';
import { adminCount, createAdmin, findAdmin, touchLogin } from '../lib/auth-store.js';
import { BOOTSTRAP_PATH, DASHBOARD_PATH, LOGIN_PATH, sameOrigin } from '../lib/guard.js';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../lib/password.js';
import { clearSessionCookie, createSessionCookie, secureFlagOf, sessionSecret } from '../lib/session.js';

// 同一账号 15 分钟内最多 10 次(IP 级锁定沿用 app/core/ratelimit.js 的 login 那套)
const ACCOUNT_QUOTA = { limit: 10, windowSec: 900 };
const BAD_CREDENTIALS = '用户名或密码不正确';

function redirect(location, cookie) {
  const headers = { location };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

// 登录/初始化页: 复用对外 API 的极简外壳(未登录不该看到后台菜单)
function formPage(title, fields, hint) {
  return pageShell(title, [
    `<header>${escapeHtml(title)}</header>`,
    hint ? `<p class="sub">${hint}</p>` : '',
    `<form method="post">${fields}`,
    '<button class="btn" type="submit">提交</button></form>'
  ].join(''));
}

function loginForm() {
  return formPage('后台登录', [
    '<label>用户名<input name="username" autocomplete="username" required></label>',
    '<label>口令<input name="password" type="password" autocomplete="current-password" required></label>'
  ].join(''), '登录后才能进入管理页面。');
}

function bootstrapForm(message) {
  return formPage('初始化管理员', [
    '<label>用户名<input name="username" value="admin" required></label>',
    '<label>昵称<input name="nickname" placeholder="可留空"></label>',
    `<label>口令（至少 ${MIN_PASSWORD_LENGTH} 位）<input name="password" type="password" required></label>`
  ].join(''), message || '当前还没有任何管理员账号，在这里建第一个超级管理员（只在表为空时可用）。');
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

export async function loginPage(ctx) {
  if (!sessionSecret(ctx.env)) {
    return pageShell('后台未就绪',
      '<header>后台未就绪</header><main>还没配置会话密钥 <code>ADMIN_SESSION_SECRET</code>，'
      + '请在 Cloudflare 控制台把它加成一个加密变量（Secret）后重新部署。</main>');
  }
  return loginForm();
}

export async function loginSubmit(request, env, body) {
  if (!sameOrigin(request)) return new Response('来源校验失败', { status: 403 });
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return loginForm();

  if (await tooManyAttempts(env, request, username)) {
    return formPage('后台登录', [
      `<p class="sub">尝试次数过多，请 15 分钟后再试。</p>`,
      '<label>用户名<input name="username" required></label>',
      '<label>口令<input name="password" type="password" required></label>'
    ].join(''));
  }

  const admin = await findAdmin(env, username).catch(() => null);
  const passOk = admin ? await verifyPassword(password, admin.password) : false;
  if (!admin || !passOk) {
    await bumpFailures(env, request, username);
    // 不区分"账号不存在"与"口令错误": 免得被用来枚举管理员用户名
    return formPage('后台登录', [
      `<p class="sub">${BAD_CREDENTIALS}</p>`,
      '<label>用户名<input name="username" required></label>',
      '<label>口令<input name="password" type="password" required></label>'
    ].join(''));
  }

  const cookie = await createSessionCookie(env, admin, secureFlagOf(request));
  await env.DB.batch([loginClearStatement(env, request)]).catch(() => null);
  await touchLogin(env, admin.id).catch(() => null);
  return redirect(DASHBOARD_PATH, cookie);
}

export function logoutSubmit(request) {
  return redirect(LOGIN_PATH, clearSessionCookie(secureFlagOf(request)));
}

export async function bootstrapPage(ctx) {
  const count = await adminCount(ctx.env).catch(() => 0);
  if (count > 0) return pageShell('已初始化', '<header>已经初始化过</header><main>管理员账号已存在，请直接登录。</main>');
  if (!sessionSecret(ctx.env)) return loginPage(ctx);
  return bootstrapForm();
}

export async function bootstrapSubmit(request, env, body) {
  if (!sameOrigin(request)) return new Response('来源校验失败', { status: 403 });
  const count = await adminCount(env).catch(() => 1);
  if (count > 0) return new Response('管理员账号已存在', { status: 403 });
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const nickname = String(body.nickname || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    return bootstrapForm('用户名只能用字母数字与 _ . -（3~32 位）。');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return bootstrapForm(`口令至少 ${MIN_PASSWORD_LENGTH} 位。`);
  }
  await createAdmin(env, { username, nickname, password: await hashPassword(password), role: 'super' });
  return redirect(`${LOGIN_PATH}?message=${encodeURIComponent('管理员已创建，请登录')}`);
}

export { BOOTSTRAP_PATH };
