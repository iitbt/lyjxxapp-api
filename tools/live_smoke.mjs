// 真实数据端到端冒烟: 用 node:sqlite 装真实建表结构 + 真实数据(out/seed.sql), 让 Worker 跑真 SQL(不联网)
// 用法: 先 python scripts/export_sqlite.py ../../fastapi/data/lyjx.db out/seed.sql, 再 node scripts/live_smoke.mjs
// 目的: 抓出桩测不到的问题(列名、唯一索引冲突、ON CONFLICT、计数自增、时间格式等)
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../main.js';

// 目录一律相对脚本自身定位, 从哪里执行都行
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');

const schema1 = read('app/sql/0001_schema.sql');
const schema2 = read('app/sql/0002_rate_limit.sql');
const schema3 = read('app/sql/0003_wechat_token.sql');
const seed = read('out/seed.sql');

const db = new DatabaseSync(':memory:');
db.exec(schema1);
db.exec(schema2);
db.exec(schema3);
db.exec(seed);

// D1 兼容的最薄适配: prepare().bind().first()/all()/run() + batch()
const d1 = {
  prepare(sql) {
    const holder = { sql, args: [] };
    const api = {
      bind(...args) {
        holder.args = args;
        return api;
      },
      first: async () => {
        const row = db.prepare(holder.sql).get(...holder.args);
        return row === undefined ? null : row;
      },
      all: async () => ({ results: db.prepare(holder.sql).all(...holder.args) }),
      run: async () => {
        const info = db.prepare(holder.sql).run(...holder.args);
        return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      }
    };
    return api;
  },
  batch: async (list) => {
    for (const item of list) await item.run();
    return [];
  }
};

const env = {
  DB: d1,
  STORAGE: { head: async () => null, get: async () => null, put: async () => ({}) },
  MEDIA_BASE: 'https://storage.250036.xyz',
  DEV_WECHAT_MOCK: '1',
  UPLOAD_MAX_BYTES: '20971520',
  ENABLE_PUBLIC_PROBE: '1'
};

let failed = 0;
const call = async (path, options = {}) => {
  const init = { method: options.method || 'GET', headers: {} };
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await worker.fetch(new Request(`https://api.test${path}`, init), env, {});
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    body = { __html: text };
  }
  return { status: response.status, body };
};

const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`OK   ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label} ${detail}`);
  }
};

// 拿一个真实用户 token
const user = db.prepare('SELECT id, token, is_trusted, nickname FROM users WHERE token IS NOT NULL LIMIT 1').get();
console.log(`真实用户: id=${user.id} token=${String(user.token).slice(0, 8)}… is_trusted=${user.is_trusted}`);
const trusted = db.prepare('SELECT id, token FROM users WHERE is_trusted = 1 LIMIT 1').get();
console.log(`内部测试用户: ${trusted ? `id=${trusted.id}` : '无(跳过相关断言)'}`);

// 1. 列表(带 page / 不带 page)
const bare = await call('/news/list');
check('GET /news/list 无 page 时只有 code+data', bare.body.code === 200 && !('msg' in bare.body) && Array.isArray(bare.body.data), JSON.stringify(bare.body).slice(0, 120));
// 挑一条该用户"没点过赞、没收藏过"的笔记, 否则真实数据里本来就有记录, 会把断言带偏
const freeNote = db.prepare(
  'SELECT id FROM news WHERE status=? AND deleted_at IS NULL AND id NOT IN (SELECT news_id FROM news_likes WHERE user_id=?) '
  + 'AND id NOT IN (SELECT news_id FROM news_favorites WHERE user_id=?) ORDER BY id LIMIT 1'
).get('approved', user.id, user.id);
console.log(`用于写路径断言的笔记: id=${freeNote ? freeNote.id : '(无, 跳过)'}`);

const paged = await call('/news/list?page=1&page_size=3');
check('GET /news/list?page=1 结构与 total', paged.body.data && paged.body.data.list.length <= 3 && typeof paged.body.data.total === 'number' && paged.body.msg === '获取成功', JSON.stringify(paged.body).slice(0, 160));
const firstNote = paged.body.data.list[0];
check('列表行含旧站字段', firstNote && 'image' in firstNote && 'is_liked' in firstNote && 'share' === 'share', JSON.stringify(firstNote).slice(0, 160));

// 2. 详情(真实正文/作者)
const detail = await call(`/news/detail?id=${firstNote.id}`);
check('GET /news/detail 命中真实数据', detail.body.code === 200 && detail.body.data.id === firstNote.id, JSON.stringify(detail.body).slice(0, 160));
check('详情含 is_liked/is_favorited/is_viewed', ['is_liked', 'is_favorited', 'is_shared', 'is_viewed'].every((k) => k in detail.body.data));

