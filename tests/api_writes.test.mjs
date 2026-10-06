// 写接口与鉴权自检: 点赞/收藏/分享/留言/批量点赞/登录/资料/头像/注销/三个列表 + 限流 429
import assert from 'node:assert/strict';
import test from 'node:test';

import { TRUSTED_USER_ROW, USER_ROW, makeEnv, postJson } from './stub.mjs';

// 通用桩: token 命中 USER_ROW; 笔记存在; 其余按需覆盖
function baseDb(overrides = {}) {
  return (sql, args, kind) => {
    if (/FROM users WHERE token=/i.test(sql)) return args[0] === 'tok-trusted' ? TRUSTED_USER_ROW : USER_ROW;
    if (/FROM users WHERE openid=/i.test(sql)) return null;
    if (/FROM users WHERE id=\?/i.test(sql)) return USER_ROW;
    if (/SELECT id FROM news WHERE id=/i.test(sql)) return { id: 5 };
    if (/SELECT likes,favorites,shares,view_count FROM news/i.test(sql)) return { likes: 3, favorites: 1, shares: 2, view_count: 4 };
    if (/SELECT likes AS c FROM news/i.test(sql)) return { c: 3 };
    if (/SELECT favorites AS c FROM news/i.test(sql)) return { c: 1 };
    if (/SELECT shares FROM news/i.test(sql)) return { shares: 2 };
    if (/SELECT view_count FROM news/i.test(sql)) return { view_count: 5 };
    if (/FROM rate_limit_counters/i.test(sql)) return null;
    if (/FROM news_likes WHERE user_id=/i.test(sql)) return { all: [{ news_id: 5 }] };
    if (/COUNT\(\*\) AS c FROM app_notices/i.test(sql)) return { c: 2 };
    if (/COUNT\(\*\) AS c FROM app_notice_reads/i.test(sql)) return { c: 0 };
    const override = overrides[sql.trim().split('\n')[0]] || overrides[String(sql).slice(0, 40)];
    if (override) return override;
    return null;
  };
}

test('点赞: 未登录 401; 成功回计数; 重复 403', async () => {
  const anon = makeEnv({ db: baseDb() });
  assert.equal((await postJson('/news/like', { news_id: 5, action: 'add' }, anon.env)).msg, '请先登录后再操作');

  const ok = makeEnv({ db: baseDb() });
  const first = await postJson('/news/like', { news_id: 5, action: 'add', token: 'tok-1' }, ok.env);
  assert.equal(first.code, 200);
  assert.deepEqual(first.data, { likes: 3, is_liked: true });

  const dup = makeEnv({
    db: (sql, args, kind) => {
      // 重复点赞靠 INSERT OR IGNORE + changes=0 判定(唯一索引冲突在 D1 上是抛错, 不能用裸 INSERT)
      if (/INSERT (OR IGNORE )?INTO news_likes/i.test(sql)) return { changes: 0 };
      return baseDb()(sql, args, kind);
    }
  });
  const repeat = await postJson('/news/like', { news_id: 5, action: 'add', token: 'tok-1' }, dup.env);
  assert.equal(repeat.code, 403);
  assert.equal(repeat.msg, '您已经点赞过该笔记了');
});

test('收藏/分享/留言: 参数校验与文案', async () => {
  const { env } = makeEnv({ db: baseDb() });
  assert.equal((await postJson('/news/favorite', { news_id: 0, action: 'add', token: 'tok-1' }, env)).msg, '参数错误');
  assert.equal((await postJson('/news/favorite', { news_id: 5, action: 'x', token: 'tok-1' }, env)).msg, '操作类型错误');
  const fav = await postJson('/news/favorite', { news_id: 5, action: 'add', token: 'tok-1' }, env);
  assert.equal(fav.data.is_favorited, true);

  assert.equal((await postJson('/news/share', {}, env)).msg, '缺少笔记ID参数');
  const share = await postJson('/news/share', { news_id: 5 }, env);
  assert.equal(share.msg, '分享记录成功');
  assert.equal(share.data.is_shared, true);

  assert.equal((await postJson('/news/add_comment', { news_id: 5, content: '' }, env)).msg, '缺少必要的参数');
  assert.match((await postJson('/news/add_comment', { news_id: 5, content: 'x'.repeat(501), token: 'tok-1' }, env)).msg, /长度应在1-500/);
});

