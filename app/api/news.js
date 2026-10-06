// 笔记相关 9 条: list / detail / like / favorite / share / add_comment / get_comments / check_user_action / check_user_like_batch
import { fail, failList, json, ok } from '../core/response.js';
import { all, idList, intOf, one, run, str } from '../core/db.js';
import { assetUrl, existingThumbs, thumbKey } from '../core/media_scheme.js';
import { AUTH_MESSAGES, currentUser, identity, tokenOf } from './helpers.js';
import { MAX_BATCH_NEWS_IDS, MAX_COMMENT_LENGTH, PAGE_MAX, clampPage } from './schemas.js';
import { absolutizeImages, sanitizeHtml } from '../core/sanitize.js';
import { beijingNow } from '../core/timeutil.js';
import { QUOTAS, checkQuota, quotaStatement, userKey } from '../core/ratelimit.js';

const LIST_COLUMNS = 'id,title,desc,image,video_url,category,type,status,publish_time,activity_time,view_count,likes,favorites,shares,user_id';
// 留言长度 / 批量上限 / 分页夹取的口径统一在 api/schemas.js(对照旧站 app/api/schemas.py)

async function activeCategories(env) {
  try {
    const rows = await all(env, 'SELECT category_key FROM app_categories WHERE status=1');
    return new Set(rows.map((row) => str(row.category_key).toLowerCase()));
  } catch (error) {
    return new Set(['outdoor', 'motorcycle', 'fitness', 'skateboard', 'football', 'swimming', 'diving', 'food', 'other']);
  }
}

function mapListRow(row, env) {
  const out = Object.assign({}, row);
  if (out.image) out.image = assetUrl(env, out.image);
  if (out.video_url) out.video_url = assetUrl(env, out.video_url);
  return out;
}

