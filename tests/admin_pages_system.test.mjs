// 设置 / 系统信息 / 控制面板 端到端自检
import assert from 'node:assert/strict';
import test from 'node:test';

import { tableNames } from '../app/core/overview.js';
import { findCall, get, loginCookie, makeAdminEnv, post } from './admin_stub.mjs';

const ADMIN_PASSWORD = 'password-12345';

test('设置页: 两个表单 + 用户名只读 + 不出现头像字段', async () => {
  const { env } = adminEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/settings', env, cookie)).text();
  assert.ok(html.includes('保存资料') && html.includes('修改密码'));
  assert.ok(html.includes('readonly'), '用户名只读(用 readonly 而非 disabled, 值仍会提交)');
  assert.ok(!html.includes('name="avatar"'), '旧站本页就没有头像功能');
  assert.ok(html.includes('最近登录') && html.includes('注册时间'));
});

test('设置页: 改资料成功时就地渲染(不跳转)', async () => {
  const { env, state } = adminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/settings', { update_profile: '1', nickname: '新昵称', email: 'a@b.com' }, env, cookie);
  assert.equal(res.status, 200, '就地渲染 —— 资料页跳转会让"刚填的昵称看起来没生效"');
  assert.ok((await res.text()).includes('个人资料更新成功'));
  const update = findCall(state, /UPDATE admin_users SET nickname/i);
  assert.deepEqual(update.args.slice(0, 2), ['新昵称', 'a@b.com']);
});

test('设置页: 改口令的三条校验文案', async () => {
  const { env } = adminEnv();
  const cookie = await loginCookie(env);
  const empty = await post('/admin/settings', { change_password: '1', current_password: '' }, env, cookie);
  assert.ok((await empty.text()).includes('所有密码字段都不能为空'));
  const mismatch = await post('/admin/settings', {
    change_password: '1', current_password: ADMIN_PASSWORD, new_password: 'new-password-1', confirm_password: 'new-password-2'
  }, env, cookie);
  assert.ok((await mismatch.text()).includes('新密码和确认密码不匹配'));
  // 旧站前端写 6 而 backend 要 10: 这里前后端统一为 10
  const tooShort = await post('/admin/settings', {
    change_password: '1', current_password: ADMIN_PASSWORD, new_password: 'abc123', confirm_password: 'abc123'
  }, env, cookie);
  assert.ok((await tooShort.text()).includes('新密码长度不能少于 10 个字符'));
});

test('设置页: 当前口令不对时报错且不写库', async () => {
  const { env, state } = adminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/settings', {
    change_password: '1', current_password: 'wrong-password', new_password: 'a-long-password', confirm_password: 'a-long-password'
  }, env, cookie);
  assert.ok((await res.text()).includes('当前密码不正确'));
  assert.equal(findCall(state, /UPDATE admin_users SET password/i), null);
});

test('设置页: 改口令成功跳登录页 + 清会话 Cookie + 写入新哈希', async () => {
  const { env, state } = adminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/settings', {
    change_password: '1', current_password: ADMIN_PASSWORD, new_password: 'a-long-password', confirm_password: 'a-long-password'
  }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('密码已更新，请使用新密码重新登录')));
  assert.match(String(res.headers.get('set-cookie')), /Max-Age=0/);
  const update = findCall(state, /UPDATE admin_users SET password/i);
  assert.ok(String(update.args[0]).startsWith('pbkdf2_sha256$'), '库里只存哈希');
});

test('设置页: 认不出的提交要明确报错(不能静默重渲染)', async () => {
  const { env } = adminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/settings', { something_else: '1' }, env, cookie);
  assert.ok((await res.text()).includes('未识别到提交类型'));
});

