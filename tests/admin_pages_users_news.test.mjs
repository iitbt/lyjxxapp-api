// 用户/管理员/用户笔记/留言/笔记/上传 端到端自检
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

test('用户笔记审核: 状态筛选 + JOIN 作者, 审核走统一状态接口', async () => {
  const rows = [Object.assign({}, NEWS_ROW, { type: 'users', status: 'pending', user_id: 7, user_nickname: '老王' })];
  const { env } = makeAdminEnv({
    rows: { news: rows, app_categories: [{ category_key: 'outdoor', name: '户外' }] },
    counts: { news: 1 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/user_news_manage?status=pending', env, cookie)).text();
  assert.ok(html.includes('老王'));
  assert.ok(html.includes('户外'), '分类显示中文名');
  assert.ok(html.includes('待审核'));
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
  assert.ok(html.includes('batchForm'));
  assert.ok(html.includes('回收站'));
  assert.ok(html.includes('设为显示'));
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
  assert.match(okBody.url, /^news_uploads\/cover_\d+\.png$/);
  assert.equal(state.puts.length, 1);
});

test('素材库: 按扩展名分类列举 R2 对象并给可接受格式', async () => {
  const { env } = makeAdminEnv({
    mediaObjects: [
      { key: 'news_uploads/a.png', size: 10, uploaded: '2026-10-01T00:00:00Z' },
      { key: 'news_uploads/moto.mp4', size: 20, uploaded: '2026-10-02T00:00:00Z' },
      { key: 'news_uploads/_thumb/480/a.webp', size: 5, uploaded: '2026-10-01T00:00:00Z' }
    ]
  });
  const cookie = await loginCookie(env);
  const images = await (await get('/admin/media_library?kind=image', env, cookie)).json();
  assert.equal(images.success, true);
  assert.deepEqual(images.items.map((item) => item.name), ['a.png'], '缩略图不算素材、视频不混进图片');
  assert.ok(images.accept.includes('png'));

  const videos = await (await get('/admin/media_videos', env, cookie)).json();
  assert.deepEqual(videos.items.map((item) => item.name), ['moto.mp4']);
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