export function registerNewsRoutes(router) {
  // ---------------- 列表 ----------------
  router.get('/news/list', async (request, env) => {
    try {
      const url = new URL(request.url);
      const body = Object.fromEntries(url.searchParams.entries());
      // 旧站口径: 默认 0 = 不分页(返回全部, 最多 200 条); >0 时夹到 PAGE_MAX(1000)
      let page = intOf(body.page, 0);
      if (page > PAGE_MAX) page = PAGE_MAX;
      let size = intOf(body.page_size || body.pageSize || body.limit, 10);
      if (size > 50) size = 50;
      if (size <= 0) size = 10;
      const rawCategory = str(body.category || body.category_id).toLowerCase();
      const categories = await activeCategories(env);
      const category = rawCategory && categories.has(rawCategory) ? rawCategory : '';

      const params = [];
      let where = "status='approved' AND deleted_at IS NULL AND type IN ('admin_users','users')";
      if (category) {
        where += ' AND category=?';
        params.push(category);
      }

      if (page <= 0) {
        const rows = await all(env,
          `SELECT ${LIST_COLUMNS} FROM news WHERE ${where} ORDER BY publish_time DESC, id DESC LIMIT ?`,
          ...params, MAX_BATCH_NEWS_IDS);
        const viewer = await currentUser(env, request, body);
        const liked = await likedIds(env, viewer, rows);
        return json({ code: 200, data: rows.map((row) => withLiked(mapListRow(row, env), liked)) });
      }

      const total = Number((await one(env,
        `SELECT COUNT(*) AS c FROM news WHERE ${where}`, ...params)).c) || 0;
      const rows = await all(env,
        `SELECT ${LIST_COLUMNS} FROM news WHERE ${where} ORDER BY publish_time DESC, id DESC LIMIT ? OFFSET ?`,
        ...params, size, (page - 1) * size);
      const viewer = await currentUser(env, request, body);
      const liked = await likedIds(env, viewer, rows);
      const thumbs = await existingThumbs(env, rows);
      const list = rows.map((row, index) => {
        const mapped = withLiked(mapListRow(row, env), liked);
        // 缩略图存在才加这个键(旧站行为: 不存在则键完全不出现, 小程序回退原图)
        if (thumbs[index]) mapped.image_thumb = assetUrl(env, thumbKey(row.image));
        return mapped;
      });
      return json({
        code: 200,
        msg: '获取成功',
        data: { list, total, page, page_size: size, has_more: page * size < total }
      });
    } catch (error) {
      return failList(500, '服务器错误，请稍后重试');
    }
  });

  // ---------------- 详情 ----------------
  router.get('/news/detail', async (request, env) => {
    const url = new URL(request.url);
    const body = Object.fromEntries(url.searchParams.entries());
    const id = intOf(body.id);
    if (id <= 0) return json({ code: 400, msg: '参数错误' });
    try {
      const token = tokenOf(request, body);
      const item = await one(env,
        'SELECT n.*, au.username AS author, au.nickname AS author_nickname, '
        + '(SELECT id FROM users WHERE token=? LIMIT 1) AS viewer_id '
        + 'FROM news n LEFT JOIN users au ON au.id=n.user_id '
        + "WHERE n.id=? AND n.status='approved' AND n.deleted_at IS NULL", token, id);
      if (!item) return json({ code: 404, msg: '笔记不存在或未通过审核' });

      const viewerId = Number(item.viewer_id) || 0;
      const authorId = Number(item.user_id) || 0;
      // 浏览量自增: 作者自己不计数, 同一访客 60 秒内只计一次
      const view = viewerId
        ? await one(env, 'SELECT id, created_at FROM news_view_history WHERE news_id=? AND user_id=?', id, viewerId)
        : null;
      const recentlyViewed = !!(view && view.created_at
        && (Date.now() - new Date(`${String(view.created_at).replace(' ', 'T')}+08:00`).getTime()) < 60000);
      if (viewerId !== authorId && !recentlyViewed) {
        await run(env, 'UPDATE news SET view_count=COALESCE(view_count,0)+1 WHERE id=?', id);
        item.view_count = (Number(item.view_count) || 0) + 1;
      }

      const data = Object.assign({}, item);
      delete data.viewer_id;
      delete data.author;
      delete data.author_nickname;
      if (data.image) data.image = assetUrl(env, data.image);
      if (data.video_url) data.video_url = assetUrl(env, data.video_url);
      data.content = absolutizeImages(env, sanitizeHtml(data.content));

      // 作者信息: 三种情况与旧站一致(含 is_admin 键不出现的情况)
      if (authorId && item.author) {
        data.author = item.author;
        data.author_nickname = item.author_nickname === undefined ? null : item.author_nickname;
        data.is_admin = str(item.type) !== 'users';
      } else if (authorId && !item.author) {
        data.author_nickname = item.author_nickname === undefined ? null : item.author_nickname;
      } else {
        data.is_admin = true;
      }

      const state = await userActionState(env, viewerId, id);
      Object.assign(data, state);
      return json({ code: 200, msg: '获取成功', data });
    } catch (error) {
      return json({ code: 500, msg: '服务器错误，请稍后重试' });
    }
  });

  // ---------------- 点赞 / 收藏 ----------------
  router.post('/news/like', (request, env, ctx, args) => toggleHandler(request, env, args, 'like'));
  router.post('/news/favorite', (request, env, ctx, args) => toggleHandler(request, env, args, 'favorite'));

  async function toggleHandler(request, env, args, kind) {
    const body = args.body || {};
    const newsId = intOf(body.news_id);
    const action = str(body.action);
    if (newsId <= 0 || !action) return fail(400, '参数错误');
    if (!['add', 'remove'].includes(action)) return fail(400, '操作类型错误');

    const auth = await identity(request, env, body, true);
    if (!auth.ok) return fail(auth.code, auth.message);

    const table = kind === 'like' ? 'news_likes' : 'news_favorites';
    const counter = kind === 'like' ? 'likes' : 'favorites';
    const label = kind === 'like' ? '点赞' : '收藏';
    const quota = await checkQuota(env, kind, userKey(auth.userId)).catch(() => ({ allowed: true }));
    if (!quota.allowed) return fail(429, quota.message);

    const note = await one(env, 'SELECT id FROM news WHERE id=? AND deleted_at IS NULL', newsId);
    if (!note) return fail(404, '笔记不存在或已删除');

    try {
      if (action === 'add') {
        // 必须 OR IGNORE: 直接 INSERT 撞唯一索引会抛错(500), 而不是返回"已经点过"
        const result = await run(env, `INSERT OR IGNORE INTO ${table} (news_id, user_id, created_at) VALUES (?,?,?)`, newsId, auth.userId, beijingNow());
        if (!result || !result.meta || Number(result.meta.changes) < 1) {
          return fail(403, `您已经${label}过该笔记了`);
        }
        await env.DB.batch([
          quotaStatement(env, kind, userKey(auth.userId), QUOTAS[kind]),
          env.DB.prepare(`UPDATE news SET ${counter}=COALESCE(${counter},0)+1 WHERE id=?`).bind(newsId)
        ]);
      } else {
        const result = await run(env, `DELETE FROM ${table} WHERE news_id=? AND user_id=?`, newsId, auth.userId);
        if (!result || !result.meta || Number(result.meta.changes) < 1) {
          return fail(403, `您还未${label}过该笔记`);
        }
        await env.DB.batch([
          quotaStatement(env, kind, userKey(auth.userId), QUOTAS[kind]),
          env.DB.prepare(`UPDATE news SET ${counter}=CASE WHEN COALESCE(${counter},0)>0 THEN ${counter}-1 ELSE 0 END WHERE id=?`).bind(newsId)
        ]);
      }
      const row = await one(env, `SELECT ${counter} AS c FROM news WHERE id=?`, newsId);
      const total = Number(row && row.c) || 0;
      return ok(kind === 'like'
        ? { likes: total, is_liked: action === 'add' }
        : { favorites: total, is_favorited: action === 'add' });
    } catch (error) {
      return fail(500, '服务器错误，请稍后重试');
    }
  }

  // ---------------- 分享 ----------------
  router.post('/news/share', async (request, env, ctx, args) => {
    const body = args.body || {};
    const newsId = intOf(body.news_id);
    if (newsId <= 0) return fail(400, '缺少笔记ID参数');
    const user = await currentUser(env, request, body);
    const userId = user ? Number(user.id) : 0;
    if (userId) {
      const quota = await checkQuota(env, 'share', userKey(userId)).catch(() => ({ allowed: true }));
      if (!quota.allowed) return fail(429, quota.message);
    }
    const note = await one(env, 'SELECT id FROM news WHERE id=? AND deleted_at IS NULL', newsId);
    if (!note) return fail(404, '笔记不存在或已删除');
    try {
      const existing = userId
        ? await one(env, 'SELECT id FROM news_shares WHERE news_id=? AND user_id=?', newsId, userId)
        : null;
      const statements = [];
      if (!existing) {
        statements.push(env.DB.prepare('INSERT OR IGNORE INTO news_shares (news_id,user_id,created_at) VALUES (?,?,?)')
          .bind(newsId, userId, beijingNow()));
      }
      if (userId) statements.push(quotaStatement(env, 'share', userKey(userId), QUOTAS.share));
      statements.push(env.DB.prepare('UPDATE news SET shares=COALESCE(shares,0)+1 WHERE id=?').bind(newsId));
      await env.DB.batch(statements);
      const row = await one(env, 'SELECT shares FROM news WHERE id=?', newsId);
      return ok({ shares: Number(row && row.shares) || 0, is_shared: true }, '分享记录成功');
    } catch (error) {
      return fail(500, '服务器错误，请稍后重试');
    }
  });

  // ---------------- 留言 ----------------
  router.post('/news/add_comment', async (request, env, ctx, args) => {
    const body = args.body || {};
    const newsId = intOf(body.news_id);
    const content = str(body.content).trim();
    if (!newsId || !content) return fail(400, '缺少必要的参数');
    if (content.length < 1 || content.length > MAX_COMMENT_LENGTH) {
      return fail(400, `留言内容长度应在1-${MAX_COMMENT_LENGTH}字符之间`);
    }
    const auth = await identity(request, env, body, true);
    if (!auth.ok) return fail(auth.code, auth.message);
    const quota = await checkQuota(env, 'comment', userKey(auth.userId)).catch(() => ({ allowed: true }));
    if (!quota.allowed) return fail(429, quota.message);
    const note = await one(env, 'SELECT id FROM news WHERE id=? AND deleted_at IS NULL', newsId);
    if (!note) return fail(404, '笔记不存在');
    try {
      // 内部测试用户免审(与旧站一致)
      const approved = Number(auth.user.is_trusted) === 1;
      const status = approved ? 'approved' : 'pending';
      const result = await run(env,
        'INSERT INTO news_comments (news_id,user_id,content,status,created_at) VALUES (?,?,?,?,?)',
        newsId, auth.userId, content, status, beijingNow());
      await env.DB.batch([quotaStatement(env, 'comment', userKey(auth.userId), QUOTAS.comment)]);
      const id = Number(result && result.meta && result.meta.last_row_id) || 0;
      return ok({ id, status, is_approved: approved }, approved ? '留言发布成功' : '留言已提交，审核中');
    } catch (error) {
      return fail(500, '服务器错误，请稍后重试');
    }
  });

  // ---------------- 评论列表 ----------------
  router.get('/news/get_comments', async (request, env) => {
    const body = Object.fromEntries(new URL(request.url).searchParams.entries());
    const newsId = intOf(body.news_id);
    if (!newsId) return fail(400, '缺少笔记ID');
    let page = clampPage(body.page, 1);
    let limit = intOf(body.limit || body.page_size || body.pageSize, 10);
    if (limit < 1 || limit > 50) limit = 10;
    try {
      const total = Number((await one(env,
        "SELECT COUNT(*) AS c FROM news_comments WHERE news_id=? AND status='approved'", newsId)).c) || 0;
      const rows = await all(env,
        'SELECT c.id,c.content,c.created_at,u.id AS user_id,u.nickname,u.username,u.avatar '
        + 'FROM news_comments c LEFT JOIN users u ON u.id=c.user_id '
        + "WHERE c.news_id=? AND c.status='approved' ORDER BY c.created_at DESC LIMIT ? OFFSET ?",
        newsId, limit, (page - 1) * limit);
      const comments = rows.map((row) => {
        const created = str(row.created_at);
        return {
          id: row.id,
          content: row.content === undefined ? null : row.content,
          // 旧站截到分钟, 解析失败给空串
          created_at: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(created) ? created.slice(0, 16) : '',
          user_name: row.username === undefined ? null : row.username,
          nickname: row.nickname === undefined ? null : row.nickname,
          user_avatar: assetUrl(env, row.avatar || '/images/user.png')
        };
      });
      return json({
        code: 200,
        msg: '获取成功',
        data: {
          comments,
          pagination: {
            total,
            total_pages: Math.ceil(total / limit),
            current_page: page,
            limit,
            has_more: page * limit < total
          }
        }
      });
    } catch (error) {
      return fail(500, '服务器错误，请稍后重试');
    }
  });

  // ---------------- 行为状态 ----------------
  router.any('/news/check_user_action', async (request, env, ctx, args) => {
    const body = args.body || {};
    const newsId = intOf(body.news_id);
    const userId = intOf(body.user_id);
    if (!newsId || !userId) return fail(400, '参数错误');
    try {
      const note = await one(env, 'SELECT likes,favorites,shares,view_count FROM news WHERE id=?', newsId);
      // 文案与旧站逐字一致(旧站此分支是"笔记不存在", 不带"或已删除")
      if (!note) return fail(404, '笔记不存在');
      const state = await userActionState(env, userId, newsId);
      return ok({
        is_liked: state.is_liked,
        is_favorited: state.is_favorited,
        is_shared: state.is_shared,
        is_viewed: state.is_viewed,
        likes: Number(note.likes) || 0,
        favorites: Number(note.favorites) || 0,
        view_count: Number(note.view_count) || 0,
        shares: Number(note.shares) || 0
      });
    } catch (error) {
      return fail(500, '服务器错误，请稍后重试');
    }
  });

  router.post('/news/check_user_like_batch', async (request, env, ctx, args) => {
    const body = args.body || {};
    if (body.user_id === undefined || body.news_ids === undefined) return fail(400, '缺少必要参数');
    const ids = Array.from(new Set(idList(body.news_ids)));
    if (!ids.length) return fail(400, '参数错误');
    if (ids.length > MAX_BATCH_NEWS_IDS) return fail(400, `一次最多查询${MAX_BATCH_NEWS_IDS}条`);
    const auth = await identity(request, env, body, true);
    if (!auth.ok) return fail(auth.code, auth.message);
    try {
      const marks = ids.map(() => '?').join(',');
      const rows = await all(env,
        `SELECT news_id FROM news_likes WHERE user_id=? AND news_id IN (${marks})`,
        auth.userId, ...ids);
      return ok({ liked_news_ids: rows.map((row) => Number(row.news_id)) });
    } catch (error) {
      return fail(500, '服务器错误，请稍后重试');
    }
  });
}

