// 后台外壳自检: 写请求权限守卫、统一状态切换、页面宏(partials)
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAdmin } from '../app/admin/index.js';
import { FAVICON_LINK } from '../app/core/html.js';
import { ENTITIES } from '../app/admin/lib/entities.js';
import { hashPassword } from '../app/admin/lib/password.js';
import { listMeta, listShell } from '../app/admin/lib/partials.js';
import { STATUS_KINDS, auditStatusKinds } from '../app/admin/lib/status.js';

const HOST = 'https://admin.test';
const PASSWORD = 'password-12345';
const HASH = await hashPassword(PASSWORD);

function makeEnv(options = {}) {
  const state = { role: options.role || 'super', statusChanges: options.statusChanges === undefined ? 1 : options.statusChanges };
  const row = { id: 1, username: 'admin', password: HASH, role: state.role };
  const updates = [];
  const env = {
    ADMIN_SESSION_SECRET: 'test-secret',
    DB: {
      prepare(sql) {
        const api = {
          sql,
          args: [],
          bind(...args) { api.args = args; return api; },
          async first() {
            if (/COUNT\(\*\) AS c FROM admin_users/i.test(sql)) return { c: 1 };
            if (/FROM admin_users WHERE username=/i.test(sql)) return row;
            return null;
          },
          async all() { return { results: [] }; },
          async run() {
            updates.push({ sql, args: api.args });
            if (/UPDATE banner_images/i.test(sql)) return { meta: { changes: state.statusChanges } };
            return { meta: { changes: 1 } };
          }
        };
        return api;
      },
      async batch() { return []; }
    }
  };
  return { env, state, updates };
}

async function post(path, body, env, cookie) {
  const headers = { origin: HOST, 'content-type': 'application/x-www-form-urlencoded' };
  if (cookie) headers.cookie = cookie;
  return handleAdmin(new Request(`${HOST}${path}`, {
    method: 'POST', headers, body: new URLSearchParams(body).toString()
  }), env);
}

async function loginCookie(env) {
  const res = await post('/admin/login', { username: 'admin', password: PASSWORD }, env);
  return String(res.headers.get('set-cookie') || '').split(';')[0];
}

test('状态注册表与实体注册表必须双向对齐', () => {
  assert.deepEqual(auditStatusKinds(), []);
  for (const [key, kind] of Object.entries(STATUS_KINDS)) {
    assert.ok(ENTITIES[kind.cacheEntity], `${key} 的 cacheEntity 必须登记在实体注册表里`);
    assert.ok(kind.actions.length > 0, `${key} 至少要有一个可切换的动作`);
    assert.ok(kind.audit.startsWith('admin.'), `${key} 的审计动作名格式不对`);
  }
});

test('统计条: simple 只报总数, 分页形态带已加载与页码', () => {
  assert.match(listMeta({ total: 7, unit: '条', simple: true }), /共 7 条/);
  const full = listMeta({ total: 28, perPage: 10, loadedPage: 2, totalPages: 3, unit: '张', hintId: 'xHint' });
  assert.match(full, /共 28 张/);
  assert.match(full, /已加载 20\/28 张 · 第 2\/3 页/);
});

test('列表骨架: 多页时给触底哨兵, 单页时给"已全部加载"', () => {
  const many = listShell({
    title: '轮播图', columns: ['ID', '操作'], tbodyId: 'bannerTbody', rows: '<tr></tr>',
    sentinelId: 'bannerLoadMore', textId: 'bannerLoadMoreText', total: 28, perPage: 10,
    currentPage: 1, totalPages: 3, unit: '张', hintId: 'bannerLoadedHint',
    backTopId: 'b', jumpBtnId: 'j', jumpInputId: 'i'
  });
  assert.ok(many.includes('id="bannerLoadMore"'));
  assert.ok(many.includes('滚动到底自动加载更多'));
  assert.ok(many.includes('id="bannerTbody"'));
  assert.ok(many.includes('/ 3 页'));

  const single = listShell({
    title: '轮播图', columns: ['ID'], tbodyId: 't', rows: '', sentinelId: 's', textId: 'x',
    total: 4, perPage: 10, currentPage: 1, totalPages: 1, unit: '张', hintId: 'h',
    backTopId: 'b', jumpBtnId: 'j', jumpInputId: 'i'
  });
  assert.ok(single.includes('已全部加载 4 张'));
});

