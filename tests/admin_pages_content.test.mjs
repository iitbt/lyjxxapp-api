// 内容管理端到端自检: 公告 / 分类(含迁移) / 首页板块 / 首页精选 / 通用删除确认页
import assert from 'node:assert/strict';
import test from 'node:test';

import { findCall, get, loginCookie, makeAdminEnv, post } from './admin_stub.mjs';

const NOTICE = {
  id: 8, title: '系统维护通知', content: '<p>今晚维护</p>', level: 'important',
  link_type: 'page', link_value: '/pages/notice/notice?id=1', start_at: '2026-10-01 00:00:00',
  end_at: '2026-10-31 00:00:00', sort_order: 3, status: 1
};
const CATEGORY_ROWS = [
  { id: 1, category_key: 'outdoor', name: '户外', sort_order: 10, status: 1, news_count: 12, home_ref_count: 1 },
  { id: 2, category_key: 'food', name: '聚餐', sort_order: 20, status: 0, news_count: 3, home_ref_count: 0 }
];
const HOME_ROWS = [
  { id: 5, section_key: 'main', item_id: 'outdoor', name: '户外', image_url: 'news_uploads/home/hw.jpg', sort_order: 1, status: 1 }
];

test('公告列表: 关键词与状态筛选进 SQL, 行里给类型徽章与生效时间', async () => {
  const { env, state } = makeAdminEnv({
    rows: { app_notices: [NOTICE] }, counts: { app_notices: 1 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/notice_manage?keyword=维护&status=1', env, cookie)).text();
  assert.ok(html.includes('系统维护通知'));
  assert.ok(html.includes('重要'), '类型显示中文');
  assert.ok(html.includes('2026-10-01 00:00 ~ 2026-10-31 00:00'), '生效时间区间');
  const count = findCall(state, /COUNT\(\*\) AS total FROM app_notices/i);
  assert.ok(/title LIKE \?/.test(count.sql) && /status = \?/.test(count.sql), count.sql);
  assert.deepEqual(count.args.slice(0, 2), ['%维护%', 1]);
});

test('公告列表: 停用/未生效/已过期的补充说明', async () => {
  const { env } = makeAdminEnv({
    rows: {
      app_notices: [Object.assign({}, NOTICE, { status: 0 }), Object.assign({}, NOTICE, { id: 9, status: 1, start_at: '2099-01-01 00:00:00' })]
    },
    counts: { app_notices: 2 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/notice_manage', env, cookie)).text();
  assert.ok(html.includes('已停用，小程序不显示'));
  assert.ok(html.includes('未到生效时间'));
});

test('公告编辑: 跳转页面必须以 /pages/ 或 /subpackages/ 开头', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/notice_edit?id=0',
    { title: '公告一', level: 'info', link_value: 'https://example.com/x' }, env, cookie);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('跳转页面必须以 /pages/ 或 /subpackages/ 开头'));
  assert.equal(findCall(state, /INSERT INTO app_notices/i), null);
});

test('公告编辑: 开始时间晚于结束时间被拒', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/notice_edit?id=0',
    { title: '公告二', level: 'info', start_at: '2026-10-10T10:00', end_at: '2026-10-01T10:00' }, env, cookie);
  assert.ok((await res.text()).includes('生效开始时间不能晚于结束时间'));
});

test('公告编辑: 保存成功时 link_type 由跳转地址派生, 时间归一成带秒的格式', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/notice_edit?id=0', {
    title: '公告三', level: 'warning', link_value: '/pages/notice/notice', start_at: '2026-10-10T10:00', status: '1'
  }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('公告已添加')));
  const insert = findCall(state, /INSERT INTO app_notices/i);
  assert.equal(insert.args[3], 'page', 'link_type 派生为 page');
  assert.equal(insert.args[5], '2026-10-10 10:00:00', 'datetime-local 的 T 要归一(否则公告永不生效)');
});