test('留言审核: 普通用户 pending, 内部测试用户免审 approved', async () => {
  const env = makeEnv({ db: baseDb() });
  const pending = await postJson('/news/add_comment', { news_id: 5, content: '不错', token: 'tok-1' }, env.env);
  assert.equal(pending.msg, '留言已提交，审核中');
  assert.equal(pending.data.status, 'pending');
  assert.equal(pending.data.is_approved, false);

  const trusted = await postJson('/news/add_comment', { news_id: 5, content: '不错', token: 'tok-trusted' }, env.env);
  assert.equal(trusted.msg, '留言发布成功');
  assert.equal(trusted.data.status, 'approved');
  assert.equal(trusted.data.is_approved, true);
});

test('批量点赞态: 缺参 400, 正常返回 liked_news_ids', async () => {
  const { env } = makeEnv({ db: baseDb() });
  assert.equal((await postJson('/news/check_user_like_batch', { user_id: 7 }, env)).msg, '缺少必要参数');
  const body = await postJson('/news/check_user_like_batch', { user_id: 7, news_ids: '5,6,5', token: 'tok-1' }, env);
  assert.deepEqual(body.data.liked_news_ids, [5]);
});

test('限流: 达到配额返回 429 与旧文案', async () => {
  const { env } = makeEnv({
    db: (sql, args, kind) => {
      if (/FROM rate_limit_counters/i.test(sql)) return { count: 60 };
      return baseDb()(sql, args, kind);
    }
  });
  const limited = await postJson('/news/like', { news_id: 5, action: 'add', token: 'tok-1' }, env);
  assert.equal(limited.code, 429);
  assert.equal(limited.msg, '操作过于频繁，请稍后再试');
});

test('登录: 缺 code / 账号密码下线 / mock 新用户注册 / 已注销 409', async () => {
  const env = makeEnv({ db: baseDb() }).env;
  assert.equal((await postJson('/user/login', { login_type: 'wechat' }, env)).msg, '参数错误：缺少code');
  assert.equal((await postJson('/user/login', { login_type: 'account', code: 'x' }, env)).msg, '已停止支持账号密码登录，请使用微信登录');
  assert.equal((await postJson('/user/login', { login_type: 'sms', code: 'x' }, env)).msg, '未知的登录类型');

  // 未配置 WECHAT_SECRET 时走 mock, 无需联网
  const fresh = makeEnv({
    db: (sql, args, kind) => {
      if (/FROM users WHERE openid=/i.test(sql)) return null;
      if (/INSERT INTO users/i.test(sql)) return { changes: 1, last_row_id: 7 };
      if (/FROM users WHERE id=\?/i.test(sql)) return USER_ROW;
      return baseDb()(sql, args, kind);
    }
  });
  const registered = await postJson('/user/login', { login_type: 'wechat', code: 'abc', nickname: '老王', avatar: 'avatar_uploads/a.png' }, fresh.env);
  assert.equal(registered.msg, '登录成功');
  assert.equal(registered.data.id, 7);
  assert.equal(registered.data.avatar, 'https://media.test/avatar_uploads/a.png');
  assert.ok(registered.data.token);

  const deleted = makeEnv({
    db: (sql, args, kind) => {
      if (/FROM users WHERE openid=/i.test(sql)) return Object.assign({}, USER_ROW, { status: 1 });
      return baseDb()(sql, args, kind);
    }
  });
  const blocked = await postJson('/user/login', { login_type: 'wechat', code: 'abc' }, deleted.env);
  assert.equal(blocked.code, 409);
  assert.equal(blocked.msg, '此账号已注销，请选择后续操作');
  assert.equal(blocked.data.account_deleted, true);
});

test('资料: 未登录 401; 空昵称 400; 无字段 400; 更新成功回 avatar_url', async () => {
  const anon = makeEnv({ db: baseDb() });
  assert.equal((await postJson('/user/get_user_info', {}, anon.env)).msg, '未授权，请先登录');

  const env = makeEnv({ db: baseDb() }).env;
  assert.equal((await postJson('/user/update_profile', { token: 'tok-1' }, env)).msg, '没有提供要更新的数据');
  assert.equal((await postJson('/user/update_profile', { token: 'tok-1', nickname: '   ' }, env)).msg, '昵称不能为空或只包含空格');
  const info = await postJson('/user/get_user_info', { token: 'tok-1' }, env);
  assert.equal(info.msg, '获取用户信息成功');
  assert.equal(info.data.username, 'wx_abc12345');
  assert.equal(info.data.avatar, 'https://media.test/avatar_uploads/a.png');
  assert.ok(!('token' in info.data));

  const updated = await postJson('/user/update_profile', { token: 'tok-1', nickname: '新昵称' }, env);
  assert.equal(updated.msg, '资料更新成功');
  assert.equal(updated.data.nickname, '新昵称');
  assert.ok(updated.data.avatar_url);
});

