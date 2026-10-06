// 后台动作字段自检(防回归): 提交按钮不许设 disabled(会丢 name/value), 动作字段一律走隐藏域
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { USER_ROW } from './stub.mjs';
import { get, loginCookie, makeAdminEnv } from './admin_stub.mjs';

const shellSource = await readFile(new URL('../app/admin/static/js/admin-shell.js', import.meta.url), 'utf8');
// 注释里会解释这条纪律(含"btn.disabled = true"字样), 断言只看真实代码
const shellCode = shellSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  // 注意别写成 /\/\/.*$/ —— 行尾的 \r 会让它匹配不上(文件是 CRLF)
  .map((line) => line.replace(/\/\/.*/, ''))
  .join('\n');

test('提交按钮防重: 不许设 disabled(会丢 name/value), 只能用 aria-disabled', () => {
  assert.ok(!/\.disabled\s*=\s*true/.test(shellCode),
    'submit 事件里给按钮设 disabled 会让它的 name/value 整条丢掉(表单数据构造在事件之后)');
  assert.ok(shellSource.includes("setAttribute('aria-disabled', 'true')"),
    '锁定按钮要走 aria-disabled');
  assert.ok(shellSource.includes('pointerEvents'), '锁定按钮要顺带停掉点击(pointer-events)');
  assert.ok(shellSource.includes('unlockButton'), '从 bfcache 返回时要能解锁');
});

test('用户页: 三个动作都用隐藏域提交, 且与后端识别值一致', async () => {
  // status=1 才有【恢复账号】, is_trusted=0 才有【设为内部测试】
  const row = Object.assign({}, USER_ROW, { status: 1, is_trusted: 0 });
  const { env } = makeAdminEnv({ rows: { users: [row] }, counts: { users: 1 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/users', env, cookie)).text();

  for (const value of ['set_trusted', 'restore_user']) {
    assert.ok(html.includes(`<input type="hidden" name="action" value="${value}">`),
      `${value} 必须走隐藏域(不依赖提交按钮)`);
  }
  assert.ok(html.includes('恢复账号') && html.includes('设为内部测试'));
  assert.ok(!/<button[^>]*name="action"/.test(html), '不要再把动作挂在按钮的 name 上');
  assert.ok(html.includes("confirm('恢复该账号？恢复后他可以正常登录。')"), '恢复账号要先确认');
  assert.ok(html.includes("confirm('设为内部测试用户？"), '设为内部测试要先确认');
});

test('用户页: 已设内部测试时给"取消内部测试"(动作值 remove_trusted)', async () => {
  const row = Object.assign({}, USER_ROW, { status: 0, is_trusted: 1 });
  const { env } = makeAdminEnv({ rows: { users: [row] }, counts: { users: 1 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/users', env, cookie)).text();
  assert.ok(html.includes('<input type="hidden" name="action" value="remove_trusted">'));
  assert.ok(html.includes('取消内部测试'));
});

test('上传弹窗: 静态脚本必须自己绑 [data-image-upload](漏了就是"点了上传没反应")', async () => {
  const uploader = await readFile(new URL('../app/admin/static/js/image_upload.js', import.meta.url), 'utf8');
  // 表单只带 data-* 说明行为, 真正发请求的是这个脚本; 旧站这段写在模板里, 抽静态脚本时最容易漏
  assert.ok(uploader.includes("hasAttribute('data-image-upload')"), '要认领上传表单');
  assert.ok(/document\.addEventListener\('submit',[\s\S]{0,4000}?\}, true\)/.test(uploader),
    '要用 capture 阶段监听: 先 preventDefault, 才不会被整页提交处理器当成重复提交锁住按钮');
  for (const attr of ['dataset.target', 'dataset.preview', 'dataset.insert', 'dataset.purpose']) {
    assert.ok(uploader.includes(attr), `要按表单的 ${attr} 决定回填/插入/用途`);
  }
  assert.ok(uploader.includes('MediaInsertFromUpload'), '正文用法要交给页面提供的插入回调');
});

test('素材库弹窗: 目录清单由模板下发(前端不自己写死 news_uploads/)', async () => {
  const { mediaLibraryModal } = await import('../app/admin/lib/partials.js');
  assert.ok(mediaLibraryModal().includes('data-media-prefixes="image/,video/,news_uploads/"'),
    '弹窗要下发素材目录清单(真值在 core/storage.js)');
  const picker = await readFile(new URL('../app/admin/static/js/media_library.js', import.meta.url), 'utf8');
  assert.ok(picker.includes("getAttribute('data-media-prefixes')"), '前端要读这份清单');
  assert.ok(!/v = 'news_uploads\/' \+ v/.test(picker), '手工填路径不该再强行补历史前缀');
});

test('管理员页: 重置口令 / 删除 也用隐藏域(同类问题一并修)', async () => {
  const other = {
    id: 2, username: 'ops', nickname: '运维', email: '', role: 'normal',
    create_time: '2026-09-01 10:00:00', last_login_time: '2026-10-01 08:00:00'
  };
  const { env } = makeAdminEnv({ rows: { admin_users: [other] }, counts: { admin_users: 2 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/admin_users', env, cookie)).text();
  assert.ok(html.includes('<input type="hidden" name="reset_admin_password" value="1">'));
  assert.ok(html.includes('<input type="hidden" name="delete_admin" value="1">'));
});
