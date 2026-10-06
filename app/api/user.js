// 用户相关 9 条: login / get_user_info / update_profile / upload_avatar / delete_account /
// deleted_account_action / user_favorites / user_likes / user_view_history
import { fail, ok } from '../core/response.js';
import { all, idList, intOf, one, run, str } from '../core/db.js';
import { assetUrl, mediaBase, putObject } from '../core/media_scheme.js';
import { AVATAR_PREFIX } from '../core/storage.js';
import { settings } from '../core/config.js';
import { AUTH_MESSAGES, currentUser, tokenOf } from './helpers.js';
import { MAX_NICKNAME_LEN } from './schemas.js';
import { md5Hex } from '../core/md5.js';
import { beijingNow, nowEpoch, toEpoch } from '../core/timeutil.js';
import { code2Session, nicknameAllowed } from '../core/wechat.js';
import { LOGIN_LIMIT, QUOTAS, checkQuota, loginClearStatement, loginFailStatement, loginLockState, quotaStatement, userKey } from '../core/ratelimit.js';

const DEFAULT_AVATAR = '/images/user.jpg';
const COMMENT_LIKE_COLUMNS = 'n.id,n.title,n.desc,n.image,n.video_url,n.category,n.type,n.status,n.publish_time,n.activity_time,n.view_count,n.likes,n.favorites,n.shares,n.user_id';
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif'];

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 账号状态后缀: 与旧站一字不差(半角括号), 数据库里的展示名就是"原昵称+后缀"
const STATE_SUFFIX_DELETED = '(已注销)';
const STATE_SUFFIX_RESTORED = '(已恢复)';
const STATE_SUFFIXES = [STATE_SUFFIX_DELETED, STATE_SUFFIX_RESTORED];

// 昵称清洗: 去控制字符、折成单空格; 不在这里截断(截断要放在剥离状态后缀之后)
function cleanNickname(value) {
  const text = String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '');
  return text.replace(/\s+/g, ' ').trim();
}

// 剥掉末尾连续的状态后缀(只认末尾, 与旧站 strip_account_state_suffix 同口径)
function stripStateSuffix(value) {
  let text = String(value === undefined || value === null ? '' : value).trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of STATE_SUFFIXES) {
      if (text.endsWith(suffix)) {
        text = text.slice(0, -suffix.length).trim();
        changed = true;
      }
    }
  }
  return text;
}

// 真实原昵称(昵称计算的唯一基准): raw_nickname 优先, 为空时从展示名剥离兜底
function rawNicknameOf(row) {
  const raw = String((row && row.raw_nickname) || '').trim();
  if (raw) return raw;
  const stripped = stripStateSuffix(row && row.nickname);
  if (stripped) return stripped;
  return String((row && (row.orig_nickname || row.nickname)) || '').trim();
}

// 头像入库值: 完整地址里带本站域名时转成相对路径, 其它原样保留
function storedAvatar(value, env) {
  const text = str(value).trim();
  if (!text) return '';
  const base = mediaBase(env);
  if (base && text.startsWith(`${base}/`)) return text.slice(base.length + 1);
  return text;
}

function publicUser(env, row) {
  return {
    id: row.id,
    username: str(row.username),
    nickname: str(row.nickname),
    // 接口字段 nickname_raw = 剥掉状态后缀的干净昵称(旧站同一口径), 数据库列名是 raw_nickname
    nickname_raw: rawNicknameOf(row),
    avatar: assetUrl(env, row.avatar || DEFAULT_AVATAR),
    login_type: str(row.login_type) || 'wechat',
    is_trusted: Number(row.is_trusted) || 0,
    token: row.token === undefined || row.token === null ? null : String(row.token)
  };
}

async function userByOpenId(env, openid) {
  if (!openid) return null;
  return await one(env, 'SELECT * FROM users WHERE openid=? LIMIT 1', openid);
}

async function userById(env, id) {
  return await one(env, 'SELECT * FROM users WHERE id=? LIMIT 1', id);
}