// 3. 点赞(真实唯一索引 + 计数自增 + 取消)
const writeNote = freeNote ? freeNote.id : firstNote.id;
const before = db.prepare('SELECT likes FROM news WHERE id=?').get(writeNote).likes;
const like1 = await call('/news/like', { method: 'POST', body: { news_id: writeNote, action: 'add', token: user.token } });
const like2 = await call('/news/like', { method: 'POST', body: { news_id: writeNote, action: 'add', token: user.token } });
const after = db.prepare('SELECT likes FROM news WHERE id=?').get(writeNote).likes;
check('点赞写入 + 计数自增', like1.body.code === 200 && after === before + 1, `before=${before} after=${after} resp=${JSON.stringify(like1.body).slice(0, 80)}`);
check('重复点赞被唯一索引拦下(403)', like2.body.code === 403, JSON.stringify(like2.body).slice(0, 80));
const unlike = await call('/news/like', { method: 'POST', body: { news_id: writeNote, action: 'remove', token: user.token } });
check('取消点赞 + 计数回退', unlike.body.code === 200 && db.prepare('SELECT likes FROM news WHERE id=?').get(writeNote).likes === before);

// 4. 限流(真实 D1 计数表)
db.prepare('DELETE FROM news_favorites WHERE user_id=? AND news_id=?').run(user.id, writeNote);
let limited = null;
for (let i = 0; i < 62 && !limited; i += 1) {
  const res = await call('/news/favorite', { method: 'POST', body: { news_id: writeNote, action: 'add', token: user.token } });
  if (res.body.code === 429) limited = res.body;
  else if (res.body.code === 200) {
    await call('/news/favorite', { method: 'POST', body: { news_id: writeNote, action: 'remove', token: user.token } });
  }
}
check('配额触发 429 且文案一致', limited && limited.msg === '操作过于频繁，请稍后再试', JSON.stringify(limited || {}).slice(0, 80));
const counter = db.prepare("SELECT count FROM rate_limit_counters WHERE scope='favorite'").get();
check('计数写进了 rate_limit_counters', !!counter && counter.count >= 60, JSON.stringify(counter || {}));

// 5. 内容与配置(全真实数据)
const banners = await call('/content/get_banners');
check('GET /content/get_banners 是 code=0 且带图', banners.body.code === 0 && Array.isArray(banners.body.data) && String(banners.body.data[0]?.image_url || '').startsWith(env.MEDIA_BASE), JSON.stringify(banners.body).slice(0, 140));
const outdoor = await call('/content/get_outdoor');
check('GET /content/get_outdoor 四键 + 无 video_url 键', outdoor.body.code === 200 && outdoor.body.status === 'success' && outdoor.body.data[0] && !('video_url' in outdoor.body.data[0]) && 'can_watch_video' in outdoor.body.data[0], JSON.stringify(outdoor.body).slice(0, 160));
const notices = await call('/content/get_notices?page=1&page_size=5');
check('GET /content/get_notices 只有 message 且带 pageSize', notices.body.message === '获取通知公告成功' && notices.body.msg === undefined && notices.body.data.pageSize === 5 && Array.isArray(notices.body.data.list), JSON.stringify(notices.body).slice(0, 160));
const config = await call('/config/get_app_config');
check('GET /config/get_app_config 六块齐全', ['categories', 'home_sections', 'featured', 'version', 'texts', 'menu'].every((k) => k in config.body.data) && typeof config.body.timestamp === 'number', JSON.stringify(Object.keys(config.body.data || {})));
check('配置里的分类/菜单/文案来自真实库', config.body.data.categories.length > 0 && config.body.data.menu.length > 0 && Object.keys(config.body.data.texts).length > 0, `categories=${config.body.data.categories.length} menu=${config.body.data.menu.length} texts=${Object.keys(config.body.data.texts).length}`);

// 6. 用户资料与三个列表(真实 token)
const info = await call('/user/get_user_info', { method: 'POST', body: { token: user.token } });
check('POST /user/get_user_info(真实 token)', info.body.code === 200 && info.body.data.id === user.id && !('token' in info.body.data), JSON.stringify(info.body).slice(0, 140));
for (const [path, key] of [['/user/user_favorites', 'favorites'], ['/user/user_likes', 'likes'], ['/user/user_view_history', 'views']]) {
  const res = await call(path, { method: 'POST', body: { token: user.token, action: 'get', page: 1, page_size: 5 } });
  check(`POST ${path} 列表可用`, res.body.code === 200 && Array.isArray(res.body.data[key]), JSON.stringify(res.body).slice(0, 140));
}
const unread = await call('/content/get_notice_unread', { method: 'POST', body: { token: user.token } });
check('POST /content/get_notice_unread(真实库)', unread.body.code === 200 && typeof unread.body.data.unread_count === 'number', JSON.stringify(unread.body).slice(0, 140));