test('写路径守卫: 普通管理员碰超管专属写入口被拒(403)', async () => {
  const { env } = makeEnv({ role: 'normal' });
  const cookie = await loginCookie(env);
  const res = await post('/admin/banner_delete', { id: '1' }, env, cookie);
  assert.equal(res.status, 403);
  assert.ok((await res.text()).includes('仅超级管理员可执行'));
});

test('站点图标: 后台各页(含只摊 ctx 的页)都带同一份 <link rel="icon">', async () => {
  const { env } = makeEnv({ role: 'super' });
  const cookie = await loginCookie(env);
  for (const path of ['/admin/dashboard', '/admin/settings', '/admin/system_info', '/admin/news_manage']) {
    const res = await handleAdmin(new Request(`${HOST}${path}`, { headers: { origin: HOST, cookie } }), env);
    assert.ok((await res.text()).includes(FAVICON_LINK), `${path} 缺少站点图标引用`);
  }
});

test('写路径守卫: route_super 页面的写操作也由分发层拦(普通管理员 403)', async () => {
  // 这类页面原本只靠页面自查; 管理员页漏了自查 → 任何登录账号都能增删管理员/重置口令
  const { env } = makeEnv({ role: 'normal' });
  const cookie = await loginCookie(env);
  const res = await post('/admin/admin_users', {
    add_admin: '1', username: 'intruder', password: 'password-1234', confirm_password: 'password-1234'
  }, env, cookie);
  assert.equal(res.status, 403);
  assert.ok((await res.text()).includes('仅超级管理员可执行'));
});

test('权限: 管理员页(含列表)只给超管看, 普通管理员 403', async () => {
  const normal = makeEnv({ role: 'normal' });
  const normalCookie = await loginCookie(normal.env);
  for (const path of ['/admin/admin_users', '/admin/admin_users_rows']) {
    const res = await handleAdmin(new Request(`${HOST}${path}`, { headers: { origin: HOST, cookie: normalCookie } }), normal.env);
    assert.equal(res.status, 403, `${path} 应拒绝普通管理员`);
    assert.ok((await res.text()).includes('仅超级管理员可访问'));
  }

  const superEnv = makeEnv({ role: 'super' });
  const superCookie = await loginCookie(superEnv.env);
  const ok = await handleAdmin(new Request(`${HOST}/admin/admin_users`, { headers: { origin: HOST, cookie: superCookie } }), superEnv.env);
  assert.equal(ok.status, 200);
});

test('数据库工具: JSON 体的 SQL 提交要能被解析(此前控制台永远报"请输入要执行的 SQL")', async () => {
  const { env } = makeEnv({ role: 'super' });
  env.ENABLE_SQL_TOOL = '1';
  const cookie = await loginCookie(env);
  const res = await handleAdmin(new Request(`${HOST}/admin/db_manage/exec`, {
    method: 'POST',
    headers: { origin: HOST, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT id FROM news LIMIT 1', confirm: '' })
  }), env);
  const body = await res.json();
  assert.notEqual(body.msg, '请输入要执行的 SQL', 'JSON 体没被解析时会误判成"没填 SQL"');
});

test('写路径守卫: 没登记权限口径的写入口一律拒绝', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/brand_new_thing', {}, env, cookie);
  assert.equal(res.status, 403);
  assert.ok((await res.text()).includes('没有登记权限口径'));
});

test('统一状态切换: 成功时返回注册表口径的文案与配色', async () => {
  const { env, updates } = makeEnv({ role: 'normal' });
  const cookie = await loginCookie(env);
  const res = await post('/admin/status_update', { kind: 'banner', id: '1', status: '0' }, env, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.status_text, '停用');
  assert.equal(body.badge_class, 'secondary');
  assert.deepEqual(body.actions, ['1'], '停用后应只剩"启用"按钮');
  const update = updates.find((item) => /UPDATE banner_images/i.test(item.sql));
  assert.ok(update, '应发出 UPDATE');
  assert.equal(update.args[0], 0, '轮播图状态列是整数');
});

test('统一状态切换: 超管专属 kind 对普通管理员回 403 且给 forbidden', async () => {
  const { env } = makeEnv({ role: 'normal' });
  const cookie = await loginCookie(env);
  const res = await post('/admin/status_update', { kind: 'comment', id: '5', status: 'approved' }, env, cookie);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.forbidden, true);
});

test('统一状态切换: 影响 0 行必须报错(不能提示"已更新")', async () => {
  const { env } = makeEnv({ statusChanges: 0 });
  const cookie = await loginCookie(env);
  const res = await post('/admin/status_update', { kind: 'banner', id: '999', status: '0' }, env, cookie);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.ok(body.message.includes('未更新任何记录'));
});