async function likedIds(env, viewer, rows) {
  if (!viewer || !rows.length) return new Set();
  try {
    const marks = rows.map(() => '?').join(',');
    const found = await all(env,
      `SELECT news_id FROM news_likes WHERE user_id=? AND news_id IN (${marks})`,
      viewer.id, ...rows.map((row) => row.id));
    return new Set(found.map((row) => Number(row.news_id)));
  } catch (error) {
    return new Set();
  }
}

function withLiked(row, likedSet) {
  return Object.assign({}, row, { is_liked: likedSet.has(Number(row.id)) });
}

async function userActionState(env, userId, newsId) {
  const state = { is_liked: false, is_favorited: false, is_shared: false, is_viewed: false };
  if (!userId) return state;
  const [liked, favorited, shared, viewed] = await Promise.all([
    one(env, 'SELECT id FROM news_likes WHERE news_id=? AND user_id=?', newsId, userId).catch(() => null),
    one(env, 'SELECT id FROM news_favorites WHERE news_id=? AND user_id=?', newsId, userId).catch(() => null),
    one(env, 'SELECT id FROM news_shares WHERE news_id=? AND user_id=?', newsId, userId).catch(() => null),
    one(env, 'SELECT id FROM news_view_history WHERE news_id=? AND user_id=?', newsId, userId).catch(() => null)
  ]);
  return {
    is_liked: !!liked,
    is_favorited: !!favorited,
    is_shared: !!shared,
    is_viewed: !!viewed
  };
}
