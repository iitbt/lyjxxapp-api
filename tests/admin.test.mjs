// 管理后台自检: 前缀分发、登录/登出、会话守卫、静态样式白名单、控制面板
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAdmin } from '../app/admin/index.js';
import { hashPassword } from '../app/admin/lib/password.js';
import { FAVICON_LINK } from '../app/core/html.js';
import { API_VERSION } from '../main.js';

const HOST = 'https://admin.test';
const SECRET = 'test-session-secret';
const PASSWORD = 'password-12345';
const HASH = await hashPassword(PASSWORD);

// 桩 D1: 按 SQL 关键字回行; 只覆盖后台用得到的那几条语句
function makeEnv(options = {}) {
  const adminCount = options.adminCount === undefined ? 1 : options.adminCount;
  const counters = new Map();
  const statements = [];
  const row = { id: 1, username: 'admin', nickname: '管理员', password: HASH, role: 'super' };
  const env = {
    ADMIN_SESSION_SECRET: SECRET,
    DB: {
      prepare(sql) {
        const api = {
          sql,
          args: [],
          bind(...args) { api.args = args; return api; },
          async first() {
            if (/COUNT\(\*\) AS c FROM admin_users/i.test(sql)) return { c: adminCount };
            if (/COUNT\(\*\) AS c FROM news/i.test(sql)) return { c: 69 };
            if (/COUNT\(\*\) AS c FROM users/i.test(sql)) return { c: 4 };
            if (/COUNT\(\*\) AS c FROM news_comments/i.test(sql)) return { c: 1 };
            if (/COUNT\(\*\) AS c FROM app_notices/i.test(sql)) return { c: 2 };
            if (/FROM admin_users WHERE username=/i.test(sql)) {
              return api.args[0] === row.username ? row : null;
            }
            if (/FROM rate_limit_counters/i.test(sql)) {
              const key = api.args.join('|');
              return counters.has(key) ? { count: counters.get(key) } : null;
            }
            return null;
          },
          async all() { return { results: [] }; },
          async run() { return { meta: { changes: 1 } }; }
        };
        return api;
      },
      // batch 要真的把限流计数落进 map, 否则"连续输错口令会被锁定"是假绿
      async batch(list) {
        statements.push(list.length);
        list.forEach((item) => {
          const sql = String((item && item.sql) || '');
          const args = (item && item.args) || [];
          if (/INSERT INTO rate_limit_counters/i.test(sql)) {
            const key = args.slice(0, 3).join('|');
            counters.set(key, (counters.get(key) || 0) + 1);
          } else if (/DELETE FROM rate_limit_counters/i.test(sql)) {
            const prefix = `${args[0]}|${args[1]}|`;
            for (const key of [...counters.keys()]) {
              if (key.startsWith(prefix)) counters.delete(key);
            }
          }
        });
        return list.map((item, index) => ({ results: [{ c: [69, 4, 1, 2][index] || 1 }], meta: { changes: 1 } }));
      }
    }
  };
  if (options.noSecret) delete env.ADMIN_SESSION_SECRET;
  return { env, counters, statements };
}

function call(path, { env, method = 'GET', body, headers = {}, origin } = {}) {
  const init = { method, headers: Object.assign({}, headers) };
  if (origin !== null) init.headers.origin = origin === undefined ? HOST : origin;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(body).toString();
  }
  // 与线上一致: 版本号由入口注入(唯一来源 main.js 的 API_VERSION)
  return handleAdmin(new Request(`${HOST}${path}`, init), env, { version: API_VERSION });
}

function cookieOf(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function login(env) {
  const res = await call('/admin/login', { env, method: 'POST', body: { username: 'admin', password: PASSWORD } });
  return cookieOf(res);
}

test('后台: 未登录访问任意页面都跳登录页', async () => {
  const { env } = makeEnv();
  const res = await call('/admin/dashboard', { env });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/admin\/login\?next=/);
});

