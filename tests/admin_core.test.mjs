// 后台核心三件套自检: 实体注册表(写路径归类 + 写入口自检)、工具函数(分页/回跳)、受控表 CRUD 工厂
import assert from 'node:assert/strict';
import test from 'node:test';

import { auditAdminWriteRoutes, classifyWritePath } from '../app/admin/lib/entities.js';
import { buildListUrl, clampPage, firstScreenLimit, idemKey, isDuplicateSubmit } from '../app/admin/lib/utils.js';
import { col, runEdit, spec } from '../app/admin/lib/controlled.js';

test('写路径归类: 按路径边界匹配, 不误伤同前缀的其它路径', () => {
  assert.equal(classifyWritePath('/admin/users'), 'super');
  assert.equal(classifyWritePath('/admin/users_xxx'), 'unregistered', '/admin/users 不能误伤它');
  assert.equal(classifyWritePath('/admin/db_manage/exec'), 'super', '多命中时取最长的那条');
  assert.equal(classifyWritePath('/admin/banner_edit'), 'normal');
  assert.equal(classifyWritePath('/admin/admin_users'), 'route_super');
  assert.equal(classifyWritePath('/admin/login'), 'exempt');
  assert.equal(classifyWritePath('/admin'), 'exempt');
  assert.equal(classifyWritePath('/news/list'), 'unregistered');
});

test('写入口自检: 只有写方法参与, 未登记的被点名', () => {
  const result = auditAdminWriteRoutes([
    ['GET', '/admin/dashboard'],
    ['POST', '/admin/banner_edit'],
    ['POST', '/admin/brand_new_thing']
  ]);
  assert.equal(result.checked, 2, 'GET 不算写入口');
  assert.deepEqual(result.unregistered, ['/admin/brand_new_thing']);
});

test('分页口径: 首屏最多 3 页, 页码有硬上界', () => {
  assert.deepEqual(firstScreenLimit('2', 10, 50), [2, 20]);
  assert.deepEqual(firstScreenLimit('9', 10, 50), [3, 30], '更深的页码交给触底加载');
  assert.deepEqual(firstScreenLimit('x', 10, 5), [1, 10]);
  assert.equal(clampPage('99999'), 1000);
});

test('回列表 URL: 保留筛选与页码, 忽略空值与 all', () => {
  const url = buildListUrl('/admin/banner_manage', {
    message: '已更新',
    filters: { position: 'news', status: 'all', q: '' },
    page: 2
  });
  assert.ok(url.startsWith('/admin/banner_manage?message='));
  assert.ok(url.includes('position=news'));
  assert.ok(!url.includes('status='), 'all 表示不筛选, 不该出现在 URL 里');
  assert.ok(!url.includes('q='));
  assert.ok(url.endsWith('&page=2'));
});

test('幂等键: 同一动作同一参数得到同一个键', () => {
  assert.equal(idemKey('banner_delete', 7, 3), 'banner_delete:7:3');
  assert.notEqual(idemKey('banner_delete', 7, 3), idemKey('banner_delete', 7, 4));
});

function makeFactoryEnv(rows) {
  // 只桩"工厂会用到的那几条": first 取原行 / run 记录 SQL 与参数
  const captured = [];
  const env = {
    DB: {
      prepare(sql) {
        const api = {
          sql,
          args: [],
          bind(...args) { api.args = args; return api; },
          async first() { return rows[sql.includes('WHERE id =') ? 'byId' : 'other'] || null; },
          async all() { return { results: [] }; },
          async run() {
            captured.push({ sql, args: api.args });
            return { meta: { changes: 1, last_row_id: 9 } };
          }
        };
        return api;
      },
      async batch() { return []; }
    }
  };
  return { env, captured };
}

test('受控表工厂: enum01 的 "0" 必须存成 0(不能当布尔真值)', async () => {
  const { env, captured } = makeFactoryEnv({ byId: { id: 3, menu_key: 'likes', need_login: 1 } });
  const specDef = spec({
    key: 'menu',
    table: 'app_menu_items',
    title: '我的页菜单',
    currentPage: 'app_menu_manage',
    listUrl: '/admin/app_menu_manage',
    rowLabel: '菜单项',
    fields: [col('menu_key'), col('need_login', { kind: 'enum01', default: 1 })],
    renderEdit: () => '<form></form>'
  });
  const res = await runEdit(specDef, {
    env,
    method: 'POST',
    query: { id: '3' },
    form: { menu_key: 'likes', need_login: '0' },
    session: { id: 1, username: 'admin' }
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/app_menu_manage?message=' + encodeURIComponent('已更新'));
  const update = captured.find((item) => /UPDATE app_menu_items/i.test(item.sql));
  assert.ok(update, '应发出 UPDATE');
  assert.equal(update.args[1], 0, 'need_login 必须存 0');
});

test('受控表工厂: 校验失败时回填输入且不落库', async () => {
  const { env, captured } = makeFactoryEnv({ byId: { id: 3, menu_key: 'likes' } });
  let rendered = null;
  const specDef = spec({
    key: 'menu',
    table: 'app_menu_items',
    title: '我的页菜单',
    currentPage: 'app_menu_manage',
    listUrl: '/admin/app_menu_manage',
    rowLabel: '菜单项',
    fields: [col('menu_key')],
    validate: () => ({ error: '请填写必填项: 标识', errorField: 'menu_key' }),
    renderEdit: (view) => { rendered = view; return '<form></form>'; }
  });
  const res = await runEdit(specDef, {
    env,
    method: 'POST',
    query: { id: '3' },
    form: { menu_key: '' },
    session: { id: 1, username: 'admin' }
  });
  assert.equal(res, '<form></form>');
  assert.equal(captured.length, 0, '校验不过就不该写库');
  assert.equal(rendered.error, '请填写必填项: 标识');
  assert.equal(rendered.errorField, 'menu_key');
  assert.equal(rendered.item.menu_key, '', '回填用户输入');
});

test('受控表工厂: 找不到记录时渲染 not_found 而不是抛错', async () => {
  const { env } = makeFactoryEnv({ byId: null });
  let rendered = null;
  const specDef = spec({
    key: 'menu',
    table: 'app_menu_items',
    title: '我的页菜单',
    currentPage: 'app_menu_manage',
    listUrl: '/admin/app_menu_manage',
    rowLabel: '菜单项',
    fields: [col('menu_key')],
    renderEdit: (view) => { rendered = view; return '<form></form>'; }
  });
  await runEdit(specDef, { env, method: 'GET', query: { id: '404' }, form: {}, session: { id: 1 } });
  assert.equal(rendered.error, '找不到该记录');
});

test('幂等防重: 计数表不可用时放行(不误挡正常操作)', async () => {
  const env = { DB: { prepare() { throw new Error('d1 down'); } } };
  assert.equal(await isDuplicateSubmit(env, 'x', 10), false);
});
