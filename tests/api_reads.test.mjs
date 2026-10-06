// 只读接口自检: 状态/探针/内容/配置/笔记读路径/静态页 —— 重点盯响应形态特例
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { TRUSTED_USER_ROW, USER_ROW, get, getJson, makeEnv } from './stub.mjs';

const noteRow = {
  id: 5, title: '标题', desc: '简介', image: 'news_uploads/home/a.jpg', video_url: '',
  category: 'outdoor', type: 'users', status: 'approved', publish_time: '2026-10-01 10:00:00',
  activity_time: '', view_count: 3, likes: 2, favorites: 1, shares: 0, user_id: 7
};

test('状态类: HTML 状态页 / format=json / 301 重定向 / apitest', async () => {
  const { env } = makeEnv({ db: (sql) => (/SELECT 1 AS c/i.test(sql) ? { c: 1 } : null) });
  const page = await get('/', env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /服务状态/);
  // 信息项与旧站 templates/status.html 对齐: 标题药丸 / 两个时间 / 说明 / 6 项统计 / 依赖监控 / 使用说明
  for (const text of ['服务器时间', '进程启动时间', '数据统计', '总用户数', '今日新增', '本周新增',
    '本月新增', '笔记总数', '评论总数', '依赖状态监控', '序号', '当前使用', '响应时间',
    '总连接状态', '使用说明', '/apitest', '/test']) {
    assert.ok(html.includes(text), `状态页缺少「${text}」`);
  }
  assert.ok(html.includes('data-live="clock"'), '服务器时间要交给 live_time.js 走动');
  assert.ok(html.includes('data-live-anchor='), '首屏时间锚点不能少(否则首帧显示的是本机时间)');
  assert.ok(html.includes('/admin/static/js/live_time.js?v='), '走动时间要复用后台那一份实现');

  const asJson = await getJson('/?format=json', env);
  assert.equal(asJson.status, '运行中');
  assert.equal(asJson.name, '狼牙极限运动笔记API');
  assert.ok(asJson.server_time);

  // /test 收敛到 /apitest, /index 与 /info 回首页(与旧站实测一致)
  for (const [path, target] of [['/test', '/apitest'], ['/index', '/'], ['/info', '/']]) {
    const res = await get(path, env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), target);
  }

  const probe = await getJson('/apitest', env);
  assert.equal(probe.code, 200);
  assert.equal(probe.msg, 'API测试成功');
  assert.equal(probe.data.api_status, 'online');
  assert.equal(probe.data.database_connected, true);
  assert.equal(typeof probe.timestamp, 'number');
});

test('站点图标: /favicon.ico 直出 app/favicon.ico 的字节, 不依赖 R2', async () => {
  // R2 桩刻意给"取不到"(默认 null): 图标由 Worker 内联字节直出, 不该依赖 R2 有没有该对象
  const { env } = makeEnv();
  const res = await get('/favicon.ico', env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/x-icon');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=604800');
  assert.ok(res.headers.get('etag'), '标签稳定才能走 304');

  const bytes = new Uint8Array(await res.arrayBuffer());
  const source = await readFile(new URL('../app/favicon.ico', import.meta.url));
  assert.equal(bytes.length, source.length, '图标字节数要与仓库里的文件一致');
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), Array.from(source.subarray(0, 8)), '文件头要对得上');
});

test('站点图标: 对外页与协议页都带 <link rel="icon">', async () => {
  const { env } = makeEnv({ db: (sql) => (/SELECT 1 AS c/i.test(sql) ? { c: 1 } : null) });
  for (const path of ['/', '/pages/terms', '/pages/privacy', '/pages/download']) {
    const res = await get(path, env);
    assert.equal(res.status, 200, `${path} 应能打开`);
    assert.ok((await res.text()).includes('<link rel="icon" href="/favicon.ico" type="image/x-icon">'),
      `${path} 缺少站点图标引用`);
  }
});