test('后台: 登录页与旧站 login.html 同形(字段名/卡片/文案/版本号/图标)', async () => {
  const { env } = makeEnv();
  const res = await call('/admin/login', { env });
  assert.equal(res.status, 200);
  const html = await res.text();
  // 字段名与旧站一致; 首版的 username/password 后端仍接受(见"登录兼容"那条用例)
  assert.ok(html.includes('name="admin_username"'), '用户名应为 admin_username');
  assert.ok(html.includes('name="admin_password"'), '口令应为 admin_password');
  assert.ok(html.includes('type="password"'));
  assert.ok(html.includes('class="card login-card shadow"'), '布局应是旧站那张卡片');
  assert.ok(html.includes('请输入管理员账号') && html.includes('请输入密码'), '占位文案与旧站一致');
  assert.ok(html.includes('登 录'), '按钮文案与旧站一致');
  assert.ok(html.includes('忘记密码请联系超级管理员重置'), '页脚提示与旧站一致');
  assert.ok(html.includes('狼牙极限运动笔记'), '品牌名取 site_name');
  assert.ok(html.includes(`系统版本 v${API_VERSION}`), '登录页版本号与后台同源');
  assert.ok(html.includes(FAVICON_LINK), '登录页也要带站点图标(与其他页同一份定义)');
});