test('头像上传: 非图片扩展名 400, 正常 multipart 落 R2 并回绝对地址', async () => {
  const { env } = makeEnv({ db: baseDb() });

  const badForm = new FormData();
  badForm.append('token', 'tok-1');
  badForm.append('avatar', new File([new Uint8Array([1, 2, 3])], 'a.txt', { type: 'text/plain' }));
  const bad = await (await (await import('./stub.mjs')).request('/user/upload_avatar', { method: 'POST', env, body: badForm, headers: {} })).json();
  assert.equal(bad.msg, '只支持JPG、PNG和GIF格式的图片');

  const form = new FormData();
  form.append('token', 'tok-1');
  form.append('avatar', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3])], 'a.jpg', { type: 'image/jpeg' }));
  const ok = await (await (await import('./stub.mjs')).request('/user/upload_avatar', { method: 'POST', env, body: form, headers: {} })).json();
  assert.equal(ok.msg, '头像上传成功');
  assert.match(ok.data.avatar_url, /^https:\/\/media\.test\/avatar\/avatar_7_\d+\.jpg$/, '头像落 avatar/ 目录');
});

test('昵称状态后缀: 半角括号, 注销/恢复都基于真实原昵称重算', async () => {
  const env = makeEnv({ db: baseDb() }).env;
  await postJson('/user/delete_account', { token: 'tok-1', confirm: 'yes' }, env);
  const calls = makeEnv({ db: baseDb() });
  await postJson('/user/delete_account', { token: 'tok-1', confirm: 'yes' }, calls.env);
  const update = calls.calls.find((item) => /UPDATE users SET status=1/i.test(item.sql));
  assert.ok(update, '应有注销的 UPDATE');
  assert.equal(update.args[1], '老王(已注销)');
  assert.equal(update.args[2], '老王');
  assert.match(update.sql, /raw_nickname=/);
  assert.ok(!/nickname_raw=/.test(update.sql));

  const restoreEnv = makeEnv({
    db: (sql, args, kind) => {
      if (/FROM users WHERE openid=/i.test(sql)) {
        return Object.assign({}, USER_ROW, { status: 1, nickname: '老王(已注销)', raw_nickname: '老王' });
      }
      return baseDb()(sql, args, kind);
    }
  });
  const restored = await postJson('/user/deleted_account_action', { action: 'restore', code: 'c' }, restoreEnv.env);
  assert.equal(restored.msg, '账号已恢复');
  const restoreUpdate = restoreEnv.calls.find((item) => /UPDATE users SET status=0/i.test(item.sql));
  assert.equal(restoreUpdate.args[0], '老王(已恢复)');
  assert.equal(restoreUpdate.args[1], '老王');
});

test('改昵称: 已注销账号回传带后缀的展示名视为没改, 真改名才写库', async () => {
  const restored = makeEnv({
    db: (sql, args, kind) => {
      if (/FROM users WHERE token=/i.test(sql)) {
        return Object.assign({}, USER_ROW, { nickname: '老王(已恢复)', raw_nickname: '老王', deleted_at: '2026-10-01 00:00:00' });
      }
      return baseDb()(sql, args, kind);
    }
  });
  const noChange = await postJson('/user/update_profile', { token: 'tok-1', nickname: '老王(已恢复)' }, restored.env);
  assert.equal(noChange.msg, '资料未发生变化');
  assert.equal(restored.calls.some((item) => /SET nickname=/i.test(item.sql)), false);

  const renamed = makeEnv({
    db: (sql, args, kind) => {
      if (/FROM users WHERE token=/i.test(sql)) {
        return Object.assign({}, USER_ROW, { nickname: '老王(已恢复)', raw_nickname: '老王', deleted_at: '2026-10-01 00:00:00' });
      }
      return baseDb()(sql, args, kind);
    }
  });
  const changed = await postJson('/user/update_profile', { token: 'tok-1', nickname: '新名字' }, renamed.env);
  assert.equal(changed.msg, '资料更新成功');
  assert.equal(changed.data.nickname, '新名字');
  const write = renamed.calls.find((item) => /SET nickname=/i.test(item.sql));
  assert.equal(write.args[0], '新名字');
  assert.equal(write.args[1], '新名字');
  assert.match(write.sql, /nickname_modified=1/);
  assert.match(write.sql, /raw_nickname=/);
});

