// 配置中心与专题端到端自检: 版本配置 / 运营文案 / 我的页菜单(含补齐) / 专题精选(含预览)
import assert from 'node:assert/strict';
import test from 'node:test';

import { findCall, get, loginCookie, makeAdminEnv, post } from './admin_stub.mjs';

function envWith(overrides = {}) {
  return makeAdminEnv(overrides);
}

test('版本配置: 表里没有这一行时用默认值渲染, 且不写库', async () => {
  const { env, state } = envWith();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_version_edit', env, cookie)).text();
  assert.ok(html.includes('发现新版本，更新后体验更好'), '默认提示语');
  assert.equal(findCall(state, /INSERT INTO app_version_config/i), null, '只是看一眼不该写库');
});

test('版本配置: 格式与 min>latest 都要拦下', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  const bad = await post('/admin/app_version_edit', { latest_version: 'v3.4' }, env, cookie);
  assert.ok((await bad.text()).includes('最新版本格式不正确'));
  const wrong = await post('/admin/app_version_edit', { latest_version: '3.4', min_version: '3.9' }, env, cookie);
  assert.ok((await wrong.text()).includes('最低可用版本不能高于最新版本'));
});

test('版本配置: 首次保存走 INSERT(id=1), 已存在时走 UPDATE', async () => {
  const fresh = envWith();
  const cookie = await loginCookie(fresh.env);
  const created = await post('/admin/app_version_edit', { latest_version: '3.5', min_version: '3.0' }, fresh.env, cookie);
  assert.equal(created.status, 302);
  assert.ok(created.headers.get('location').includes(encodeURIComponent('版本更新配置已保存')));
  const insert = findCall(fresh.state, /INSERT INTO app_version_config/i);
  assert.ok(insert, '首次保存要 INSERT');
  assert.deepEqual(insert.args.slice(0, 2), ['3.5', '3.0']);

  const existing = envWith({ rows: { app_version_config: [{ id: 1, latest_version: '3.4', min_version: '3.0', update_tip: 't', update_content: 'c' }] } });
  const cookie2 = await loginCookie(existing.env);
  await post('/admin/app_version_edit', { latest_version: '3.6' }, existing.env, cookie2);
  assert.ok(findCall(existing.state, /UPDATE app_version_config/i), '已有行要 UPDATE');
});

