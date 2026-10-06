// MD5(仅用于生成新用户 username 前缀 wx_<md5(openid) 前 8 位>, 与旧站命名一致)
// WebCrypto 不提供 MD5, 所以这里自带一份; K 表按定义式现算, 避免硬编码出错
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

// K[i] = floor(abs(sin(i + 1)) * 2^32)
const TABLE = Array.from({ length: 64 }, (unused, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296) >>> 0);

const leftRotate = (value, bits) => ((value << bits) | (value >>> (32 - bits))) >>> 0;

function toWords(bytes) {
  const paddedLength = (((bytes.length + 8) >> 6) + 1) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);
  return buffer;
}

export function md5Hex(input) {
  const bytes = toWords(new TextEncoder().encode(String(input)));
  const view = new DataView(bytes.buffer);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = [];
    for (let index = 0; index < 16; index += 1) {
      words.push(view.getUint32(offset + index * 4, true));
    }
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let index = 0; index < 64; index += 1) {
      let f;
      let g;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const sum = (a + f + TABLE[index] + words[g]) >>> 0;
      const rotated = leftRotate(sum, SHIFTS[index]);
      const next = (b + rotated) >>> 0;
      a = d;
      d = c;
      c = b;
      b = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((value, index) => outView.setUint32(index * 4, value, true));
  return Array.from(out, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