async function loginUser(env, body) {
  const loginType = str(body.login_type) || 'wechat';
  if (loginType === 'account') throw new HttpError(400, '已停止支持账号密码登录，请使用微信登录');
  if (loginType !== 'wechat') throw new HttpError(400, '未知的登录类型');
  const code = str(body.code).trim();
  if (!code) throw new HttpError(400, '参数错误：缺少code');

  const session = await code2Session(env, code);
  if (!session || !session.openid) throw new HttpError(500, '微信登录失败，请稍后重试');

  const nickname = cleanNickname(body.nickname);
  const avatar = storedAvatar(body.avatar, env);
  const now = beijingNow();
  const existing = await userByOpenId(env, session.openid);

  if (!existing) {
    const username = `wx_${md5Hex(session.openid).slice(0, 8)}`;
    const token = newToken();
    const finalNickname = nickname || username;
    try {
      const result = await run(env,
        'INSERT INTO users (username,openid,nickname,raw_nickname,avatar,login_type,token,create_time,last_login_time) '
        + 'VALUES (?,?,?,?,?,?,?,?,?)',
        username, session.openid, finalNickname, finalNickname, avatar || DEFAULT_AVATAR, 'wechat', token, now, now);
      const created = await userById(env, Number(result && result.meta && result.meta.last_row_id) || 0);
      if (created) return { user: publicUser(env, created) };
    } catch (error) {
      // 并发注册: 唯一键冲突后回查并回写 token
      const again = await userByOpenId(env, session.openid);
      if (!again) throw error;
      await run(env, 'UPDATE users SET token=?, last_login_time=? WHERE id=?', token, now, again.id);
      return { user: publicUser(env, Object.assign({}, again, { token })) };
    }
  }

  if (Number(existing.status) !== 0) {
    return { account_deleted: true, user: publicUser(env, existing) };
  }

  const token = newToken();
  const nextNickname = (!str(existing.nickname) || str(existing.nickname) === str(existing.username))
    ? (nickname || str(existing.username)) : null;
  const nextRaw = nextNickname || null;
  await run(env,
    'UPDATE users SET token=?, login_type=?, last_login_time=?, '
    + 'nickname=COALESCE(?,nickname), raw_nickname=COALESCE(?,raw_nickname), avatar=COALESCE(NULLIF(?,\'\'),avatar) WHERE id=?',
    token, 'wechat', now, nextNickname, nextRaw, avatar, existing.id);
  const fresh = await userById(env, existing.id);
  return { user: publicUser(env, fresh || existing) };
}

async function restoreUser(env, row) {
  // 昵称重算的唯一基准是真实原昵称; 头像不动(与旧站一致)
  const raw = rawNicknameOf(row);
  const nickname = `${raw}${STATE_SUFFIX_RESTORED}`;
  const token = newToken();
  await run(env, 'UPDATE users SET status=0, deleted_at=NULL, nickname=?, raw_nickname=?, token=?, last_login_time=? WHERE id=?',
    nickname, raw, token, beijingNow(), row.id);
  const fresh = await userById(env, row.id);
  return publicUser(env, fresh || Object.assign({}, row, { token }));
}

async function purgeUser(env, row) {
  const stats = {};
  const notes = await all(env, 'SELECT id FROM news WHERE user_id=?', row.id);
  const newsIds = notes.map((item) => Number(item.id));
  const statements = [];
  for (const table of ['news_likes', 'news_favorites', 'news_view_history', 'news_shares', 'news_comments']) {
    if (newsIds.length) {
      const marks = newsIds.map(() => '?').join(',');
      statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE news_id IN (${marks})`).bind(...newsIds));
    }
    statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE user_id=?`).bind(row.id));
  }
  if (newsIds.length) {
    const marks = newsIds.map(() => '?').join(',');
    statements.push(env.DB.prepare(`DELETE FROM news WHERE id IN (${marks})`).bind(...newsIds));
  }
  statements.push(env.DB.prepare('DELETE FROM app_notice_reads WHERE user_id=?').bind(row.id));
  statements.push(env.DB.prepare('DELETE FROM users WHERE id=?').bind(row.id));
  await env.DB.batch(statements);
  stats.news = newsIds.length;
  return stats;
}

