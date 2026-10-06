// 后台侧栏菜单自检: 超管专属项必须在**每一页**都稳定出现(漏传超管标识会让它时隐时现)
import assert from 'node:assert/strict';
import test from 'node:test';

import { SUPER_ONLY_WRITE_PATHS } from '../app/admin/lib/entities.js';
import { NAV_GROUPS } from '../app/admin/lib/nav.js';
import { PAGE_ROUTES } from '../app/admin/pages/index.js';
import { statusKind } from '../app/admin/lib/status.js';
import { get, loginCookie, makeAdminEnv } from './admin_stub.mjs';

//: 菜单里声明 superOnly 的三项
const SUPER_ONLY = ['管理员管理', '数据库工具', '素材库管理'];
//: 覆盖两种 adminLayout 调用风格(显式传 isSuper / 只摊 ctx)与错误页、工具页自身
const PAGES = ['/admin/dashboard', '/admin/users', '/admin/settings', '/admin/system_info',
  '/admin/news_manage', '/admin/banner_manage', '/admin/media_manage', '/admin/db_tools',
  '/admin/not_found_page'];

const navLabels = NAV_GROUPS.flatMap((group) => group.items).map((item) => item.title);

test('超管: 每一页的侧栏都带齐三个超管专属菜单', async () => {
  const { env } = makeAdminEnv({ role: 'super' });
  const cookie = await loginCookie(env);
  for (const path of PAGES) {
    const html = await (await get(path, env, cookie)).text();
    for (const label of SUPER_ONLY) {
      assert.ok(html.includes(`<span class="nav-label">${label}`), `${path} 的侧栏缺少「${label}」`);
    }
  }
});

test('非超管: 每一页的侧栏都不出现超管专属菜单', async () => {
  const { env } = makeAdminEnv({ role: 'normal' });
  const cookie = await loginCookie(env);
  for (const path of PAGES) {
    const html = await (await get(path, env, cookie)).text();
    for (const label of SUPER_ONLY) {
      assert.ok(!html.includes(`<span class="nav-label">${label}`), `${path} 不该出现「${label}」`);
    }
  }
});

test('登录名: 只摊 ctx 的页面(控制面板)顶栏也显示当前管理员', async () => {
  const { env } = makeAdminEnv({ role: 'super' });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/dashboard', env, cookie)).text();
  assert.ok(/bg-success-subtle text-success"><i[^>]*><\/i> admin<\/span>/.test(html), '顶栏应显示登录名');
});

test('用户笔记审核已彻底移除: 菜单、路由、权限清单、状态注册表都不再引用', async () => {
  assert.ok(!navLabels.includes('用户笔记审核'), '侧栏不该再有这个入口');
  assert.ok(!NAV_GROUPS.flatMap((group) => group.items).some((item) => item.href.includes('user_news')),
    '菜单里不该再有 user_news 的地址');
  assert.ok(!PAGE_ROUTES.some((route) => route.path.includes('user_news')), '页面路由表不该再有它');
  assert.ok(!SUPER_ONLY_WRITE_PATHS.includes('/admin/user_news_manage'), '权限清单里不该再登记它');
  assert.ok(!statusKind('user_news'), '状态注册表里不该再有 user_news');

  // 老地址落到统一 404 页(不是白屏, 也不是仍能打开)
  const { env } = makeAdminEnv({ role: 'super' });
  const cookie = await loginCookie(env);
  const res = await get('/admin/user_news_manage', env, cookie);
  assert.equal(res.status, 404);
  assert.ok((await res.text()).includes('没有这个页面'));
});
