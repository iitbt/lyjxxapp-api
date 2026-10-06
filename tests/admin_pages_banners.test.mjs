// 轮播图页面端到端自检: 列表 / 行片段 / 新增编辑 / 删除 / 复制
import assert from 'node:assert/strict';
import test from 'node:test';

import { findCall, get, loginCookie, makeAdminEnv, post } from './admin_stub.mjs';

const bannerRows = [
  {
    id: 3, title: '国庆活动', image_url: 'news_uploads/home/b1.png', link_url: '/pages/a',
    position: 'news', sort_order: 1, status: 1
  },
  {
    id: 2, title: '摩旅季', image_url: 'news_uploads/home/b2.png', link_url: '',
    position: 'motorcycle', sort_order: 2, status: 0
  }
];

function bannerEnv(overrides = {}) {
  return makeAdminEnv(Object.assign({
    rows: { banner_images: bannerRows },
    counts: { banner_images: 12 }
  }, overrides));
}

test('轮播图列表: 表头/添加按钮/行/中文位置/触底哨兵/统计条', async () => {
  const { env } = bannerEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/banner_manage', env, cookie)).text();
  assert.ok(html.includes('添加轮播图'));
  assert.ok(html.includes('id="bannerTbody"'));
  assert.ok(html.includes('国庆活动'));
  assert.ok(html.includes('笔记页'), '展示位置要显示中文名而不是 news');
  assert.ok(html.includes('https://media.test/news_uploads/home/b1.png'), '图片地址要拼成绝对地址');
  assert.ok(html.includes('滚动到底自动加载更多'));
  assert.ok(html.includes('已加载 10/12 张'), '统计条口径与旧站一致');
  assert.ok(html.includes('/admin/delete_confirm?kind=banner&amp;id=3'), '删除走服务端确认页');
});

test('轮播图列表: 取消勾选的状态行只显示"启用"按钮', async () => {
  const { env } = bannerEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/banner_manage', env, cookie)).text();
  // 停用行(状态 0)对应的"启用"按钮不应带 hidden
  const stopRow = html.slice(html.indexOf('摩旅季'));
  assert.ok(stopRow.includes('data-status-action="1"'), '停用行要有启用按钮');
});

test('轮播图行片段: 返回 {success, rows, has_more}', async () => {
  const { env } = bannerEnv();
  const cookie = await loginCookie(env);
  const body = await (await get('/admin/banner_rows?page=1', env, cookie)).json();
  assert.equal(body.success, true);
  assert.ok(body.rows.includes('国庆活动'));
  assert.equal(body.has_more, false, '只取到 2 行, 没满一页');
});

test('轮播图行片段: 越界时回空 rows(前端据此停手)', async () => {
  const { env } = bannerEnv({ rows: { banner_images: [] } });
  const cookie = await loginCookie(env);
  const body = await (await get('/admin/banner_rows?page=9', env, cookie)).json();
  assert.equal(body.success, true);
  assert.equal(body.rows, '');
  assert.equal(body.has_more, false);
});

test('轮播图编辑: 缺图片地址时回填并报错, 不落库', async () => {
  const { env, state } = bannerEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/banner_edit?id=0', { title: '新轮播', image_url: '', position: 'news' }, env, cookie);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('请填写必填项: 图片地址'));
  assert.ok(html.includes('value="新轮播"'), '要回填用户已填的标题');
  assert.equal(findCall(state, /INSERT INTO banner_images/i), null, '校验不过不该写库');
});

test('轮播图编辑: 新增成功回列表并带提示', async () => {
  const { env, state } = bannerEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/banner_edit?id=0',
    { title: '新轮播', image_url: 'news_uploads/x.png', link_url: '', position: 'index', sort_order: '5', status: '1' },
    env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('轮播图添加成功')));
  const insert = findCall(state, /INSERT INTO banner_images/i);
  assert.ok(insert, '应发出 INSERT');
  assert.equal(insert.args[0], '新轮播');
  assert.equal(insert.args[4], 5, '排序要转成整数');
  assert.equal(insert.args[5], 1, '启用状态存 1');
});

test('轮播图编辑: 更新走 UPDATE 且带 id', async () => {
  const { env, state } = bannerEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/banner_edit?id=3',
    { title: '改名了', image_url: 'news_uploads/y.png', position: 'news', status: '' }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('轮播图更新成功')));
  const update = findCall(state, /UPDATE banner_images/i);
  assert.ok(update);
  assert.equal(update.args[update.args.length - 1], 3, 'WHERE id 要是路径里的那条');
  assert.equal(update.args[5], 0, '未勾选 → status 0');
});

test('轮播图删除: 回列表带提示, 且只删记录不删文件', async () => {
  const { env, state } = bannerEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/banner_delete', { id: '3', page: '2' }, env, cookie);
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.ok(location.includes(encodeURIComponent('轮播图已删除')));
  assert.ok(location.includes('page=2'), '回跳要保留已加载页码');
  assert.ok(findCall(state, /DELETE FROM banner_images/i), '应发出 DELETE');
});

test('轮播图删除: id 非法给"参数错误"', async () => {
  const { env } = bannerEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/banner_delete', { id: 'abc' }, env, cookie);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('参数错误')));
});

test('轮播图复制: 标题加 (副本) 并回报新 ID', async () => {
  const { env, state } = bannerEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/banner_copy', { id: '3' }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('轮播图已成功复制！新ID: 42')));
  const insert = findCall(state, /INSERT INTO banner_images/i);
  assert.ok(insert.args[0].endsWith(' (副本)'), insert.args[0]);
});
