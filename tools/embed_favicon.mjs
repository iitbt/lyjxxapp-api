// 把 app/favicon.ico 内联成 app/core/favicon.js(生成物, 不要手改)
// 用法: node tools/embed_favicon.mjs; 换了图标就重跑并升 API_VERSION(见 DEPLOY.md「站点图标」)
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const source = resolve(root, 'app/favicon.ico');
const target = resolve(root, 'app/core/favicon.js');

const bytes = await readFile(source);
const base64 = bytes.toString('base64');
const etag = createHash('md5').update(bytes).digest('hex').slice(0, 16);

const body = `// 站点图标(favicon.ico)的唯一来源 —— 与 fastapi/app/favicon.ico 是同一个文件(${bytes.length} 字节)
// 内联成 base64 而不从 R2 取(每个页面、未登录都要能拿到); 生成方式: node tools/embed_favicon.mjs
const FAVICON_BASE64 = '${base64}';

//: 声明真实类型(实测该文件是 PNG, 不是 ICO): 类型与字节不一致 + nosniff 会被挑剔的客户端直接丢掉
export const FAVICON_CONTENT_TYPE = 'image/png';

//: 内容指纹做 ETag: 图标不变则标签不变, 浏览器可走 304
export const FAVICON_ETAG = '"${etag}"';

//: 纯指纹(不带引号): 页面侧拼成 /favicon.ico?v=<指纹>, 让浏览器换掉"本站没有图标"的旧记忆
export const FAVICON_HASH = '${etag}';

let cached = null;

/** 图标原始字节(首次调用解码, 之后复用)。 */
export function faviconBytes() {
  if (cached) return cached;
  const binary = atob(FAVICON_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  cached = bytes;
  return cached;
}

/** /favicon.ico 的响应: 根绝对路径(自定义域与预览域都成立), 必须由 Worker 自己响应, 见 DEPLOY.md。 */
export function faviconResponse() {
  const bytes = faviconBytes();
  return new Response(bytes, {
    headers: {
      'content-type': FAVICON_CONTENT_TYPE,
      'content-length': String(bytes.length),
      'cache-control': 'public, max-age=604800',
      etag: FAVICON_ETAG
    }
  });
}
`;

await writeFile(target, body, 'utf8');
console.log(`已生成 ${target}（${bytes.length} 字节 → ${base64.length} 字符 base64, etag=${etag}）`);
