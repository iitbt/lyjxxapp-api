// 版本号在后台的落地: 唯一来源是 main.js 的 API_VERSION, 由入口注入 handleAdmin(不注入就会显示成裸 "v")
// 这组用例刻意走 **main.js 的 fetch**(不是直接调 handleAdmin), 否则"入口忘了传参"这类问题测不出来。
import assert from 'node:assert/strict';
import test from 'node:test';

import { API_VERSION } from '../main.js';
import { adminLayout } from '../app/admin/lib/layout.js';
import { loginCookie, makeAdminEnv } from './admin_stub.mjs';
import { request } from './stub.mjs';

test('后台侧栏显示完整版本号(main.js 注入 API_VERSION)', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await request('/admin/dashboard', { env, headers: { cookie } });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes(`<span class="ver">v${API_VERSION}</span>`), '侧栏应显示 v2.1.2 这种完整版本号');
  assert.ok(!/>v</.test(html), '绝不能只渲染一个裸 "v"');
  // 静态资源的 ?v= 缓存键与侧栏同源
  assert.ok(html.includes(`admin.css?v=${API_VERSION}`));
});

test('版本号确实为空时宁可不渲染, 也不留下裸 "v"', () => {
  const html = adminLayout({ title: '控制面板', admin: 'admin' });
  assert.ok(!html.includes('<span class="ver">'));
  assert.ok(!/>v</.test(html));
});
