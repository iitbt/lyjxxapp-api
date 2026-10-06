// 鉴权: 与旧站同口径 —— token 明文入库, 每请求查库校验; 来源顺序 body → query → Authorization: Bearer
import { one } from '../core/db.js';

export function tokenOf(request, body = {}) {
  const fromBody = body && body.token;
  if (fromBody) return String(fromBody);
  try {
    const fromQuery = new URL(request.url).searchParams.get('token');
    if (fromQuery) return String(fromQuery);
  } catch (error) {
    // URL 解析失败按无 token 处理
  }
  const header = request.headers.get('authorization') || '';
  const matched = /^Bearer\s+(.+)$/i.exec(header.trim());
  return matched ? matched[1] : '';
}

// 返回用户整行; 库不可用抛错(调用方转 503)
export async function userByToken(env, token) {
  if (!token) return null;
  return await one(env, 'SELECT * FROM users WHERE token=? LIMIT 1', token);
}

export async function currentUser(env, request, body = {}) {
  return await userByToken(env, tokenOf(request, body));
}

export const AUTH_MESSAGES = {
  needLogin: '未授权，请先登录',
  expired: '登录已过期，请重新登录',
  actionNeedLogin: '请先登录后再操作',
  identity: '身份校验失败，请重新登录'
};

// 写接口用的身份校验: require=true 时强制登录, 且与 body.user_id 必须一致
export async function identity(request, env, body, require = true) {
  const token = tokenOf(request, body);
  if (!token) {
    return { ok: false, code: 401, message: require ? AUTH_MESSAGES.actionNeedLogin : AUTH_MESSAGES.needLogin };
  }
  let user = null;
  try {
    user = await userByToken(env, token);
  } catch (error) {
    return { ok: false, code: 503, message: '服务繁忙，请稍后重试' };
  }
  if (!user) return { ok: false, code: 401, message: AUTH_MESSAGES.expired };
  const claimed = body && body.user_id;
  if (claimed !== undefined && claimed !== null && String(claimed) !== '' && String(claimed) !== String(user.id)) {
    return { ok: false, code: 403, message: AUTH_MESSAGES.identity };
  }
  return { ok: true, user, userId: user.id };
}
