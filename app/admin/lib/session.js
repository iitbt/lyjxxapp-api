// 会话: HMAC-SHA256 签名的 Cookie(无服务端状态, 与旧站"签名 Cookie 会话"同一思路)
// 载荷只放 id/用户名/角色/过期时间/口令指纹 —— 可读不可改, 防篡改靠签名
import { bytesToBase64Url, base64UrlToBytes, encodeText, decodeText } from './base64url.js';
import { passwordHead } from './password.js';
import { settings } from '../../core/config.js';

const COOKIE_NAME = 'admin_session';
export const SESSION_MAX_AGE = 86400;

export function sessionSecret(env) {
  return settings(env).adminSessionSecret;
}

function parseCookies(header) {
  const jar = {};
  String(header || '').split(';').forEach((part) => {
    const at = part.indexOf('=');
    if (at < 0) return;
    jar[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  });
  return jar;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encodeText(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSessionCookie(env, admin, secureFlag = '; Secure') {
  const secret = sessionSecret(env);
  if (!secret) throw new Error('缺少 ADMIN_SESSION_SECRET');
  const payload = {
    id: Number(admin.id) || 0,
    username: String(admin.username || ''),
    role: String(admin.role || 'normal'),
    head: passwordHead(admin.password),
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE
  };
  const body = bytesToBase64Url(encodeText(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encodeText(body)));
  // HttpOnly 防脚本读, SameSite=Strict 挡跨站提交(配合 Origin 校验, 不用再带 CSRF token)
  return `${COOKIE_NAME}=${body}.${bytesToBase64Url(signature)}`
    + `; Path=/; HttpOnly; SameSite=Strict${secureFlag}; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie(secureFlag = '; Secure') {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict${secureFlag}; Max-Age=0`;
}

// Secure 属性只在 https 下发: 浏览器规范规定 http 页面下的 Secure cookie 会被**直接丢弃**,
// 于是本地用 http 预览时"登录成功却立刻回到登录页"。生产是 Cloudflare 边缘, request.url 恒为 https,
// 所以这里不会削弱线上安全(解析不出协议时按 https 处理)。
export function secureFlagOf(request) {
  try {
    return new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  } catch (error) {
    return '; Secure';
  }
}

// 返回会话载荷或 null(签名不对 / 过期 / 没配密钥都算未登录)
export async function readSession(request, env) {
  const secret = sessionSecret(env);
  if (!secret) return null;
  const raw = parseCookies(request.headers.get('cookie'))[COOKIE_NAME];
  if (!raw || raw.indexOf('.') < 0) return null;
  const [body, signature] = raw.split('.');
  let verified = false;
  try {
    const key = await hmacKey(secret);
    verified = await crypto.subtle.verify('HMAC', key, base64UrlToBytes(signature), encodeText(body));
  } catch (error) {
    return null;
  }
  if (!verified) return null;
  let payload = null;
  try {
    payload = JSON.parse(decodeText(base64UrlToBytes(body)));
  } catch (error) {
    return null;
  }
  if (!payload || !payload.username) return null;
  if (Number(payload.exp) * 1000 < Date.now()) return null;
  return payload;
}