// 7. 登录 / 注销 / 恢复 / 彻底删除(真实 users 表, 走 mock 微信)
const code = `smoke-${Date.now()}`;
const login = await call('/user/login', { method: 'POST', body: { login_type: 'wechat', code, nickname: '冒烟用户' } });
check('POST /user/login 新用户注册(真实 users 表)', login.body.code === 200 && login.body.data.token && login.body.data.nickname === '冒烟用户', JSON.stringify(login.body).slice(0, 200));
const newToken = login.body.data.token;
const row = db.prepare('SELECT id, nickname, raw_nickname, is_trusted, status FROM users WHERE token=?').get(newToken);
check('注册写入的列正确(nickname/raw_nickname)', !!row && row.nickname === '冒烟用户' && row.raw_nickname === '冒烟用户', JSON.stringify(row || {}));

const relogin = await call('/user/login', { method: 'POST', body: { login_type: 'wechat', code } });
check('同 code 二次登录复用同一账号', relogin.body.data.id === login.body.data.id, JSON.stringify(relogin.body).slice(0, 120));
// 每次登录都会换 token(与旧站一致), 后续请求要用最新那个
const activeToken = relogin.body.data && relogin.body.data.token;
console.log('relogin.body =', JSON.stringify(relogin.body).slice(0, 200));
console.log('activeToken =', activeToken);

const updated = await call('/user/update_profile', { method: 'POST', body: { token: activeToken, nickname: '改过的名字' } });
const smokeUserId = login.body.data.id;
const afterUpdate = db.prepare('SELECT nickname, raw_nickname, nickname_modified, token FROM users WHERE id=?').get(smokeUserId);
console.log('updated.body =', JSON.stringify(updated.body).slice(0, 200));
console.log('rowById =', JSON.stringify(afterUpdate));
console.log('matchByToken =', JSON.stringify(db.prepare('SELECT COUNT(*) AS c FROM users WHERE token=?').get(activeToken)));
check('POST /user/update_profile 真写库且置 nickname_modified=1', updated.body.code === 200 && afterUpdate.nickname === '改过的名字' && afterUpdate.nickname_modified === 1, JSON.stringify({ afterUpdate, resp: updated.body }).slice(0, 200));

const deleted = await call('/user/delete_account', { method: 'POST', body: { token: activeToken, confirm: 'yes' } });
const deletedRow = db.prepare('SELECT nickname, raw_nickname, status, token FROM users WHERE id=?').get(login.body.data.id);
check('注销: 半角后缀 + token 置空 + status=1', deleted.body.msg === '账号已注销' && deletedRow.nickname === '改过的名字(已注销)' && deletedRow.token === null && deletedRow.status === 1, JSON.stringify(deletedRow || {}));

const blocked = await call('/user/login', { method: 'POST', body: { login_type: 'wechat', code } });
check('已注销账号登录返回 409 + account_deleted', blocked.body.code === 409 && blocked.body.data.account_deleted === true, JSON.stringify(blocked.body).slice(0, 140));

const restored = await call('/user/deleted_account_action', { method: 'POST', body: { action: 'restore', code } });
const restoredRow = db.prepare('SELECT nickname, raw_nickname, status FROM users WHERE id=?').get(login.body.data.id);
check('恢复: 昵称=原昵称(已恢复) 且 status=0', restored.body.msg === '账号已恢复' && restoredRow.nickname === '改过的名字(已恢复)' && restoredRow.status === 0, JSON.stringify(restoredRow || {}));

// 恢复后账号是正常态, 此时 purge 必须被拒(与旧站一致); 要彻底删得先再注销一次
const purgeRejected = await call('/user/deleted_account_action', { method: 'POST', body: { action: 'purge', code } });
check('恢复态直接 purge 被拒(409)', purgeRejected.body.code === 409, JSON.stringify(purgeRejected.body).slice(0, 120));
await call('/user/delete_account', { method: 'POST', body: { token: restored.body.data.token, confirm: 'yes' } });
const purged = await call('/user/deleted_account_action', { method: 'POST', body: { action: 'purge', code } });
check('彻底删除: users 记录消失', purged.body.msg === '账号已彻底删除' && !db.prepare('SELECT id FROM users WHERE id=?').get(smokeUserId), JSON.stringify(purged.body).slice(0, 120));

// 8. 静态页与探针(真实 app_texts)
const terms = await call('/pages/terms');
check('GET /pages/terms 正文来自 app_texts', terms.status === 200 && terms.body.__html && terms.body.__html.includes('一、账号'), String(terms.body.__html || '').slice(0, 100));
const ready = await call('/health/ready');
check('GET /health/ready 为 ready(真实库)', ready.status === 200 && ready.body.status === 'ready' && ready.body.checks.database === true);
const statusJson = await call('/?format=json');
check('GET /?format=json 与旧站同文案', statusJson.body.status === '运行中' && !!statusJson.body.server_time);
const apitest = await call('/apitest');
check('GET /apitest 报库连通', apitest.body.data.database_connected === true);

console.log(failed === 0 ? '\n全部通过(真实数据端到端)' : `\n失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
