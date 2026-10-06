// 基础工具自检: MD5 标准向量、时间口径、素材地址、缩略图、净化、窗口计算
import assert from 'node:assert/strict';
import test from 'node:test';

import { routeTable } from '../main.js';
import { md5Hex } from '../app/core/md5.js';
import { beijingNow, datePart, nowEpoch, toEpoch, windowStart } from '../app/core/timeutil.js';
import { assetUrl, iconAssetUrl, thumbKey } from '../app/core/media_scheme.js';
import { sanitizeHtml } from '../app/core/sanitize.js';
import { QUOTAS } from '../app/core/ratelimit.js';
import { redactText } from '../app/core/logging.js';

test('MD5 与标准向量一致(新用户 username 命名依赖它)', () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Hex('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
});

test('日志脱敏: 带引号的敏感值也必须打码', () => {
  // SQL 里的字面量会被审计日志记进去, 这条漏了等于没脱敏(引号保留, 便于继续读日志)
  assert.equal(redactText("password = 'abc123'"), "password = '***'");
  assert.equal(redactText('token="xyz"'), 'token="***"');
  assert.ok(!redactText("session: 'zzz'").includes('zzz'));
  assert.equal(redactText('SELECT id FROM news'), 'SELECT id FROM news');
});

test('时间固定东八区且与库内字符串口径一致', () => {
  assert.match(beijingNow(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // 2026-10-04 12:00:00(+08:00) == 2026-10-04T04:00:00Z
  assert.equal(toEpoch('2026-10-04 12:00:00'), Date.UTC(2026, 9, 4, 4, 0, 0) / 1000);
  assert.equal(toEpoch(''), 0);
  assert.equal(toEpoch(null), 0);
  assert.equal(datePart('2026-10-04 12:00:00'), '2026-10-04');
  assert.equal(windowStart(60, new Date('2026-10-04T04:00:30Z')) % 60, 0);
  assert.equal(nowEpoch() > 1700000000, true);
});

test('素材地址: 相对路径拼媒体域, 绝对地址与包内图标原样', () => {
  const env = { MEDIA_BASE: 'https://storage.250036.xyz/' };
  assert.equal(assetUrl(env, 'news_uploads/a.png'), 'https://storage.250036.xyz/news_uploads/a.png');
  assert.equal(assetUrl(env, '/news_uploads/a.png'), 'https://storage.250036.xyz/news_uploads/a.png');
  assert.equal(assetUrl(env, 'https://gitee.com/x/y.png'), 'https://gitee.com/x/y.png');
  assert.equal(assetUrl(env, 'wxfile://tmp/x.png'), 'wxfile://tmp/x.png');
  assert.equal(assetUrl(env, ''), '');
  assert.equal(assetUrl(env, '', '/images/user.jpg'), '/images/user.jpg');
  assert.equal(iconAssetUrl(env, '/images/like.png'), '/images/like.png');
  assert.equal(iconAssetUrl(env, 'news_uploads/icon.png'), 'https://storage.250036.xyz/news_uploads/icon.png');
});

test('缩略图路径: 只有 news_uploads 下的封面派生, 目录固定 _thumb/<宽度>/', () => {
  assert.equal(thumbKey('news_uploads/home/a.jpg'), 'news_uploads/_thumb/480/a.webp');
  assert.equal(thumbKey('/news_uploads/home/a.png', 800), 'news_uploads/_thumb/800/a.webp');
  assert.equal(thumbKey('avatar_uploads/a.png'), '');
  assert.equal(thumbKey('https://x/y.png'), '');
});

test('富文本净化: 去脚本/事件属性/危险协议, 保留白名单标签', () => {
  const dirty = '<p onclick="x()">正常</p><script>alert(1)</script><img src="a.png" onerror="y()"><a href="javascript:z()">链接</a>';
  const clean = sanitizeHtml(dirty);
  assert.ok(!clean.includes('<script'));
  assert.ok(!clean.includes('onclick'));
  assert.ok(!clean.includes('onerror'));
  assert.ok(!clean.includes('javascript:'));
  assert.ok(clean.includes('<p>正常</p>'));
  assert.ok(clean.includes('<img src="a.png">'));
});

test('路由表就是计划里的 33 条对外接口(静态页不计入)', () => {
  const expected = [
    '/user/login', '/user/get_user_info', '/user/update_profile', '/user/upload_avatar',
    '/user/delete_account', '/user/deleted_account_action', '/user/user_favorites',
    '/user/user_likes', '/user/user_view_history',
    '/news/list', '/news/detail', '/news/like', '/news/favorite', '/news/share',
    '/news/add_comment', '/news/get_comments', '/news/check_user_action', '/news/check_user_like_batch',
    '/content/get_banners', '/content/get_outdoor', '/content/get_motorcycle', '/content/get_notices',
    '/content/get_notice_unread', '/content/notice_read',
    '/config/get_app_config',
    '/', '/test', '/index', '/info', '/apitest',
    '/health', '/health/ready', '/metrics'
  ];
  const paths = new Set(routeTable().filter((key) => !key.includes('/pages/')).map((key) => key.split(' ')[1]));
  assert.equal(expected.length, 33);
  const missing = expected.filter((path) => !paths.has(path));
  assert.deepEqual(missing, []);
});

test('限流配额与旧站一致', () => {
  assert.deepEqual(QUOTAS.like, { limit: 60, windowSec: 60 });
  assert.deepEqual(QUOTAS.favorite, { limit: 60, windowSec: 60 });
  assert.deepEqual(QUOTAS.share, { limit: 30, windowSec: 60 });
  assert.deepEqual(QUOTAS.comment, { limit: 20, windowSec: 60 });
  assert.deepEqual(QUOTAS.view_history, { limit: 120, windowSec: 60 });
  assert.deepEqual(QUOTAS.avatar, { limit: 5, windowSec: 60 });
});
