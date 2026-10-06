// 后台访问控制: 登录态放在签名 Cookie 里(见 lib/session.js), 与旧站同一套做法
// 这里只管三件事: 哪些路径未登录也能打开、怎么从请求里取当前管理员、写请求的来源校验
import { readSession } from './session.js';
import { isSuperRole } from './auth-store.js';

export const LOGIN_PATH = '/admin/login';
export const LOGOUT_PATH = '/admin/logout';
export const BOOTSTRAP_PATH = '/admin/bootstrap';
export const DASHBOARD_PATH = '/admin/dashboard';

// 取当前登录的管理员; 未登录返回 { ok:false }
export async function currentAdmin(request, env) {
  const session = await readSession(request, env);
  if (!session) return { ok: false, id: 0, username: '', role: '', isSuper: false };
  return {
    ok: true,
    id: Number(session.id) || 0,
    username: String(session.username),
    role: String(session.role || ''),
    isSuper: isSuperRole(session.role)
  };
}

// 写请求的来源校验: SameSite=Strict 之外再加一道(旧站也是 Origin/Referer 双保险)
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (error) {
    return false;
  }
}