test('注销与后续动作: 需确认 / 已注销 / defer / restore / purge', async () => {
  const env = makeEnv({ db: baseDb() }).env;
  assert.equal((await postJson('/user/delete_account', { token: 'tok-1' }, env)).msg, '请先在页面确认注销');
  assert.equal((await postJson('/user/delete_account', { token: 'tok-1', confirm: 'yes' }, env)).msg, '账号已注销');
  const already = await postJson('/user/delete_account', { token: 'tok-1', confirm: '1' },
    makeEnv({ db: (sql, args, kind) => (kind === 'first' && /FROM users WHERE token=/i.test(sql) ? Object.assign({}, USER_ROW, { status: 1 }) : baseDb()(sql, args, kind)) }).env);
  assert.equal(already.msg, '账号已注销');

  assert.equal((await postJson('/user/deleted_account_action', { action: 'x', code: 'c' }, env)).msg, '操作类型错误');
  assert.equal((await postJson('/user/deleted_account_action', { action: 'defer' }, env)).msg, '参数错误：缺少code');

  const deletedUser = makeEnv({
    db: (sql, args, kind) => {
      if (/FROM users WHERE openid=/i.test(sql)) return Object.assign({}, USER_ROW, { status: 1 });
      return baseDb()(sql, args, kind);
    }
  });
  const defer = await postJson('/user/deleted_account_action', { action: 'defer', code: 'c' }, deletedUser.env);
  assert.equal(defer.msg, '已保持注销态');
  assert.equal(defer.data.account_deleted, true);

  const restore = await postJson('/user/deleted_account_action', { action: 'restore', code: 'c' }, deletedUser.env);
  assert.equal(restore.msg, '账号已恢复');
  assert.ok(restore.data.token);

  const purge = await postJson('/user/deleted_account_action', { action: 'purge', code: 'c' }, deletedUser.env);
  assert.equal(purge.msg, '账号已彻底删除');

  const stale = await postJson('/user/deleted_account_action', { action: 'defer', code: 'c' },
    makeEnv({ db: (sql, args, kind) => (/FROM users WHERE openid=/i.test(sql) ? Object.assign({}, USER_ROW, { status: 0 }) : baseDb()(sql, args, kind)) }).env);
  assert.equal(stale.code, 409);
});

test('收藏/点赞/历史列表: 时间转 Unix 秒, has_more 按行数判定', async () => {
  const row = {
    id: 5, title: '标题', desc: '', image: 'news_uploads/home/a.jpg', video_url: '', category: 'outdoor',
    type: 'users', status: 'approved', publish_time: '2026-10-01 10:00:00', activity_time: '',
    view_count: 1, likes: 1, favorites: 1, shares: 0, user_id: 7,
    relation_time: '2026-10-02 10:00:00', relation_id: 99
  };
  const env = makeEnv({
    db: (sql, args, kind) => {
      if (/FROM news_favorites/i.test(sql) && kind === 'all') return { all: [row] };
      if (/FROM news WHERE id=\? AND deleted_at IS NULL/i.test(sql) && kind === 'first') return { id: 5 };
      if (/FROM news_view_history WHERE news_id=\? AND user_id=\?/i.test(sql) && kind === 'first') return { id: 99 };
      return baseDb()(sql, args, kind);
    }
  }).env;

  const favorites = await postJson('/user/user_favorites', { token: 'tok-1', action: 'get', page: 1, page_size: 10 }, env);
  assert.equal(favorites.code, 200);
  assert.equal(favorites.data.favorites[0].favorite_time, Date.UTC(2026, 9, 2, 2, 0, 0) / 1000);
  assert.equal(favorites.data.favorites[0].publish_time, Date.UTC(2026, 9, 1, 2, 0, 0) / 1000);
  assert.equal(favorites.data.favorites[0].is_favorited, 1);
  assert.equal(favorites.data.has_more, false);

  const added = await postJson('/user/user_view_history', { token: 'tok-1', action: 'add', content_id: 5 }, env);
  assert.equal(added.data.view_count, 5);
  const cancelled = await postJson('/user/user_view_history', { token: 'tok-1', action: 'cancel', content_id: 5 }, env);
  assert.equal(cancelled.msg, '记录已删除');
  const unauthorized = await postJson('/user/user_likes', {}, env);
  assert.equal(unauthorized.code, 401);
});
