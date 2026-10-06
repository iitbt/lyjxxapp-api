// 管理员口令的哈希与校验: PBKDF2-SHA256(crypto.subtle 原生实现, 零依赖)
// 为什么不用旧站的 bcrypt: Workers 免费套餐 CPU 只有 10ms/请求, 纯 JS bcrypt 要 100~300ms, 必然报 Error 1102。
// 哈希串自描述: pbkdf2_sha256$<迭代数>$<salt>$<hash> —— 将来要提高迭代数不用改代码, 旧哈希照样能验。
import { bytesToBase64Url, base64UrlToBytes, encodeText } from './base64url.js';

const PREFIX = 'pbkdf2_sha256';
const DEFAULT_ITERATIONS = 10000;
const KEY_BITS = 256;
const SALT_BYTES = 16;

// 与旧站一致: MIN_ADMIN_PASSWORD_LEN=10
export const MIN_PASSWORD_LENGTH = 10;

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encodeText(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return `${PREFIX}$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

// 定长比较: 逐字节异或累加且不提前返回 —— 否则可以从比较耗时反推口令
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== PREFIX) return false;
  const iterations = Number(parts[1]) || 0;
  if (iterations < 1) return false;
  let salt;
  let expected;
  try {
    salt = base64UrlToBytes(parts[2]);
    expected = base64UrlToBytes(parts[3]);
  } catch (error) {
    return false;
  }
  const actual = await derive(password, salt, iterations);
  return safeEqual(actual, expected);
}

// 会话里带的"口令指纹": 改了口令就让已发出的会话立即失效(与旧站 pwd_head 同思路)
export function passwordHead(stored) {
  return String(stored || '').slice(-8);
}
