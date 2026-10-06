// base64url 编解码: 口令哈希与会话签名共用(只留这一份实现)
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64Url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const text = atob(padded);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

export function textToBase64Url(text) {
  return bytesToBase64Url(encoder.encode(text));
}

export function base64UrlToText(value) {
  return decoder.decode(base64UrlToBytes(value));
}

export function encodeText(text) {
  return encoder.encode(text);
}

export function decodeText(bytes) {
  return decoder.decode(bytes);
}