test('后台: 口令正确则下发会话 Cookie 并跳控制面板', async () => {
  const { env } = makeEnv();
  const res = await call('/admin/login', { env, method: 'POST', body: { username: 'admin', password: PASSWORD } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/dashboard');
  const cookie = cookieOf(res);
  assert.match(cookie, /^admin_session=/);
  assert.match(String(res.headers.get('set-cookie')), /HttpOnly/);
});

test('后台: 口令错误不区分账号存在与否, 也不下发 Cookie', async () => {
  const { env } = makeEnv();
  const res = await call('/admin/login', { env, method: 'POST', body: { username: 'admin', password: 'wrong-password' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  // 文案与旧站 auth.py 逐字一致("错误", 不是"不正确")
  assert.ok((await res.text()).includes('用户名或密码错误'));
});

test('后台: 缺少同源 Origin 的 POST 直接 403', async () => {
  const { env } = makeEnv();
  const res = await call('/admin/login', { env, method: 'POST', origin: null, body: { username: 'admin', password: PASSWORD } });
  assert.equal(res.status, 403);
});

test('后台: 跨站 Origin 的 POST 也是 403', async () => {
  const { env } = makeEnv();
  const res = await call('/admin/login', { env, method: 'POST', origin: 'https://evil.test', body: { username: 'admin', password: PASSWORD } });
  assert.equal(res.status, 403);
});

test('后台: 带合法会话能看到控制面板与菜单', async () => {
  const { env } = makeEnv();
  const cookie = await login(env);
  const res = await call('/admin/dashboard', { env, headers: { cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('nav-group'));
  // 控制面板已换成旧站那套 13 张卡(数字由聚合 SQL 提供, 结构断言不依赖桩数据)
  assert.ok(html.includes('总用户数'), '应有统计卡');
  assert.ok(html.includes('管理页面'), '应有迁移进度卡');
  assert.ok(html.includes('admin'), '应显示登录用户名');
});

test('后台: 会话 Cookie 被改一个字符即失效', async () => {
  const { env } = makeEnv();
  const cookie = await login(env);
  // 改签名段的**第一个**字符: base64url 的末位可能是填充位, 改它有时解码结果不变 → 用例会偶发假通过
  const tampered = cookie.replace(/\.(.)/, (whole, first) => '.' + (first === 'A' ? 'B' : 'A'));
  const res = await call('/admin/dashboard', { env, headers: { cookie: tampered } });
  assert.equal(res.status, 302);
});

test('后台: 登出清 Cookie 并回登录页', async () => {
  const { env } = makeEnv();
  const res = await call('/admin/logout', { env, method: 'POST' });
  assert.equal(res.status, 302);
  // 与旧站一致: 登出后回登录页并带"已退出登录"提示(页面不再是空白)
  assert.equal(res.headers.get('location'),
    `/admin/login?message=${encodeURIComponent('已退出登录')}`);
  assert.match(String(res.headers.get('set-cookie')), /Max-Age=0/);
});

test('后台: 登录支持回跳原页面, 且拒绝站外地址', async () => {
  const { env } = makeEnv();
  const back = await call('/admin/login', {
    env, method: 'POST', body: { admin_username: 'admin', admin_password: PASSWORD, redirect: '/admin/users?page=2' }
  });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/admin/users?page=2');

  // 开放重定向防护: 站外地址一律回控制面板(与旧站 auth.py 同口径)
  for (const bad of ['//evil.example.com', 'https://evil.example.com', '/news/list']) {
    const res = await call('/admin/login', {
      env, method: 'POST', body: { admin_username: 'admin', admin_password: PASSWORD, redirect: bad }
    });
    assert.equal(res.headers.get('location'), '/admin/dashboard', `${bad} 不该被当成回跳目标`);
  }
});

test('后台: 登录字段名兼容(首版 username/password 仍可登录)', async () => {
  const { env } = makeEnv();
  const res = await call('/admin/login', { env, method: 'POST', body: { username: 'admin', password: PASSWORD } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/dashboard');
});

test('后台: 登录失败页回显 redirect, 登录后能回到原页面', async () => {
  const { env } = makeEnv();
  const failed = await call('/admin/login', {
    env, method: 'POST', body: { admin_username: 'admin', admin_password: 'wrong', redirect: '/admin/news_manage' }
  });
  const html = await failed.text();
  assert.ok(html.includes('name="redirect" value="/admin/news_manage"'), '失败后要保留原地址');
  assert.ok(html.includes('用户名或密码错误'));
});

test('后台: 表为空时能初始化首个管理员, 表非空则拒绝', async () => {
  const empty = makeEnv({ adminCount: 0 });
  const page = await call('/admin/bootstrap', { env: empty.env });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('初始化'));

  const created = await call('/admin/bootstrap', {
    env: empty.env, method: 'POST', body: { username: 'admin', nickname: '管理员', password: 'a-long-password' }
  });
  assert.equal(created.status, 302);
  assert.match(created.headers.get('location'), /^\/admin\/login\?message=/);

  const notEmpty = makeEnv({ adminCount: 1 });
  const rejected = await call('/admin/bootstrap', {
    env: notEmpty.env, method: 'POST', body: { username: 'x', password: 'a-long-password' }
  });
  assert.equal(rejected.status, 403);
});

test('后台: 没配 ADMIN_SESSION_SECRET 时登录页提示未就绪', async () => {
  const { env } = makeEnv({ noSecret: true });
  const res = await call('/admin/login', { env });
  assert.ok((await res.text()).includes('ADMIN_SESSION_SECRET'));
});

test('后台: 静态样式走白名单, 未知 key 404, 且无需登录', async () => {
  const { env } = makeEnv();
  const ok = await call('/admin/static/css/admin.css', { env });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/css/);
  assert.ok((await ok.text()).length > 100);

  const missing = await call('/admin/static/nope.css', { env });
  assert.equal(missing.status, 404);
});

test('后台: 不在菜单里的路径给 404(后台已全量迁移, 没有"待迁"入口了)', async () => {
  const { env } = makeEnv();
  const cookie = await login(env);
  const missing = await call('/admin/not_exist', { env, headers: { cookie } });
  assert.equal(missing.status, 404);
  assert.ok((await missing.text()).includes('后台里没有这个地址'));
});

test('后台: 统计数据读不出来时页面仍可打开并明确提示', async () => {
  const { env } = makeEnv();
  // 先登录(此时 D1 正常), 再让 D1 挂掉 —— 否则登录本身就会失败
  const cookie = await login(env);
  env.DB.prepare = () => { throw new Error('d1 down'); };
  const res = await call('/admin/dashboard', { env, headers: { cookie } });
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('统计数据加载失败'));
});

test('后台: 连续输错口令达到上限后锁定', async () => {
  const { env, counters } = makeEnv();
  for (let index = 0; index < 10; index += 1) {
    await call('/admin/login', { env, method: 'POST', body: { username: 'admin', password: 'bad-password' } });
  }
  const res = await call('/admin/login', { env, method: 'POST', body: { username: 'admin', password: PASSWORD } });
  assert.equal(res.status, 200, '被锁定时不再校验口令, 仍是登录页');
  assert.ok((await res.text()).includes('尝试次数过多'));
  assert.ok(counters.size > 0);
});