test('探针: /health 200, /health/ready 数据库异常时 503', async () => {
  const healthy = makeEnv({ db: (sql) => (/SELECT 1 AS c/i.test(sql) ? { c: 1 } : null), media: { head: {} } });
  const health = await getJson('/health', healthy.env);
  // 裸结构(与旧站一致): 没有 code 包装
  assert.equal(health.code, undefined);
  assert.equal(health.status, 'ok');
  assert.equal(health.service, '狼牙极限运动笔记API');
  assert.equal(health.checks.database, true);
  assert.equal(health.checks.media, true);
  const ready = await get('/health/ready', healthy.env);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).status, 'ready');

  const broken = makeEnv({ db: () => { throw new Error('d1 down'); } });
  const res = await get('/health/ready', broken.env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, 'starting');
});

test('轮播图: code=0 且 message 与 msg 并存, 图片补绝对地址', async () => {
  const { env } = makeEnv({ db: (sql) => (/FROM banner_images/i.test(sql)
    ? { all: [{ id: 1, title: '图', image_url: 'news_uploads/banner.png', link_url: null }] } : null) });
  const body = await getJson('/content/get_banners?position=news&limit=5', env);
  assert.equal(body.code, 0);
  assert.equal(body.msg, 'success');
  assert.equal(body.message, 'success');
  assert.equal(body.data[0].image_url, 'https://media.test/news_uploads/banner.png');
});

test('专题: code/msg/status/message 四键, 非测试用户 video_url 键被删掉', async () => {
  const rows = [{ id: 1, title: '户外', description: '', date: '2026-01-01', location: 'x', poster: 'news_uploads/home/p.jpg', videoUrl: 'news_uploads/v.mp4', created_at: '', updated_at: '' }];
  const guest = makeEnv({ db: (sql) => (/FROM outdoor_activities/i.test(sql) ? { all: rows } : null) });
  const guestBody = await getJson('/content/get_outdoor', guest.env);
  assert.equal(guestBody.code, 200);
  assert.equal(guestBody.status, 'success');
  assert.equal(guestBody.message, guestBody.msg);
  assert.equal(guestBody.data[0].can_watch_video, false);
  assert.ok(!('video_url' in guestBody.data[0]));
  assert.ok(!('videoUrl' in guestBody.data[0]));
  assert.equal(guestBody.data[0].poster, 'https://media.test/news_uploads/home/p.jpg');

  const trusted = makeEnv({
    db: (sql) => {
      if (/FROM users WHERE token=/i.test(sql)) return TRUSTED_USER_ROW;
      if (/FROM outdoor_activities/i.test(sql)) return { all: rows };
      return null;
    }
  });
  const trustedBody = await getJson('/content/get_outdoor?token=tok-trusted', trusted.env);
  assert.equal(trustedBody.data[0].can_watch_video, true);
  assert.equal(trustedBody.data[0].video_url, 'https://media.test/news_uploads/v.mp4');
});

test('公告: 只有 message 键, 带 pageSize, level_text 映射, 未登录不下发 is_read', async () => {
  const { env } = makeEnv({
    db: (sql) => {
      if (/COUNT\(\*\) AS c FROM app_notices/i.test(sql)) return { c: 1 };
      if (/FROM app_notices/i.test(sql)) return { all: [{ id: 9, title: '公告', content: '内容', level: 'warning', link_type: 'page', link_value: '/pages/activity/activity', create_time: '2026-10-01 09:00:00' }] };
      return null;
    }
  });
  const body = await getJson('/content/get_notices?page=1&page_size=10', env);
  assert.equal(body.code, 200);
  assert.equal(body.message, '获取通知公告成功');
  assert.equal(body.msg, undefined);
  const data = body.data;
  assert.equal(data.pageSize, 10);
  assert.equal(data.page_size, 10);
  assert.equal(data.has_more, false);
  assert.equal(data.list[0].level_text, '提醒');
  assert.equal(data.list[0].published_at, '2026-10-01');
  assert.ok(!('is_read' in data.list[0]));
});