test('分类列表: 显示笔记数与首页引用, 并对未登记分类给黄框', async () => {
  const { env } = makeAdminEnv({
    rows: { app_categories: CATEGORY_ROWS, news: [{ total: 2 }] },
    db: (sql, args, kind) => {
      if (kind === 'first' && /COUNT\(\*\) AS c FROM app_categories/i.test(sql)) return { c: 2 };
      if (kind === 'all' && /FROM app_categories c/i.test(sql)) return CATEGORY_ROWS;
      if (kind === 'all' && /GROUP BY category/i.test(sql)) return [{ category: 'legacy_x', total: 2 }, { category: '', total: 1 }];
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_category_manage', env, cookie)).text();
  assert.ok(html.includes('户外'));
  assert.ok(html.includes('>12<'), '显示笔记数');
  assert.ok(html.includes('发现 2 个未登记的分类'));
  assert.ok(html.includes('legacy_x') && html.includes('（空值）'));
});

test('分类编辑: 标识格式与占用都要拦下', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const bad = await post('/admin/app_category_edit?id=0', { category_key: 'Outdoor!', name: '户外' }, env, cookie);
  assert.ok((await bad.text()).includes('分类标识只能用小写字母开头'));
  const missing = await post('/admin/app_category_edit?id=0', { category_key: 'outdoor', name: '' }, env, cookie);
  assert.ok((await missing.text()).includes('请填写必填项: 名称'));
  assert.equal(findCall(state, /INSERT INTO app_categories/i), null);
});

test('分类编辑: 改标识但没勾迁移时给出提醒文案', async () => {
  const { env, state } = makeAdminEnv({ rows: { app_categories: CATEGORY_ROWS } });
  const cookie = await loginCookie(env);
  const res = await post('/admin/app_category_edit?id=1', { category_key: 'outdoor2', name: '户外' }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('旧标识「outdoor」下的笔记未迁移')));
  assert.ok(findCall(state, /UPDATE app_home_sections SET item_id/i), '改标识必须同步首页板块引用');
});

test('分类删除确认页: 摊开影响面并给迁移下拉', async () => {
  const { env } = makeAdminEnv({
    db: (sql, args, kind) => {
      if (kind === 'first' && /FROM app_categories WHERE id = \?/i.test(sql)) return CATEGORY_ROWS[0];
      if (kind === 'first' && /COUNT\(\*\) AS c FROM news/i.test(sql)) return { c: 12 };
      if (kind === 'first' && /COUNT\(\*\) AS c FROM app_home_sections/i.test(sql)) return { c: 1 };
      if (kind === 'all' && /FROM app_categories WHERE status=1/i.test(sql)) return [CATEGORY_ROWS[1]];
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_category_delete_confirm?id=1', env, cookie)).text();
  assert.ok(html.includes('即将删除分类「户外」'));
  assert.ok(html.includes('不迁移（笔记变成未归类）'));
  assert.ok(html.includes('聚餐（food）'));
  assert.ok(html.includes('引用该分类的首页入口'));
});

test('分类删除: 勾了迁移就回"已迁移"文案并改笔记归属', async () => {
  const { env, state } = makeAdminEnv({
    db: (sql, args, kind) => {
      if (kind === 'first' && /FROM app_categories WHERE id = \?/i.test(sql)) return CATEGORY_ROWS[0];
      if (kind === 'first' && /FROM app_categories WHERE category_key=\?/i.test(sql)) return CATEGORY_ROWS[1];
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const res = await post('/admin/app_category_delete', { id: '1', move_to: 'food' }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('已迁移到「food」')));
  const move = findCall(state, /UPDATE news SET category=\?/i);
  assert.deepEqual(move.args, ['food', 'outdoor']);
});

test('首页板块列表: 板块与分类都显示中文名', async () => {
  const { env } = makeAdminEnv({
    rows: { app_home_sections: HOME_ROWS, app_categories: CATEGORY_ROWS }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_home_manage', env, cookie)).text();
  assert.ok(html.includes('主题项目'), 'section_key=main 要显示中文');
  assert.ok(html.includes('户外'), '分类名实时取自分类表');
  assert.ok(html.includes('https://media.test/news_uploads/home/hw.jpg'));
});

test('首页板块编辑: 分类必须是启用中的分类', async () => {
  const { env, state } = makeAdminEnv({
    db: (sql, args, kind) => {
      if (kind === 'all' && /category_key FROM app_categories WHERE status=1/i.test(sql)) return [{ category_key: 'outdoor' }];
      if (kind === 'all' && /category_key, name(, status)? FROM app_categories/i.test(sql)) return CATEGORY_ROWS;
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const res = await post('/admin/app_home_edit?id=0',
    { section_key: 'main', item_id: 'food', image_url: 'news_uploads/x.png' }, env, cookie);
  const html = await res.text();
  assert.ok(html.includes('请选择有效的分类（须为「分类管理」中已启用的分类）'));
  assert.equal(findCall(state, /INSERT INTO app_home_sections/i), null);
});

test('首页精选编辑: 标识格式与必填项按旧站文案拦住', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const bad = await post('/admin/app_featured_edit?id=0', { item_key: 'Bad-Key' }, env, cookie);
  assert.ok((await bad.text()).includes('标识格式不正确: 小写字母开头'));
  const noImage = await post('/admin/app_featured_edit?id=0',
    { item_key: 'outdoor_sale', name: '户外精选', page_path: '/pages/x' }, env, cookie);
  assert.ok((await noImage.text()).includes('请填写必填项: 图片地址'));
});

test('通用删除确认页: kind 非法时回控制面板并带错误', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await get('/admin/delete_confirm?kind=not_exist&id=1', env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').startsWith('/admin/dashboard?error='));
});

test('通用删除确认页: 只删配置记录的提示与隐藏字段', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/delete_confirm?kind=banner&id=7&page=2', env, cookie)).text();
  assert.ok(html.includes('此操作不可恢复'));
  assert.ok(html.includes('确认彻底删除'));
  assert.ok(html.includes('name="id" value="7"'));
  assert.ok(html.includes('name="page" value="2"'));
  assert.ok(html.includes('素材保留策略'));
});
