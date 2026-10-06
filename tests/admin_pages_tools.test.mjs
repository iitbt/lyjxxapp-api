// 数据库工具 + 素材库治理两页的行为(对照旧站 dbadmin.py / media_admin.py)
//
// 重点盯"闸门"与"判定"两类问题: 开关默认关、只允许白名单业务表、写语句必须二次确认、
// 敏感列脱敏、有引用一律拒绝删除(含回收站)。
import assert from 'node:assert/strict';
import test from 'node:test';

import { findCall, get, loginCookie, makeAdminEnv, post } from './admin_stub.mjs';

// 数据库工具页要用到的 D1 桩: 表清单 / 行数 / PRAGMA / 分页
function dbStub(sql) {
  if (/FROM sqlite_master WHERE type='table'/i.test(sql)) return [{ name: 'news' }, { name: 'users' }];
  if (/PRAGMA table_info/i.test(sql)) {
    return [
      { name: 'id', type: 'INTEGER', notnull: 1, pk: 1, dflt_value: null },
      { name: 'title', type: 'TEXT', notnull: 0, pk: 0, dflt_value: null }
    ];
  }
  if (/PRAGMA index_list/i.test(sql)) return [{ name: 'idx_news_status', unique: 0 }];
  if (/COUNT\(\*\) AS c FROM "news"/i.test(sql)) return { c: 69 };
  if (/SELECT \* FROM "news"/i.test(sql)) return [{ id: 1, title: '标题' }];
  if (/SELECT token FROM users/i.test(sql)) return [{ token: 'plain-token' }];
  return undefined;
}

async function toolsEnv(extra = {}) {
  // 页面里的"数据表状态"要走 countTables(逐表 batch COUNT), 桩按 counts 喂数
  const made = makeAdminEnv(Object.assign({ role: 'super', db: dbStub, counts: { news: 69, users: 4 } }, extra));
  made.env.ENABLE_SQL_TOOL = '1';
  return made;
}

test('数据库工具: 默认关闭(ENABLE_SQL_TOOL=0 时不暴露表与控制台)', async () => {
  const { env } = makeAdminEnv({ role: 'super', db: dbStub });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/db_manage', env, cookie)).text();
  assert.match(html, /数据库工具未开启/);
  // 关闭时不渲染 SQL 控制台(用表单 id 判定, 别用"执行 SQL"这种会出现在说明文案里的词)
  assert.ok(!html.includes('id="sqlForm"'));

  const res = await post('/admin/db_manage/exec', { sql: 'SELECT id FROM news' }, env, cookie);
  assert.equal((await res.json()).code, 403);
});

test('数据库工具: 开启后出表清单与结构(含行数), 表详情走 JSON', async () => {
  const { env } = await toolsEnv();
  const cookie = await loginCookie(env);

  const html = await (await get('/admin/db_manage', env, cookie)).text();
  assert.match(html, /数据表状态/);
  assert.match(html, /执行 SQL/);
  assert.ok(html.includes('news'));
  assert.ok(html.includes('69'));

  const detail = await (await get('/admin/db_manage?table=news', env, cookie)).text();
  assert.match(detail, /结构/);
  assert.match(detail, /标题/);

  const json = await (await get('/admin/db_manage/table?name=news', env, cookie)).json();
  assert.equal(json.code, 200);
  assert.equal(json.data.total, 69);
  assert.deepEqual(json.data.row_keys, ['id', 'title']);
  assert.equal(json.data.columns.length, 2);
});

test('数据库工具: 只允许白名单业务表的单条语句, 写语句必须 confirm=1', async () => {
  const { env } = await toolsEnv();
  const cookie = await loginCookie(env);

  // 结构变更一律拒绝
  const ddl = await (await post('/admin/db_manage/exec', { sql: 'DROP TABLE news' }, env, cookie)).json();
  assert.equal(ddl.code, 400);
  assert.match(ddl.msg, /只允许 SELECT/);

  // 多语句拒绝
  const multi = await (await post('/admin/db_manage/exec', { sql: 'SELECT 1; SELECT 2' }, env, cookie)).json();
  assert.equal(multi.code, 400);
  assert.match(multi.msg, /一次只能执行一条语句/);

  // 白名单外的表拒绝(admin_users 不在 SAFE_TABLES)
  const outside = await (await post('/admin/db_manage/exec', { sql: 'SELECT * FROM admin_users' }, env, cookie)).json();
  assert.equal(outside.code, 400);
  assert.match(outside.msg, /只允许操作这些业务表/);

  // 写语句没带 confirm → 403
  const unconfirmed = await (await post('/admin/db_manage/exec', { sql: 'UPDATE news SET title=? WHERE id=1' }, env, cookie)).json();
  assert.equal(unconfirmed.code, 403);
  assert.match(unconfirmed.msg, /二次确认/);

  // 带 confirm 的写语句 → 200 + 影响行数(桩固定 1)
  const written = await (await post('/admin/db_manage/exec', { sql: 'UPDATE news SET title=? WHERE id=1', confirm: '1' }, env, cookie)).json();
  assert.equal(written.code, 200);
  assert.match(written.msg, /影响 1 行/);

  // 查询: 返回行 + 脱敏(token 列变 ***)
  const read = await (await post('/admin/db_manage/exec', { sql: 'SELECT token FROM users' }, env, cookie)).json();
  assert.equal(read.code, 200);
  assert.equal(read.data.ran, true);
  assert.equal(read.data.rows[0].token, '***');
});