test('公告未读: 未登录回 200+"未登录"(旧站口径); 标记已读需要登录', async () => {
  const { env } = makeEnv({ db: () => null });
  // 旧站: 未登录 **不是错误** —— 200 + msg"未登录" + 空数据(小程序启动即调, 不该弹错误)
  const guest = await getJson('/content/get_notice_unread', env);
  assert.equal(guest.code, 200);
  assert.equal(guest.msg, '未登录');
  assert.deepEqual(guest.data, { unread_count: 0, ids: [] });
  // 标记已读是写操作: 无 token 必须 401(旧站文案就是"未登录")
  const denied = await getJson('/content/notice_read', env);
  assert.equal(denied.code, 401);
  assert.equal(denied.msg, '未登录');

  const logged = makeEnv({
    db: (sql) => {
      if (/FROM users WHERE token=/i.test(sql)) return USER_ROW;
      if (/SELECT notice_id FROM app_notice_reads/i.test(sql)) return { all: [{ notice_id: 1 }] };
      // COUNT 规则必须在通用规则之前, 否则会被 "FROM app_notices" 提前吃掉
      if (/COUNT\(\*\) AS c FROM app_notices/i.test(sql)) return { c: 2 };
      if (/COUNT\(\*\) AS c FROM app_notice_reads/i.test(sql)) return { c: 1 };
      if (/FROM app_notices/i.test(sql)) return { all: [{ id: 1 }, { id: 2 }] };
      return null;
    }
  });
  const unread = await getJson('/content/get_notice_unread?token=tok-1', logged.env);
  assert.equal(unread.msg, '获取未读公告成功');
  assert.equal(unread.data.unread_count, 1);
  assert.deepEqual(unread.data.ids, [2]);

  const read = await getJson('/content/notice_read?token=tok-1&notice_id=2', logged.env);
  assert.equal(read.msg, '已标记为已读');
  assert.equal(read.data.notice_id, 2);
  assert.equal(read.data.unread_count, 1);
});

test('应用配置: message 键 + timestamp, 表空时回退内置内容', async () => {
  const { env } = makeEnv({ db: () => null });
  const body = await getJson('/config/get_app_config', env);
  assert.equal(body.code, 200);
  assert.equal(body.message, '获取应用配置成功');
  assert.equal(typeof body.timestamp, 'number');
  const data = body.data;
  assert.equal(data.categories.length, 9);
  assert.deepEqual(data.home_sections.map((item) => item.key), ['main', 'ext']);
  assert.equal(data.home_sections[0].items[0].id, 'outdoor');
  assert.equal(data.home_sections[0].items[0].name, '户外');
  assert.equal(data.featured.length, 2);
  assert.equal(data.menu.length, 7);
  assert.equal(data.menu[0].need_login, true);
  assert.equal(data.version.update_tip, '发现新版本，更新后体验更好');
  assert.equal(data.texts['login.prompt'].length > 0, true);
});

test('笔记列表: 不带 page 没有 msg 键; 带 page 有 total 与 has_more', async () => {
  const { env } = makeEnv({
    db: (sql) => {
      if (/FROM users WHERE token=/i.test(sql)) return USER_ROW;
      if (/FROM app_categories/i.test(sql)) return { all: [{ category_key: 'outdoor' }] };
      if (/COUNT\(\*\) AS c FROM news/i.test(sql)) return { c: 5 };
      if (/FROM news WHERE/i.test(sql)) return { all: [noteRow] };
      if (/SELECT news_id FROM news_likes/i.test(sql)) return { all: [{ news_id: 5 }] };
      return null;
    },
    media: { head: null }
  });
  const bare = await getJson('/news/list?token=tok-1', env);
  assert.equal(bare.code, 200);
  assert.ok(!('msg' in bare));
  assert.equal(bare.data[0].image, 'https://media.test/news_uploads/home/a.jpg');
  assert.equal(bare.data[0].is_liked, true);
  assert.ok(!('image_thumb' in bare.data[0]));

  const paged = await getJson('/news/list?page=1&page_size=2', env);
  assert.equal(paged.msg, '获取成功');
  assert.equal(paged.data.total, 5);
  assert.equal(paged.data.page_size, 2);
  assert.equal(paged.data.has_more, true);
});

