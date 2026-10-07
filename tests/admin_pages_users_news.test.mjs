// 用户/管理员/留言/笔记/上传 端到端自检
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAdmin } from '../app/admin/index.js';
import { findCall, get, HOST, loginCookie, makeAdminEnv, post } from './admin_stub.mjs';

const USER_ROW = {
  id: 7, username: 'wx_abc', nickname: '老王', email: '', avatar: 'avatar_uploads/a.png',
  login_type: 'wechat', is_trusted: 0, status: 0, create_time: '2026-09-01 10:00:00',
  last_login_time: '2026-09-30 20:00:00', deleted_at: null, raw_nickname: '老王'
};
const NEWS_ROW = {
  id: 5, title: '重走来时路', desc: '摘要', category: 'outdoor', image: 'news_uploads/a.png',
  publish_time: '2026-10-01 09:00:00', status: 'approved', type: 'admin_users',
  view_count: 3, likes: 2, favorites: 1, content: '<p>正文</p>', video_url: '', activity_time: ''
};

test('用户列表: 搜索与内部测试筛选进 SQL, 昵称直读库字段', async () => {
  const { env, state } = makeAdminEnv({ rows: { users: [USER_ROW] }, counts: { users: 1 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/users?search=王&trusted=untrusted', env, cookie)).text();
  assert.ok(html.includes('老王'));
  assert.ok(html.includes('https://media.test/avatar_uploads/a.png'), '头像要拼绝对地址');
  assert.ok(html.includes('普通'), '类型徽章');
  const count = findCall(state, /COUNT\(\*\) AS total FROM users/i);
  assert.ok(/username LIKE \?/.test(count.sql) && /is_trusted = 0/.test(count.sql));
});

test('用户列表: 非超管看不到敏感操作按钮', async () => {
  const { env } = makeAdminEnv({ role: 'normal', rows: { users: [USER_ROW] }, counts: { users: 1 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/users', env, cookie)).text();
  assert.ok(html.includes('详情'));
  assert.ok(!html.includes('设为内部测试'));
  assert.ok(!html.includes('>删除<'));
});

test('用户写操作: 设为内部测试 / 删除用户(级联) / 恢复账号', async () => {
  const { env, state } = makeAdminEnv({ db: (sql, args, kind) => (kind === 'first' && /FROM users WHERE id = \?/i.test(sql) ? USER_ROW : undefined) });
  const cookie = await loginCookie(env);

  const trusted = await post('/admin/users', { action: 'set_trusted', user_id: '7' }, env, cookie);
  assert.equal(trusted.status, 302);
  assert.ok(trusted.headers.get('location').includes(encodeURIComponent('已成功设置为内部测试用户')));

  // 列表里的两个按钮都要能提交, 且先弹确认(超管才看得到)
  const listEnv = makeAdminEnv({ rows: { users: [USER_ROW] }, counts: { users: 1 } });
  const listCookie = await loginCookie(listEnv.env);
  const listHtml = await (await get('/admin/users', listEnv.env, listCookie)).text();
  assert.ok(listHtml.includes('name="action" value="set_trusted"'), '按钮要把 action 提交上去');
  assert.ok(listHtml.includes('onclick="return confirm('), '设为/取消内部测试都要先确认');
  assert.ok(listHtml.includes('设为内部测试用户？设置后可查看专题视频'), '确认文案要写清权限范围');

  const restored = await post('/admin/users', { action: 'restore_user', user_id: '7' }, env, cookie);
  assert.ok(restored.headers.get('location').includes(encodeURIComponent('账号已恢复')));
  const restoreSql = findCall(state, /UPDATE users SET status=0, nickname=\?/i);
  assert.ok(restoreSql, '恢复要重算昵称');
  assert.ok(!/deleted_at/.test(restoreSql.sql), '恢复时 deleted_at 必须保留(后台据此显示"已恢复")');
  assert.ok(String(restoreSql.args[0]).endsWith('(已恢复)'), restoreSql.args[0]);

  const removed = await post('/admin/users', { action: 'delete_user', user_id: '7' }, env, cookie);
  assert.ok(removed.headers.get('location').includes(encodeURIComponent('已全部删除')));
});

test('用户详情: 缺 id 时给出明确文案', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/user_detail', env, cookie)).text();
  assert.ok(html.includes('缺少有效的用户ID参数'));
});

test('管理员列表: 内置超管不显示重置/删除按钮', async () => {
  const { env } = makeAdminEnv({
    rows: { admin_users: [{ id: 1, username: 'admin', nickname: '管理员', email: '' }] },
    counts: { admin_users: 1 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/admin_users', env, cookie)).text();
  assert.ok(html.includes('超管'));
  assert.ok(html.includes('内置账户'));
  assert.ok(!html.includes('重置口令'));
});

test('管理员: 重置口令成功时就地渲染(口令绝不进 URL)', async () => {
  const { env } = makeAdminEnv({
    db: (sql, args, kind) => (kind === 'first' && /FROM admin_users WHERE id = \?/i.test(sql)
      ? { id: 2, username: 'helper' } : undefined)
  });
  const cookie = await loginCookie(env);
  const res = await post('/admin/admin_users', { reset_admin_password: '1', admin_id: '2' }, env, cookie);
  assert.equal(res.status, 200, '不能 302 —— 口令会落进访问日志');
  const html = await res.text();
  assert.ok(html.includes('新密码仅本次显示'));
});

test('管理员: 新增时两次口令不一致被拒', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/admin_users',
    { add_admin: '1', username: 'newbie', password: 'password-1234', confirm_password: 'password-9999' }, env, cookie);
  assert.ok((await res.text()).includes('两次输入的密码不一致'));
  assert.equal(findCall(state, /INSERT INTO admin_users/i), null);
});

test('留言: 删除是物理删除且文案写明不可恢复', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/comments_manage', { action: 'delete', id: '9' }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('留言已删除（不可恢复）')));
  assert.ok(findCall(state, /DELETE FROM news_comments WHERE id = \?/i));
});

test('笔记列表: 复选框列 + 批量区 + 回收站入口', async () => {
  const { env } = makeAdminEnv({ rows: { news: [NEWS_ROW] }, counts: { news: 1 }, rows2: {} });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_manage', env, cookie)).text();
  assert.ok(html.includes('rowCheck'));
  // 表头复选框必须是真控件: 曾经被 listShell 转义, 页面上显示成一段源码文本
  assert.ok(html.includes('<th scope="col"><input type="checkbox" id="rowCheckAll" aria-label="全选"></th>'));
  assert.ok(!html.includes('&lt;input'), '列表页不应出现被转义的 input 源码');
  assert.ok(html.includes('batchForm'));
  assert.ok(html.includes('回收站'));
  assert.ok(html.includes('设为显示'));
});

test('笔记预览: 结构/类名与旧站 news_preview 一致, 分类显示中文, 不 +1 浏览量', async () => {
  const { env, state } = makeAdminEnv({
    rows: {
      news: [Object.assign({}, NEWS_ROW, {
        video_url: 'video/v1.mp4', content: '<p>正文</p><img src="image/a.png" alt="">'
      })],
      app_categories: [{ category_key: 'outdoor', name: '户外' }]
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_preview?id=5', env, cookie)).text();

  // 与旧站 templates/news_preview.html 同结构: 800px 手机框 + 卡片 + 元信息 + 两个居中返回按钮
  for (const cls of ['mp-preview mp-frame', 'mp-frame-hint', 'mp-cover', 'mp-card', 'mp-title',
    'mp-meta', 'mp-chip', 'mp-author', 'mp-video', 'news-content', 'page-actions-center']) {
    assert.ok(html.includes(cls), `预览页缺少 .${cls.split(' ')[0]}`);
  }
  assert.ok(html.includes('小程序笔记详情页预览（800px 宽，与编辑区一致）'));
  assert.ok(html.includes('封面图（列表页展示）'), '封面要有标注');
  assert.ok(html.includes('副标题（列表页展示）'), '摘要要有标注');
  assert.ok(html.includes('<span class="mp-chip">户外</span>'), '分类要显示中文(不是 outdoor)');
  assert.ok(html.includes('<span class="mp-author">管理员</span>'));
  // 主视频 + 正文里的视频都转成浏览器可播的 <video>(绝对地址)
  assert.ok(html.includes('/video/v1.mp4'), '主视频地址要绝对化');
  assert.ok(html.includes('<i class="bi bi-eye" aria-hidden="true"></i> 3'), '统计: 浏览');
  assert.ok(html.includes('返回编辑') && html.includes('返回列表'));
  // 预览是只读的: 不许给前台浏览量 +1(旧站口径)
  assert.ok(!state.calls.some((call) => /UPDATE news SET view_count/i.test(call.sql)), '预览不该改浏览量');
});

test('笔记预览: 正文与封面优先用 800px 缩略图, 没有则回退原图', async () => {
  const withThumb = makeAdminEnv({
    rows: { news: [Object.assign({}, NEWS_ROW, { content: '<p>正文</p><img src="image/a.png" alt="">' })] },
    mediaHead: (key) => (/(\/_thumb\/800\/)/.test(key) ? { key } : null)
  });
  const cookie = await loginCookie(withThumb.env);
  const html = await (await get(withThumb.env === undefined ? '' : '/admin/news_preview?id=5',
    withThumb.env, cookie)).text();
  assert.ok(html.includes('image/_thumb/800/a.webp'), '正文配图要换成 800px 缩略图');
  assert.ok(html.includes('news_uploads/_thumb/800/a.webp'), '封面也要换 800px 缩略图');

  // 没有缩略图(默认桩 head 为 null) → 逐字回退原图
  const noThumb = makeAdminEnv({
    rows: { news: [Object.assign({}, NEWS_ROW, { content: '<p>正文</p><img src="image/a.png" alt="">' })] }
  });
  const cookie2 = await loginCookie(noThumb.env);
  const plain = await (await get('/admin/news_preview?id=5', noThumb.env, cookie2)).text();
  assert.ok(!plain.includes('_thumb/800/'), '没有缩略图就不该出现缩略图地址');
  assert.ok(plain.includes('news_uploads/a.png'), '回退到原图地址');
});

test('笔记编辑: 与旧站同布局(单列 mp-frame + 发布设置卡 + 数据统计卡)', async () => {
  const { env } = makeAdminEnv({
    rows: { news: [NEWS_ROW], app_categories: [{ category_key: 'outdoor', name: '户外' }] }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_edit?id=5', env, cookie)).text();
  assert.ok(html.includes('<div class="row g-3 justify-content-center">'), '单列居中(旧站 news_edit 布局)');
  assert.ok(html.includes('col-lg-8 mp-frame'), '主列取 800px 小程序尺度');
  assert.ok(html.includes('<div class="form-label">发布设置</div>'), '发布设置收在一张卡里');
  assert.ok(html.includes('数据统计：浏览 3 ｜ 点赞 2 ｜ 收藏 1'), '编辑已有笔记要显示统计卡');
  assert.ok(html.includes('name="status"') && html.includes('name="publish_time"') && html.includes('name="activity_time"'));
  // 新建页没有统计卡(与旧站一致)
  const fresh = await (await get('/admin/news_edit?id=0', env, cookie)).text();
  assert.ok(!fresh.includes('数据统计：浏览'), '新建页不该有统计卡');
  // 字段顺序: 标题 → 分类 → 封面 → 视频地址 → 摘要 → 正文
  const order = ['name="title"', 'name="category"', 'name="image"', 'name="video_url"', 'name="desc"', 'id="contentRaw"']
    .map((needle) => html.indexOf(needle));
  assert.ok(order.every((at) => at > 0), '六个字段都要在页面上');
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), '字段顺序要与旧站一致');
});

test('列表页: 三个带状态筛选的页面都声明了就地隐藏用的属性', async () => {
  const { env } = makeAdminEnv({
    rows: { news: [NEWS_ROW], news_comments: [], app_notices: [] }, counts: { news: 1, news_comments: 0, app_notices: 0 }
  });
  const cookie = await loginCookie(env);
  for (const path of ['/admin/news_manage', '/admin/comments_manage', '/admin/notice_manage']) {
    const html = await (await get(path, env, cookie)).text();
    assert.ok(html.includes('data-status-filter-param="status"'), `${path} 要声明状态筛选参数`);
  }
});

test('笔记编辑: 必填项合并成一句, 正文视频转成 wx-video 且摘要自动截取', async () => {
  // 分类下拉来自 app_categories: 不给数据会被"分类无效"拦下(校验是对的)
  const { env, state } = makeAdminEnv({
    rows: { app_categories: [{ category_key: 'outdoor', name: '户外', status: 1 }] }
  });
  const cookie = await loginCookie(env);
  const missing = await post('/admin/news_edit?id=0', { title: '标题' }, env, cookie);
  assert.ok((await missing.text()).includes('请填写必填项: 分类、封面图、正文内容'));

  const stored = await post('/admin/news_edit?id=0', {
    title: '带视频的笔记', category: 'outdoor', image: 'news_uploads/a.png',
    content: '<p>正文</p><div data-w-e-type="video"><video><source src="/news_uploads/video_1.mp4" type="video/mp4"></video></div>',
    status: '1', publish_time: '2026-10-05T10:30'
  }, env, cookie);
  assert.equal(stored.status, 302);
  const insert = findCall(state, /INSERT INTO news/i);
  assert.ok(insert.args[2].includes('<wx-video src="news_uploads/video_1.mp4"'), '视频要还原成库内格式');
  assert.ok(insert.args[2].includes('object-fit="cover"'));
  assert.equal(insert.args[1], '正文', '摘要留空时自动截取正文');
  assert.equal(insert.args[6], 'approved');
  assert.equal(insert.args[7], '2026-10-05 10:30:00', 'datetime-local 的 T 要归一');
});

test('笔记编辑: 新目录素材(image//video/)进出库都还原成相对记录值', async () => {
  const { env, state } = makeAdminEnv({
    rows: { app_categories: [{ category_key: 'outdoor', name: '户外', status: 1 }] }
  });
  const cookie = await loginCookie(env);
  // 编辑器交上来的是站点根路径(编辑页在 /admin/ 下, 相对地址会解析错), 图片与视频都要还原成相对值
  const stored = await post('/admin/news_edit?id=0', {
    title: '新目录素材', category: 'outdoor', image: '/image/cover.png',
    content: '<p>正文</p><img src="/image/a.png"><video src="/video/v.mp4" controls></video>',
    status: '1', publish_time: '2026-10-06T09:00'
  }, env, cookie);
  assert.equal(stored.status, 302);
  const insert = findCall(state, /INSERT INTO news/i);
  assert.ok(insert.args[2].includes('<img src="image/a.png">'), '图片要还原成 image/ 相对值');
  assert.ok(insert.args[2].includes('<wx-video src="video/v.mp4"'), '视频要还原成 video/ 相对值');
  assert.ok(!insert.args[2].includes('"/image/'), '入库不该留前导斜杠');
  // 封面/视频地址是单值字段, 与旧站一致只做去空白(不做路径归一): 素材库与上传给的本来就是相对值
  assert.equal(insert.args[4], '/image/cover.png');
});

test('笔记删除与复制: 文案与幂等键', async () => {
  const { env, state } = makeAdminEnv({
    db: (sql, args, kind) => {
      if (kind === 'first' && /SELECT title FROM news/i.test(sql)) return { title: '老笔记' };
      if (kind === 'first' && /SELECT \* FROM news/i.test(sql)) return NEWS_ROW;
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const removed = await post('/admin/news_delete', { id: '5' }, env, cookie);
  assert.ok(removed.headers.get('location').includes(encodeURIComponent('已移入回收站')));
  const update = findCall(state, /UPDATE news SET deleted_at=\?/i);
  assert.ok(update, '软删除只标记 deleted_at');

  const copied = await post('/admin/news_copy', { id: '5' }, env, cookie);
  assert.ok(copied.headers.get('location').includes(encodeURIComponent('新ID: 42')));
  const insert = findCall(state, /INSERT INTO news/i);
  assert.ok(String(insert.args[0]).endsWith(' (副本)'));
  assert.ok(insert.sql.includes("'pending'"), '副本一律待审核');
});

test('笔记回收站: 恢复与彻底删除(级联清子表)', async () => {
  const { env, state } = makeAdminEnv({
    db: (sql, args, kind) => (kind === 'first' && /SELECT title FROM news/i.test(sql) ? { title: '老笔记' } : undefined)
  });
  const cookie = await loginCookie(env);
  const restored = await post('/admin/news_restore', { id: '5' }, env, cookie);
  assert.ok(restored.headers.get('location').includes(encodeURIComponent('已恢复')));
  assert.ok(findCall(state, /UPDATE news SET deleted_at=NULL/i));

  const purged = await post('/admin/news_purge', { id: '5' }, env, cookie);
  assert.ok(purged.headers.get('location').includes(encodeURIComponent('已彻底删除')));
  assert.ok(findCall(state, /DELETE FROM news_likes WHERE news_id IN/i), '级联清子表');
  assert.ok(findCall(state, /DELETE FROM news WHERE id IN/i));
});

test('上传: 内容嗅探拦掉伪装的图片, 通过后写 R2 并回相对地址', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);

  const fakeForm = new FormData();
  fakeForm.append('purpose', 'cover');
  fakeForm.append('file', new File([new TextEncoder().encode('这不是图片')], 'x.png', { type: 'image/png' }));
  const rejected = await handleAdmin(new Request(`${HOST}/admin/image_upload`, {
    method: 'POST', headers: { cookie }, body: fakeForm
  }), env);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.success, false);
  assert.ok(rejectedBody.message.includes('不是有效图片'));

  const realForm = new FormData();
  realForm.append('purpose', 'cover');
  // PNG 魔数 + 少量填充
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  realForm.append('file', new File([png], 'cover.png', { type: 'image/png' }));
  const okRes = await handleAdmin(new Request(`${HOST}/admin/image_upload`, {
    method: 'POST', headers: { cookie }, body: realForm
  }), env);
  const okBody = await okRes.json();
  assert.equal(okBody.success, true);
  assert.match(okBody.url, /^image\/cover_\d+\.png$/, '图片素材落 image/ 目录');
  assert.equal(state.puts.length, 1);
});

test('上传: 视频素材落 video/ 目录, 图片目录不混进视频', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const form = new FormData();
  form.append('purpose', 'video');
  // ISO-BMFF: ftyp 品牌
  const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  form.append('file', new File([mp4], 'video_x.mp4', { type: 'video/mp4' }));
  const body = await (await handleAdmin(new Request(`${HOST}/admin/image_upload`, {
    method: 'POST', headers: { cookie }, body: form
  }), env)).json();
  assert.equal(body.success, true);
  assert.match(body.url, /^video\/video_\d+\.mp4$/, '视频素材落 video/ 目录');
  assert.deepEqual(state.puts, [body.url]);
});

test('素材库: 新目录与历史目录一起列, 缩略图/头像/异类都不混进来', async () => {
  const { env } = makeAdminEnv({
    mediaObjects: [
      { key: 'image/new.png', size: 30, uploaded: '2026-10-05T00:00:00Z' },
      { key: 'news_uploads/a.png', size: 10, uploaded: '2026-10-01T00:00:00Z' },
      { key: 'video/new.mp4', size: 40, uploaded: '2026-10-05T00:00:00Z' },
      { key: 'news_uploads/moto.mp4', size: 20, uploaded: '2026-10-02T00:00:00Z' },
      { key: 'news_uploads/_thumb/480/a.webp', size: 5, uploaded: '2026-10-01T00:00:00Z' },
      { key: 'avatar/avatar_7_1.png', size: 7, uploaded: '2026-10-03T00:00:00Z' }
    ]
  });
  const cookie = await loginCookie(env);
  const images = await (await get('/admin/media_library?kind=image', env, cookie)).json();
  assert.equal(images.success, true);
  assert.deepEqual(images.items.map((item) => item.name), ['new.png', 'a.png'],
    '新目录在前(按时间倒序)、缩略图不算素材、视频不混进图片、头像不参与素材库');
  // 前端靠这两个字段画缩略图与目录徽章, 缺了会"列表里没有图"
  assert.deepEqual(images.items.map((item) => item.kind), ['image', 'image']);
  assert.deepEqual(images.items.map((item) => item.dir), ['image', 'news_uploads']);
  assert.ok(images.accept.includes('png'));

  const videos = await (await get('/admin/media_videos', env, cookie)).json();
  assert.deepEqual(videos.items.map((item) => item.name), ['new.mp4', 'moto.mp4']);
  assert.deepEqual(videos.items.map((item) => item.dir), ['video', 'news_uploads']);
});

test('删除确认页: 用户 kind 摊开级联影响面', async () => {
  const { env } = makeAdminEnv({
    db: (sql, args, kind) => (kind === 'all' && /FROM news WHERE user_id=\?/i.test(sql)
      ? [{ label: '发布的笔记', c: 3 }, { label: '点赞记录', c: 5 }] : undefined)
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/delete_confirm?kind=user&id=7', env, cookie)).text();
  assert.ok(html.includes('用户 #7'));
  assert.ok(html.includes('发布的笔记'));
  assert.ok(html.includes('8 条关联数据'), '3 + 5 合计');
  assert.ok(html.includes('name="delete_user" value="1"'));
  assert.ok(html.includes('name="user_id" value="7"'));
});