export function registerUserRoutes(router) {
  // ---------------- 登录 ----------------
  router.post('/user/login', async (request, env, ctx, args) => {
    const body = args.body || {};
    try {
      const lock = await loginLockState(env, request).catch(() => ({ locked: false }));
      if (lock.locked) return fail(429, '登录尝试过于频繁，请稍后再试');
      const outcome = await loginUser(env, body);
      if (outcome.account_deleted) {
        return fail(409, '此账号已注销，请选择后续操作', { data: { account_deleted: true } });
      }
      await env.DB.batch([loginClearStatement(env, request)]).catch(() => null);
      return ok(outcome.user, '登录成功');
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.code >= 500) return fail(error.code, error.message);
        await env.DB.batch([loginFailStatement(env, request)]).catch(() => null);
        return fail(error.code, error.message);
      }
      return fail(500, '微信登录失败，请稍后重试');
    }
  });

  // ---------------- 资料 ----------------
  router.post('/user/get_user_info', async (request, env, ctx, args) => {
    const body = args.body || {};
    const token = tokenOf(request, body);
    if (!token) return fail(401, AUTH_MESSAGES.needLogin);
    try {
      const user = await currentUser(env, request, body);
      if (!user) return fail(401, AUTH_MESSAGES.expired);
      const payload = publicUser(env, user);
      delete payload.token;
      return ok(payload, '获取用户信息成功');
    } catch (error) {
      return fail(503, '服务繁忙，请稍后重试');
    }
  });

  router.post('/user/update_profile', async (request, env, ctx, args) => {
    const body = args.body || {};
    const user = await currentUser(env, request, body).catch(() => null);
    if (!user) return fail(401, AUTH_MESSAGES.expired);

    const hasNickname = body.nickname !== undefined;
    const hasAvatar = body.avatar !== undefined;
    if (!hasNickname && !hasAvatar) return fail(400, '没有提供要更新的数据');

    // 顺序不能反: 先剥离状态后缀, 再限长(反了会把后缀截成半个, 剥离永远不命中)
    const submittedPlain = hasNickname ? cleanNickname(body.nickname) : '';
    let nickname = submittedPlain;
    if (hasNickname && user.deleted_at) nickname = stripStateSuffix(nickname);
    if (hasNickname) nickname = nickname.slice(0, MAX_NICKNAME_LEN);
    if (hasNickname && !nickname) return fail(400, '昵称不能为空或只包含空格');

    let avatar = '';
    if (hasAvatar) {
      avatar = storedAvatar(body.avatar, env);
      if (!avatar) return fail(400, '头像地址不合法');
    }

    const dbDisplay = str(user.nickname).trim();
    const rawNow = rawNicknameOf(user);
    // "改没改"的三条判据(与旧站一致): 原样回传展示名 / 结果等于库值 / 带后缀痕迹且回到真实原昵称
    const markInSubmitted = STATE_SUFFIXES.some((suffix) => submittedPlain.includes(suffix));
    const nicknameChanged = !!nickname && !(
      submittedPlain === dbDisplay
      || nickname === dbDisplay
      || (markInSubmitted && nickname === rawNow)
    );
    const avatarChanged = !!avatar && avatar !== str(user.avatar);

    if (!nicknameChanged && !avatarChanged) {
      // 昵称没变但基准为空(极老数据)时顺手补上, 与旧站一致
      if (nickname && !str(user.raw_nickname).trim()) {
        await run(env, 'UPDATE users SET raw_nickname=? WHERE id=?', nickname, user.id).catch(() => null);
      }
      return ok({}, '资料未发生变化');
    }

    if (nicknameChanged) {
      const review = await nicknameAllowed(env, nickname);
      if (!review.ok) return fail(400, review.reason || '昵称未通过内容安全校验，请修改后重试');
    }

    try {
      if (nicknameChanged) {
        // 昵称与基准一起写, 并记下"用户已自行设置过昵称"(之后注销/恢复不再拼后缀)
        await run(env, 'UPDATE users SET nickname=?, raw_nickname=?, nickname_modified=1 WHERE id=?',
          nickname, nickname, user.id);
      }
      if (avatarChanged) await run(env, 'UPDATE users SET avatar=? WHERE id=?', avatar, user.id);
    } catch (error) {
      return fail(500, '服务器错误，请稍后重试');
    }

    const data = { avatar_url: assetUrl(env, avatarChanged ? avatar : user.avatar || DEFAULT_AVATAR) };
    if (nicknameChanged) data.nickname = nickname;
    return ok(data, '资料更新成功');
  });

  // ---------------- 头像上传(Worker 中转写 R2) ----------------
  router.post('/user/upload_avatar', async (request, env, ctx, args) => {
    const form = (args && args.form) || await request.formData().catch(() => null);
    if (!form) return fail(400, '请选择要上传的图片');
    const token = str(form.get('token'));
    if (!token) return fail(401, AUTH_MESSAGES.actionNeedLogin);
    const user = await currentUser(env, request, { token }).catch(() => null);
    if (!user) return fail(401, AUTH_MESSAGES.expired);

    const quota = await checkQuota(env, 'avatar', userKey(user.id), QUOTAS.avatar).catch(() => ({ allowed: true }));
    if (!quota.allowed) return fail(429, quota.message);

    const file = form.get('avatar');
    if (!file || typeof file === 'string' || !file.name) return fail(400, '请选择要上传的图片');
    const ext = String(file.name).split('.').pop().toLowerCase();
    if (!IMAGE_EXT.includes(ext)) return fail(400, '只支持JPG、PNG和GIF格式的图片');

    const maxBytes = settings(env).uploadMaxBytes;
    const bytes = await file.arrayBuffer();
    if (!bytes.byteLength) return fail(400, '上传文件为空');
    if (bytes.byteLength > maxBytes) {
      return fail(400, `图片大小超出限制(最大${Math.round(maxBytes / 1048576)}MB)`);
    }
    if (!looksLikeImage(new Uint8Array(bytes))) return fail(400, '文件内容不是有效图片');

    // 头像落 avatar/ 目录(历史头像仍在 avatar_uploads/, 两边都能直出, 老数据不用迁)
    const key = `${AVATAR_PREFIX}avatar_${user.id}_${nowEpoch()}.${ext}`;
    try {
      await putObject(env, key, bytes, file.type || `image/${ext}`);
      await run(env, 'UPDATE users SET avatar=? WHERE id=?', key, user.id);
      await env.DB.batch([quotaStatement(env, 'avatar', userKey(user.id), QUOTAS.avatar)]);
      return ok({ avatar_url: assetUrl(env, key) }, '头像上传成功');
    } catch (error) {
      return fail(500, '头像上传失败，请稍后重试');
    }
  });

  // ---------------- 注销与后续动作 ----------------
  router.post('/user/delete_account', async (request, env, ctx, args) => {
    const body = args.body || {};
    const confirm = str(body.confirm).toLowerCase();
    if (!['yes', '1', 'true'].includes(confirm)) return fail(400, '请先在页面确认注销');
    const user = await currentUser(env, request, body).catch(() => null);
    if (!user) return fail(401, AUTH_MESSAGES.needLogin);
    if (Number(user.status) !== 0) return ok(null, '账号已注销');
    try {
      // 基准永远是真实原昵称, 绝不基于 nickname 旧值拼接(否则反复注销会叠后缀)
      const raw = rawNicknameOf(user) || str(user.username);
      await run(env,
        'UPDATE users SET status=1, deleted_at=?, token=NULL, nickname=?, raw_nickname=?, nickname_modified=0 WHERE id=?',
        beijingNow(), `${raw}${STATE_SUFFIX_DELETED}`, raw, user.id);
      return ok(null, '账号已注销');
    } catch (error) {
      return fail(500, '服务器错误，请稍后重试');
    }
  });

  router.post('/user/deleted_account_action', async (request, env, ctx, args) => {
    const body = args.body || {};
    const action = str(body.action);
    if (!['defer', 'restore', 'purge'].includes(action)) return fail(400, '操作类型错误');
    const code = str(body.code).trim();
    if (!code) return fail(400, '参数错误：缺少code');
    const session = await code2Session(env, code);
    if (!session || !session.openid) return fail(500, '微信登录失败，请稍后重试');
    const user = await userByOpenId(env, session.openid);
    if (!user) return fail(404, '未找到对应的账号，请重新登录');
    if (Number(user.status) === 0) return fail(409, '该账号状态已变更，请重新登录');

    if (action === 'defer') return ok({ account_deleted: true }, '已保持注销态');
    if (action === 'restore') {
      try {
        const restored = await restoreUser(env, user);
        return ok(restored, '账号已恢复');
      } catch (error) {
        return fail(500, '服务器错误，请稍后重试');
      }
    }
    try {
      const stats = await purgeUser(env, user);
      return ok({ deleted: stats }, '账号已彻底删除');
    } catch (error) {
      return fail(500, '服务器错误，请稍后重试');
    }
  });

  // ---------------- 收藏 / 点赞 / 浏览历史 ----------------
  const listHandler = (kind) => async (request, env, ctx, args) => {
    const body = args.body || {};
    const user = await currentUser(env, request, body).catch(() => null);
    if (!user) return fail(401, kind === 'history' ? '未登录' : AUTH_MESSAGES.needLogin);
    const action = str(body.action) || 'get';
    const table = kind === 'favorites' ? 'news_favorites' : kind === 'likes' ? 'news_likes' : 'news_view_history';
    const dataKey = kind === 'favorites' ? 'favorites' : kind === 'likes' ? 'likes' : 'views';
    const contentId = intOf(body.content_id || body.news_id);

    if (action === 'get') {
      let page = Math.max(1, intOf(body.page, 1) || 1);
      let size = intOf(body.page_size || body.pageSize, 10);
      if (size <= 0) size = 10;
      if (size > 50) size = 50;
      try {
        const rows = await all(env,
          `SELECT ${COMMENT_LIKE_COLUMNS}, r.created_at AS relation_time, r.id AS relation_id `
          + `FROM ${table} r JOIN news n ON n.id = r.news_id `
          + 'WHERE r.user_id=? ORDER BY r.created_at DESC LIMIT ? OFFSET ?',
          user.id, size, (page - 1) * size);
        const list = rows.map((row) => {
          const item = Object.assign({}, row);
          delete item.relation_time;
          delete item.relation_id;
          if (item.image) item.image = assetUrl(env, item.image);
          if (item.video_url) item.video_url = assetUrl(env, item.video_url);
          // 时间列统一给 Unix 秒(旧站口径)
          item.publish_time = toEpoch(item.publish_time);
          item.activity_time = toEpoch(item.activity_time);
          if (kind === 'favorites') {
            item.favorite_time = toEpoch(row.relation_time);
            item.is_favorited = 1;
          } else if (kind === 'likes') {
            item.like_time = toEpoch(row.relation_time);
            item.is_liked = 1;
          } else {
            item.news_id = Number(row.id);
            item.view_time = toEpoch(row.relation_time);
            item.view_id = Number(row.relation_id);
          }
          return item;
        });
        return ok({ [dataKey]: list, page, page_size: size, has_more: rows.length >= size });
      } catch (error) {
        return fail(kind === 'history' ? 402 : 500, '服务器错误，请稍后重试');
      }
    }

    if (!['add', 'cancel'].includes(action)) return fail(400, '操作类型错误');
    if (contentId <= 0) return fail(kind === 'history' ? 402 : 400, '参数错误');

    if (action === 'add') {
      const quota = await checkQuota(env, 'view_history', userKey(user.id)).catch(() => ({ allowed: true }));
      if (kind === 'history') {
        if (!quota.allowed) return fail(429, quota.message);
        const note = await one(env, 'SELECT id FROM news WHERE id=? AND deleted_at IS NULL', contentId);
        if (!note) return fail(404, '笔记不存在或已删除');
        const existing = await one(env, 'SELECT id FROM news_view_history WHERE news_id=? AND user_id=?', contentId, user.id);
        const statements = [];
        if (existing) {
          statements.push(env.DB.prepare('UPDATE news_view_history SET created_at=? WHERE id=?').bind(beijingNow(), existing.id));
        } else {
          statements.push(env.DB.prepare('INSERT OR IGNORE INTO news_view_history (news_id,user_id,created_at) VALUES (?,?,?)')
            .bind(contentId, user.id, beijingNow()));
        }
        statements.push(quotaStatement(env, 'view_history', userKey(user.id), QUOTAS.view_history));
        await env.DB.batch(statements);
        const row = await one(env, 'SELECT view_count FROM news WHERE id=?', contentId);
        return ok({ view_count: Number(row && row.view_count) || 0 });
      }
      const label = kind === 'favorites' ? '收藏' : '点赞';
      const counter = kind === 'favorites' ? 'favorites' : 'likes';
      if (!quota.allowed) return fail(429, quota.message);
      const note = await one(env, 'SELECT id FROM news WHERE id=? AND deleted_at IS NULL', contentId);
      if (!note) return fail(404, '笔记不存在或已删除');
      try {
        // 必须 OR IGNORE: 唯一索引冲突在 D1 上是抛错, 不是 0 行
        const result = await run(env, `INSERT OR IGNORE INTO ${table} (news_id,user_id,created_at) VALUES (?,?,?)`,
          contentId, user.id, beijingNow());
        if (!result || !result.meta || Number(result.meta.changes) < 1) {
          return fail(403, `您已经${label}过该笔记了`);
        }
        await env.DB.batch([
          quotaStatement(env, kind, userKey(user.id), QUOTAS[kind]),
          env.DB.prepare(`UPDATE news SET ${counter}=COALESCE(${counter},0)+1 WHERE id=?`).bind(contentId)
        ]);
      } catch (error) {
        return fail(500, '服务器错误，请稍后重试');
      }
      return ok(null);
    }

    // cancel
    try {
      const result = await run(env, `DELETE FROM ${table} WHERE news_id=? AND user_id=?`, contentId, user.id);
      if (!result || !result.meta || Number(result.meta.changes) < 1) {
        return fail(kind === 'history' ? 402 : 403, '记录不存在');
      }
      if (kind !== 'history') {
        const counter = kind === 'favorites' ? 'favorites' : 'likes';
        await run(env, `UPDATE news SET ${counter}=CASE WHEN COALESCE(${counter},0)>0 THEN ${counter}-1 ELSE 0 END WHERE id=?`, contentId);
      }
      return ok(null, '记录已删除');
    } catch (error) {
      return fail(kind === 'history' ? 402 : 500, '服务器错误，请稍后重试');
    }
  };

  router.post('/user/user_favorites', listHandler('favorites'));
  router.post('/user/user_likes', listHandler('likes'));
  router.post('/user/user_view_history', listHandler('history'));
}

// 文件头魔数嗅探: JPG / PNG / GIF
function looksLikeImage(bytes) {
  if (bytes.length < 8) return false;
  const [a, b, c, d, e, f] = bytes;
  if (a === 0xff && b === 0xd8 && c === 0xff) return true;
  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return true;
  if (a === 0x47 && b === 0x49 && c === 0x46 && d === 0x38) return true;
  if (a === 0x52 && b === 0x49 && c === 0x46 && d === 0x46 && e === 0x57 && f === 0x45) return true;
  return false;
}