test('系统信息: 展示 Worker 口径的信息, 不编进程数据', async () => {
  const { env } = adminEnv({
    mediaObjects: [{ key: 'news_uploads/a.png', size: 2048, uploaded: '2026-10-01T00:00:00Z' }],
    // 行数走 D1 batch 的逐表 COUNT(见 core/overview.js), 桩按 counts 喂数
    counts: { users: 4, news: 69, admin_users: 1, news_comments: 12 },
    db: (sql, args, kind) => {
      if (kind === 'all' && /FROM sqlite_master/i.test(sql)) {
        return [{ name: 'users' }, { name: 'news' }, { name: 'admin_users' }, { name: 'news_comments' }];
      }
      if (kind === 'first' && /AS visible_news/i.test(sql)) {
        return { visible_news: 67, recycled_news: 2, users: 4, comments: 12 };
      }
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/system_info', env, cookie)).text();
  assert.ok(html.includes('Cloudflare Workers'), '运行环境要照实说是 Serverless');
  assert.ok(html.includes('不适用 —— 每次请求由边缘按需拉起'), '不编 PID/运行时长');
  assert.ok(html.includes('4 张'), '业务表数量');
  assert.ok(html.includes('86'), '记录总数 4+69+1+12');
  assert.ok(html.includes('对外可见笔记'));
  assert.ok(html.includes('未启用'), '缓存后端照实说未启用');
  assert.ok(html.includes('2.0 KB'), 'R2 素材占用');
  assert.ok(html.includes('data-live="clock"'), '服务器时间给 live_time.js 走动');
  assert.ok(html.includes('data-live-anchor='));
  assert.ok(!html.includes('Python'), '不该出现旧站的 Python 版本行');
});

test('控制面板: 13 张卡 + 7 日趋势 + 最新列表', async () => {
  const { env } = adminEnv({
    db: (sql, args, kind) => {
      if (kind === 'all' && /substr\(publish_time/i.test(sql)) return [{ d: '2026-10-01', c: 3 }];
      if (kind === 'all' && /substr\(create_time/i.test(sql)) return [{ d: '2026-10-01', c: 2 }];
      if (kind === 'all' && /FROM users ORDER BY id DESC/i.test(sql)) return [{ id: 9, username: 'wx_1', nickname: '老王', create_time: '2026-10-01 08:00:00' }];
      if (kind === 'all' && /FROM news WHERE deleted_at IS NULL ORDER BY id DESC/i.test(sql)) return [{ id: 5, title: '重走来时路', publish_time: '2026-10-01 09:00:00' }];
      if (kind === 'all' && /FROM news_comments c/i.test(sql)) return [{ id: 3, content: '好文', status: 'pending', nickname: '老王' }];
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/dashboard', env, cookie)).text();
  assert.ok(html.includes('总用户数'));
  assert.ok(html.includes('今日新增用户'));
  assert.ok(html.includes('待审核笔记'));
  assert.ok(html.includes('总收藏'));
  assert.ok(html.includes('摩旅精选') && html.includes('户外精选'));
  assert.ok(html.includes('近 7 日新增用户趋势') && html.includes('近 7 日笔记发布趋势'));
  assert.ok(html.includes('<svg class="sparkline"'), '趋势用纯 SVG, 不引图表库');
  assert.ok(html.includes('最新注册用户') && html.includes('最新笔记') && html.includes('最新留言'));
  assert.ok(html.includes('老王') && html.includes('重走来时路'));
  assert.ok(html.includes('13/13') || html.includes('管理页面'), '迁移进度卡');
});

function adminEnv(overrides = {}) {
  return makeAdminEnv(overrides);
}

test('系统信息: 统计失败时不伪装成"0 张表", 并把原因显示在页面上', async () => {
  const { env } = adminEnv({
    mediaObjects: [],
    db: (sql, args, kind) => {
      if (kind === 'all' && /FROM sqlite_master/i.test(sql)) {
        throw new Error('D1_ERROR: too many terms in compound SELECT');
      }
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/system_info', env, cookie)).text();
  assert.ok(html.includes('统计失败，无法判定'), '失败时不能照常显示数字(2026-10-06 线上就被这个误导过)');
  assert.ok(html.includes('读取表清单失败'), '要在页面上说明是哪一步失败');
  assert.ok(html.includes('D1_ERROR'), '原因原文(截断)要可见, 否则只能翻 Workers Logs');
  assert.ok(html.includes('无法判定（上面的行数统计失败）'), '缺失清单同一步失败时也要标无法判定');
});

test('业务表清单排除 SQLite 与 D1 的内部表(_cf_KV / d1_migrations)', async () => {
  const env = {
    DB: {
      prepare: () => ({
        bind() { return this; },
        all: async () => ({
          results: [
            { name: 'sqlite_sequence' }, { name: '_cf_KV' }, { name: 'd1_migrations' },
            { name: 'news' }, { name: 'users' }
          ]
        })
      })
    }
  };
  assert.deepEqual(await tableNames(env), ['news', 'users']);
});
