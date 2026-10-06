// 缩略图计划: 按"目录随原图走"的规则算出每个原图期望的缩略图 key(与 core/storage.js::thumbKeyOf 同一实现)
// 用法: node tools/thumb_plan.mjs [原图清单] [--check 已有对象清单] [--widths 480,800]
import { readFileSync } from 'node:fs';

import { MEDIA_PREFIXES, thumbKeyOf } from '../app/core/storage.js';

//: 缺省两个宽度: 480 是笔记封面(接口下发), 800 是旧站预览页用的(Cloudflare 侧不读)
const DEFAULT_WIDTHS = [480, 800];

function argOf(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? '' : String(process.argv[at + 1] || '');
}

/** 第一个位置参数(跳过后面的 --flag 及其取值)。 */
function positional() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) { i += 1; continue; }
    return args[i];
  }
  return '';
}

/** 从一行工具输出里取出素材 key: 兼容 `wrangler r2 object list`(key 在前)与 `rclone ls`(key 在后)。 */
function keyIn(line) {
  const offsets = MEDIA_PREFIXES.map((prefix) => line.indexOf(prefix)).filter((at) => at >= 0);
  if (!offsets.length) return '';
  return line.slice(Math.min(...offsets)).split(/[\s"',]/)[0].replace(/^\/+/, '');
}

/** 一行一个 key; 认不出的行直接跳过(工具输出里的表头/统计行不影响结果)。 */
function readKeys(source) {
  const text = source && source !== '-' ? readFileSync(source, 'utf8') : readFileSync(0, 'utf8');
  return text.split('\n').map(keyIn).filter(Boolean);
}

const checkFile = argOf('--check');
if (!checkFile && process.stdin.isTTY && !positional()) {
  console.log('用法: node tools/thumb_plan.mjs <原图清单>|--check <已有对象清单> [--widths 480,800]');
  console.log('清单来自: wrangler r2 object list lyjxxapp-r2 --prefix=image  或  rclone ls r2:lyjxxapp-r2/image');
  process.exit(1);
}

const widths = (argOf('--widths') ? argOf('--widths').split(',') : DEFAULT_WIDTHS)
  .map((value) => Number(String(value).trim())).filter((value) => Number.isFinite(value) && value > 0);
const existing = checkFile ? new Set(readKeys(checkFile)) : null;
// 缩略图自己不是原图(清单里混进 _thumb 下的对象时不该再派生一层)
const originals = readKeys(positional()).filter((key) => !key.includes('/_thumb/'));

let expected = 0;
let missing = 0;
const lines = [];
for (const key of originals) {
  for (const width of widths) {
    const thumb = thumbKeyOf(key, width);
    if (!thumb) continue;                                  // 外链/头像等不派生缩略图
    expected += 1;
    const gap = existing ? !existing.has(thumb) : false;
    if (gap) missing += 1;
    lines.push(`${existing ? (gap ? '缺' : '有') : '缩略图'}  ${key}  →  ${thumb}`);
  }
}
console.log(lines.join('\n'));
console.log(`原图 ${originals.length} 个, 期望缩略图 ${expected} 个`
  + (existing ? `, 其中缺 ${missing} 个(需离线生成后按 key 上传)` : ''));
if (existing && missing) process.exitCode = 1;
