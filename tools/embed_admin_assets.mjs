// 把 app/admin/static/** 打包成 app/admin/assets/static-assets.js(生成物, 不要手改)
// 用法: node tools/embed_admin_assets.mjs; 改了 static/** 必须重跑并升 main.js 的 API_VERSION(?v= 缓存键)
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const SOURCE = resolve(root, 'app/admin/static');
const TARGET = resolve(root, 'app/admin/assets/static-assets.js');
//: 二进制资源按扩展名识别, 打包成 data: URL
const BINARY = { woff: 'font/woff', woff2: 'font/woff2' };

const HEADER = [
  '// 生成物: admin/static/** 下的全部资源(css/js/vendor/字体)转成 JS 文本模块, Worker 与 Node 都能直接 import',
  '// 字体是二进制, 生成阶段用 base64 包成 data: URL(serveStatic 解码后按二进制返回)',
  '// 重新生成: node tools/embed_admin_assets.mjs(改了 static/** 必须重跑, 并升 main.js 的 API_VERSION)'
];

async function walk(dir, prefix = '') {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walk(join(dir, entry.name), key));
    else out.push(key);
  }
  return out;
}

// 沿用上一版生成物的键顺序, 新增的排到末尾 —— 避免每次重生成都产生整文件重排的无意义 diff
async function previousKeys() {
  try {
    const text = await readFile(TARGET, 'utf8');
    return [...text.matchAll(/^ {2}'([^']+)': /gm)].map((match) => match[1]);
  } catch (error) {
    return [];
  }
}

// 沿用之前的 PowerShell ConvertTo-Json 转义风格(< > & ' 走 \u00xx): 值语义一样, 字节一致才不会每次都大改
function quote(text) {
  return JSON.stringify(text)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/'/g, '\\u0027');
}

const keys = await walk(SOURCE);
const previous = await previousKeys();
const order = [...previous.filter((key) => keys.includes(key)), ...keys.filter((key) => !previous.includes(key))];

const lines = [];
for (const key of order) {
  const file = join(SOURCE, key.split('/').join(sep));
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  const value = BINARY[ext]
    ? `data:${BINARY[ext]};base64,${(await readFile(file)).toString('base64')}`
    : await readFile(file, 'utf8');
  lines.push(`  '${key}': ${quote(value)}`);
}

const body = [...HEADER, 'export default {', lines.join(',\n'), '};', ''].join('\n');
await writeFile(TARGET, body, 'utf8');
console.log(`已生成 ${TARGET}（${order.length} 个资源）`);