test('笔记详情: 400/404 文案与 is_admin 三种情况', async () => {
  const { env } = makeEnv({ db: () => null });
  assert.equal((await getJson('/news/detail', env)).msg, '参数错误');
  assert.equal((await getJson('/news/detail?id=9', env)).msg, '笔记不存在或未通过审核');

  const detailEnv = makeEnv({
    db: (sql) => {
      if (/FROM news n LEFT JOIN users au/i.test(sql)) {
        return Object.assign({}, noteRow, { content: '<p>正文<img src="news_uploads/inline.png"></p>', author: 'wx_abc', author_nickname: '老王', viewer_id: 0 });
      }
      return null;
    }
  });
  const detail = await getJson('/news/detail?id=5', detailEnv.env);
  assert.equal(detail.msg, '获取成功');
  assert.equal(detail.data.author, 'wx_abc');
  assert.equal(detail.data.is_admin, false);
  assert.equal(detail.data.content.includes('https://media.test/news_uploads/inline.png'), true);
  assert.equal(detail.data.is_liked, false);
});

test('评论列表: 缺 news_id 给 400; 正常返回 pagination', async () => {
  const { env } = makeEnv({ db: () => null });
  const missing = await getJson('/news/get_comments', env);
  assert.equal(missing.code, 400);
  assert.equal(missing.msg, '缺少笔记ID');

  const withData = makeEnv({
    db: (sql) => {
      if (/COUNT\(\*\) AS c FROM news_comments/i.test(sql)) return { c: 1 };
      if (/FROM news_comments c/i.test(sql)) return { all: [{ id: 1, content: '好', created_at: '2026-10-01 10:20:33', user_id: 7, nickname: '老王', username: 'wx_a', avatar: '' }] };
      return null;
    }
  });
  const body = await getJson('/news/get_comments?news_id=5', withData.env);
  assert.equal(body.data.comments[0].created_at, '2026-10-01 10:20');
  assert.equal(body.data.comments[0].user_avatar, 'https://media.test/images/user.png');
  assert.equal(body.data.pagination.total, 1);
  assert.equal(body.data.pagination.has_more, false);
});

test('行为状态与批量点赞态', async () => {
  const { env } = makeEnv({ db: () => null });
  assert.equal((await getJson('/news/check_user_action?news_id=5', env)).code, 400);

  const withState = makeEnv({
    db: (sql) => {
      if (/SELECT likes,favorites,shares,view_count FROM news/i.test(sql)) return { likes: 2, favorites: 1, shares: 0, view_count: 9 };
      if (/FROM news_likes WHERE news_id=\? AND user_id=\?/i.test(sql)) return { id: 1 };
      return null;
    }
  });
  const state = await getJson('/news/check_user_action?news_id=5&user_id=7', withState.env);
  assert.equal(state.code, 200);
  assert.equal(state.data.is_liked, true);
  assert.equal(state.data.is_favorited, false);
  assert.equal(state.data.view_count, 9);
});

test('静态页: 协议与隐私正文来自 app_texts, 取不到用内置兜底', async () => {
  const fromDb = makeEnv({
    db: (sql) => (/FROM app_texts WHERE text_key=/i.test(sql) ? { content: '来自数据库的正文' } : null)
  });
  const terms = await (await get('/pages/terms', fromDb.env)).text();
  assert.match(terms, /来自数据库的正文/);
  const privacy = await (await get('/pages/privacy', fromDb.env)).text();
  assert.match(privacy, /来自数据库的正文/);

  const fallback = makeEnv({ db: () => null });
  const privacy2 = await (await get('/pages/privacy', fallback.env)).text();
  assert.match(privacy2, /仅收集您的微信昵称与头像/);
  const download = await (await get('/pages/download', fallback.env)).text();
  assert.match(download, /狼牙极限运动笔记/);
});
