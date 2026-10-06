// 媒体直出自检: R2 绑定名与 wrangler.toml 保持一致, 三个素材前缀都能直出(含 Range/206)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { settings } from '../app/core/config.js';
import { get, makeEnv, request } from './stub.mjs';

const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');

//: 模拟 R2 对象(只需 serveObject 用到的那几个字段)
function objectOf(body, options = {}) {
  return {
    body,
    size: options.size === undefined ? body.length : options.size,
    httpEtag: options.etag || '"abc"',
    range: options.range,
    writeHttpMetadata(headers) { headers.set('content-type', 'image/jpeg'); }
  };
}

test('R2 绑定名与 wrangler.toml 一致(STORAGE), 旧名 MEDIA 仍可用', () => {
  assert.match(wrangler, /\[\[r2_buckets\]\][\s\S]*?binding = "STORAGE"/, 'wrangler.toml 的 R2 绑定名应为 STORAGE');
  const bucket = { head: async () => null };
  assert.equal(settings({ STORAGE: bucket }).storage, bucket);
  assert.equal(settings({ MEDIA: bucket }).storage, bucket, '旧绑定名要能用, 避免改绑定期出现空窗');
  assert.equal(settings({}).storage, null, '没绑定时要显式为空, 不要悄悄回退到 undefined');
});

test('媒体直出: 三个素材前缀都走 R2, 带 etag 与长缓存', async () => {
  const body = 'IMG-BYTES';
  const keys = ['images/logo.png', 'news_uploads/home/a.jpg', 'avatar_uploads/u.png'];
  const { env } = makeEnv({ media: { get: (key) => (keys.includes(key) ? objectOf(body) : null) } });
  for (const key of keys) {
    const res = await get(`/${key}`, env);
    assert.equal(res.status, 200, `${key} 应能直出`);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('etag'), '"abc"');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=604800');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(await res.text(), body);
  }
  assert.equal((await get('/news_uploads/none.jpg', env)).status, 404);
});

test('媒体直出: Range 请求回 206 与 content-range(视频拖动依赖)', async () => {
  const seen = [];
  const { env } = makeEnv({
    media: {
      get: (key, opts) => {
        seen.push(opts);
        return objectOf('abcdefghij', { size: 10, range: { offset: 2, length: 3 } });
      }
    }
  });
  const res = await request('/news_uploads/a.mp4', { env, headers: { range: 'bytes=2-4' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 2-4/10');
  assert.deepEqual(seen[0], { range: { offset: 2, length: 3 } }, '要按 Range 向 R2 取那一段');

  // bytes=500- 与 bytes=-500 也要认(拖到中段/从头播)
  await request('/news_uploads/a.mp4', { env, headers: { range: 'bytes=500-' } });
  assert.deepEqual(seen[1], { range: { offset: 500 } });
  await request('/news_uploads/a.mp4', { env, headers: { range: 'bytes=-500' } });
  assert.deepEqual(seen[2], { range: { suffix: 500 } });
});

test('媒体直出: R2 对象没带 content-type 时按扩展名兜底', async () => {
  // 用 wrangler/rclone 传上去的素材常常没有 httpMetadata; 缺 content-type + nosniff 可能让浏览器不当图片渲染
  const bare = () => ({ body: 'x', size: 1, httpEtag: '"e"', writeHttpMetadata() {} });
  const { env } = makeEnv({ media: { get: bare } });
  assert.equal((await get('/news_uploads/home/a.jpg', env)).headers.get('content-type'), 'image/jpeg');
  assert.equal((await get('/news_uploads/v.mp4', env)).headers.get('content-type'), 'video/mp4');
  // 猜不出的扩展名不给类型(运行时会给 text/plain, 关键是别乱猜成图片)
  const unknown = (await get('/news_uploads/unknown.bin', env)).headers.get('content-type') || '';
  assert.ok(!unknown.startsWith('image/'), '不能把未知扩展名猜成图片');
});

test('媒体直出: 未绑定 R2 回 502, 非 GET/HEAD 回 405', async () => {
  const missing = makeEnv();
  missing.env.STORAGE = undefined;
  assert.equal((await get('/images/x.png', missing.env)).status, 502);

  const { env } = makeEnv({ media: { get: () => objectOf('x') } });
  const post = await request('/images/x.png', { env, method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');

  // 非法百分号编码: 回 400, 而不是抛成未捕获异常(未捕获会被算成 500)
  assert.equal((await get('/images/%zz.png', env)).status, 400);
});