test('数据库工具: 非超管既进不了页面, 也调不动 exec', async () => {
  const { env } = makeAdminEnv({ role: 'normal', db: dbStub });
  env.ENABLE_SQL_TOOL = '1';
  const cookie = await loginCookie(env);

  const page = await get('/admin/db_manage', env, cookie);
  assert.equal(page.status, 302);
  assert.match(String(page.headers.get('location')), /error=/);

  const res = await post('/admin/db_manage/exec', { sql: 'SELECT id FROM news' }, env, cookie);
  const text = await res.text();
  assert.ok(res.status === 403 || /超级管理员/.test(text));
});

// ---------------- 素材库治理 ----------------

const MEDIA_OBJECTS = [
  { key: 'news_uploads/a.png', size: 1024, uploaded: '2026-10-01T00:00:00Z' },
  { key: 'news_uploads/b.mp4', size: 4096, uploaded: '2026-10-02T00:00:00Z' },
  { key: 'image/new.png', size: 8192, uploaded: '2026-10-06T00:00:00Z' },
  // 缩略图: 新目录与历史目录各一个(占用统计要把两处都算上)
  { key: 'news_uploads/_thumb/480/a.webp', size: 128, uploaded: '2026-10-01T00:00:00Z' },
  { key: 'image/_thumb/480/new.webp', size: 256, uploaded: '2026-10-06T00:00:00Z' }
];

const mediaRows = {
  news: [
    { id: 1, title: '引用了 a 的笔记', image: 'news_uploads/a.png', video_url: '', content: '', deleted_at: null },
    // 新目录里的素材同样要能被引用扫描认出来, 否则治理页会把"在用"的图当无用文件
    { id: 2, title: '引用了新目录的笔记', image: '', video_url: '', content: '<p><img src="image/new.png"></p>', deleted_at: null }
  ]
};

test('素材库治理: 非超管进不去(页面自己判 GET, 中间件只拦写)', async () => {
  const { env } = makeAdminEnv({ role: 'normal', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);
  const res = await get('/admin/media_manage', env, cookie);
  assert.equal(res.status, 302);
  assert.match(String(res.headers.get('location')), /\/admin\/dashboard\?error=/);
});

test('素材库治理: 列出素材、标注被引用与未引用', async () => {
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);

  const html = await (await get('/admin/media_manage', env, cookie)).text();
  assert.match(html, /素材库管理/);
  assert.ok(html.includes('a.png'));
  assert.ok(html.includes('b.mp4'));
  // 派生缩略图不进清单(只计入占用), 屏上的清单里不应出现 _thumb; 两个目录的缩略图都要算
  assert.ok(!html.includes('_thumb/480/a.webp'));
  assert.ok(!html.includes('_thumb/480/new.webp'));
  assert.ok(html.includes('派生缩略图 2 个'), '缩略图占用要同时统计新目录与历史目录');
  // a.png 被笔记引用 → 显示"1 处"; b.mp4 未引用
  assert.match(html, /1 处/);
  assert.match(html, /未引用/);

  const refs = await (await get('/admin/media_manage_refs?path=news_uploads/a.png', env, cookie)).json();
  assert.equal(refs.success, true);
  assert.equal(refs.total, 1);
  assert.equal(refs.items[0].source, '笔记 · 封面');

  // 新目录里的素材: 正文引用要能认出来(旧实现只认 news_uploads/ 前缀, 会误判成"未引用")
  const newRefs = await (await get('/admin/media_manage_refs?path=image/new.png', env, cookie)).json();
  assert.equal(newRefs.total, 1);
  assert.equal(newRefs.items[0].source, '笔记 · 正文');
});

test('素材库治理: 有引用时拒绝删除(确认页说明 + POST 复查)', async () => {
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);

  const confirm = await (await get('/admin/media_manage_delete?path=news_uploads/a.png', env, cookie)).text();
  assert.match(confirm, /不能删除/);

  const res = await post('/admin/media_manage_delete', { path: 'news_uploads/a.png', back: '/admin/media_manage' }, env, cookie);
  assert.equal(res.status, 302);
  assert.match(String(res.headers.get('location')), /error=/);
});

test('素材库治理: 无引用时删除并回列表带 message', async () => {
  const { env, state } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);

  const confirm = await (await get('/admin/media_manage_delete?path=news_uploads/b.mp4', env, cookie)).text();
  assert.match(confirm, /删除素材/);
  assert.ok(!confirm.includes('不能删除'));

  const res = await post('/admin/media_manage_delete', { path: 'news_uploads/b.mp4', back: '/admin/media_manage' }, env, cookie);
  assert.equal(res.status, 302);
  assert.match(String(res.headers.get('location')), /message=/);
  assert.deepEqual(state.deletes, ['news_uploads/b.mp4']);
  // 删除前一定扫过引用(含回收站: WHERE 里没有 deleted_at 过滤)
  const scan = findCall(state, /FROM news\s+WHERE image LIKE/i);
  assert.ok(scan, '删除前必须复查引用');
});

test('素材库治理: 返回地址收敛, 不接受站外跳转', async () => {
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);
  const res = await post(
    '/admin/media_manage_delete',
    { path: 'news_uploads/b.mp4', back: '//evil.example/x' },
    env,
    cookie
  );
  assert.equal(res.status, 302);
  const location = String(res.headers.get('location'));
  assert.ok(!location.includes('evil.example'), '开放重定向必须被挡住');
});