test('运营文案列表: 分组筛选 + 缺内置文案按全表判断', async () => {
  const { env, state } = envWith({
    rows: { app_texts: [{ id: 1, text_key: 'login.prompt', title: '授权登录提示', content: '需要登录', group_name: '登录授权', sort_order: 1, status: 1 }] },
    counts: { app_texts: 1 },
    db: (sql, args, kind) => {
      if (kind === 'all' && /SELECT text_key FROM app_texts/i.test(sql)) {
        // 全表里有 agreement.content(虽然不在展示行里), 说明它存在
        return [{ text_key: 'login.prompt' }, { text_key: 'agreement.content' }];
      }
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_text_manage?group=登录授权', env, cookie)).text();
  assert.ok(html.includes('授权登录提示'));
  assert.ok(!html.includes('agreement.content'), '全表已有的不该被报成缺失');
  assert.ok(html.includes('share.default_image'), '真正缺的要报出来');
  const count = findCall(state, /COUNT\(\*\) AS c FROM app_texts/i);
  assert.ok(/group_name = \?/.test(count.sql));
  assert.deepEqual(count.args, ['登录授权']);
});

test('运营文案编辑: 标识格式/重复/title 必填都拦得住', async () => {
  const { env, state } = envWith();
  const cookie = await loginCookie(env);
  const bad = await post('/admin/app_text_edit?id=0', { text_key: 'Login.prompt', title: 'x' }, env, cookie);
  assert.ok((await bad.text()).includes('文案标识格式不正确'));
  const noTitle = await post('/admin/app_text_edit?id=0', { text_key: 'login.prompt' }, env, cookie);
  assert.ok((await noTitle.text()).includes('请填写说明(后台列表里显示的那句话)'));
  assert.equal(findCall(state, /INSERT INTO app_texts/i), null);
});

test('运营文案编辑: 正文保留换行(不能 strip)', async () => {
  const { env, state } = envWith();
  const cookie = await loginCookie(env);
  const res = await post('/admin/app_text_edit?id=0',
    { text_key: 'about.content', title: '关于正文', content: '第一行\n第二行\n', group_name: '隐私与关于' }, env, cookie);
  assert.equal(res.status, 302);
  const insert = findCall(state, /INSERT INTO app_texts/i);
  assert.equal(insert.args[2], '第一行\n第二行\n');
});

test('我的页菜单列表: 缺内置项时给补齐按钮与提示', async () => {
  const { env } = envWith({
    rows: {
      app_menu_items: [{
        id: 1, menu_key: 'likes', title: '我的点赞', icon: '/images/like.png', link_type: 'page',
        link_value: '/subpackages/content/like/like', need_login: 1, trusted_only: 0, sort_order: 10, status: 1
      }]
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_menu_manage', env, cookie)).text();
  assert.ok(html.includes('补齐内置菜单项（6）'), '7 条内置里已有 1 条');
  assert.ok(html.includes('我的收藏'), '缺失项要列出来');
  assert.ok(html.includes('/images/like.png'), '包内图标只显示路径不根化');
});

test('我的页菜单编辑: need_login 的 "0" 必须存成 0(不能当布尔真值)', async () => {
  const { env, state } = envWith();
  const cookie = await loginCookie(env);
  const res = await post('/admin/app_menu_edit?id=0', {
    menu_key: 'notices', title: '通知公告', link_type: 'page',
    link_value: '/subpackages/content/notices/notices', need_login: '0'
  }, env, cookie);
  assert.equal(res.status, 302);
  const insert = findCall(state, /INSERT INTO app_menu_items/i);
  assert.equal(insert.args[5], 0, '未登录可见');
});

test('我的页菜单编辑: 页面路径前缀与"注销账号必须登录可见"', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  const badPath = await post('/admin/app_menu_edit?id=0',
    { menu_key: 'xx', title: '外部链接', link_type: 'page', link_value: 'https://example.com' }, env, cookie);
  assert.ok((await badPath.text()).includes('页面路径必须以 /pages/ 或 /subpackages/ 开头'));
  const actionNeedLogin = await post('/admin/app_menu_edit?id=0',
    { menu_key: 'delete_account', title: '注销账号', link_type: 'action', link_value: 'delete_account', need_login: '0' }, env, cookie);
  assert.ok((await actionNeedLogin.text()).includes('必须设为「登录可见」'));
});

test('菜单补齐: 只新增缺的内置项, 已有项不动', async () => {
  const { env, state } = envWith({
    rows: { app_menu_items: [{ menu_key: 'likes' }, { menu_key: 'favorites' }] }
  });
  const cookie = await loginCookie(env);
  const res = await post('/admin/app_menu_restore_missing', {}, env, cookie);
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.ok(location.includes(encodeURIComponent('已补齐 5 条内置菜单项')));
  assert.ok(location.includes(encodeURIComponent('已有 2 条保持不变')));
  const inserts = state.calls.filter((item) => /INSERT INTO app_menu_items/i.test(item.sql));
  assert.equal(inserts.length, 5);
  assert.ok(inserts.every((item) => item.args[0] !== 'likes'));
});

test('专题列表: topic 参数决定表名与列头', async () => {
  const { env } = envWith({
    rows: { outdoor_activities: [{ id: 3, title: '雨崩', description: '徒步', poster: 'p.jpg', videoUrl: '', status: 'approved', date: '2013-11', location: '云南' }] },
    counts: { outdoor_activities: 1 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/topics_manage?topic=outdoor', env, cookie)).text();
  assert.ok(html.includes('活动地点') && html.includes('活动日期'), '户外的额外字段列头');
  assert.ok(html.includes('雨崩'));
  assert.ok(html.includes('户外精选'), 'tab 高亮');
});

test('专题旧地址: 302 到聚合页并带 topic', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  const res = await get('/admin/motorcycle_manage?page=2', env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').startsWith('/admin/topics_manage?'));
  assert.ok(res.headers.get('location').includes('topic=motorcycle'));
  assert.ok(res.headers.get('location').includes('page=2'), '原查询串不丢');
});

test('专题编辑: 必填项合并成一条文案, 状态非法时回落 approved', async () => {
  const { env, state } = envWith();
  const cookie = await loginCookie(env);
  const missing = await post('/admin/motorcycle_edit?id=0', { title: '川藏线' }, env, cookie);
  assert.ok((await missing.text()).includes('请填写必填项: 简介、封面图 URL'));
  const ok = await post('/admin/motorcycle_edit?id=0',
    { title: '川藏线', description: '骑行', poster: 'p.jpg', videoUrl: '', status: 'weird', distance: '2000' }, env, cookie);
  assert.equal(ok.status, 302);
  const insert = findCall(state, /INSERT INTO motorcycle_trips/i);
  assert.equal(insert.args[4], 'approved', '非法状态回落 approved');
  assert.equal(insert.args[5], '2000', '额外字段要一起写入');
});

test('专题预览: 只渲染非空的额外字段', async () => {
  const { env } = envWith({
    db: (sql, args, kind) => {
      if (kind === 'first' && /FROM outdoor_activities WHERE id = \?/i.test(sql)) {
        return { id: 3, title: '雨崩', description: '徒步', poster: 'p.jpg', videoUrl: '', status: 'pending', date: '2013-11', location: '' };
      }
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/outdoor_preview?id=3', env, cookie)).text();
  assert.ok(html.includes('雨崩'));
  assert.ok(html.includes('待审核'), '状态显示中文而不是 pending');
  assert.ok(html.includes('活动日期'));
  assert.ok(!html.includes('活动地点'), '空值行整行不渲染');
});

test('专题预览: 缺 id 给"缺少记录ID"', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/motorcycle_preview', env, cookie)).text();
  assert.ok(html.includes('缺少记录ID'));
});
