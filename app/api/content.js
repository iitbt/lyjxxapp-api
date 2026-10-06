// 内容下发: 轮播图 / 户外 / 摩旅 / 公告 / 未读数 / 标记已读 (共 6 条)
import { bannersFail, bannersOk, fail, legacyFail, legacyOk, ok, okMessage } from '../core/response.js';
import { all, intOf, one, run, str } from '../core/db.js';
import { assetUrl } from '../core/media_scheme.js';
import { currentUser, tokenOf } from './helpers.js';
import { clampPage } from './schemas.js';
import { beijingNow, datePart } from '../core/timeutil.js';

const LEVEL_TEXT = { info: '公告', warning: '提醒', important: '重要' };
const VIDEO_TABLES = ['outdoor_activities', 'motorcycle_trips'];
const COLUMNS = {
  outdoor_activities: 'id,title,description,date,location,poster,videoUrl,created_at,updated_at',
  motorcycle_trips: 'id,title,description,distance,duration,difficulty,poster,videoUrl,created_at,updated_at'
};

function limitOf(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = intOf(value, fallback);
  if (parsed <= 0) return 0;
  return Math.min(parsed, max);
}

function normalizeTopic(row, env, canWatch) {
  const out = Object.assign({}, row);
  if (out.videoUrl !== undefined) {
    out.video_url = out.videoUrl;
    delete out.videoUrl;
  }
  out.poster = assetUrl(env, out.poster);
  if (out.video_url) {
    if (canWatch) {
      out.video_url = assetUrl(env, out.video_url);
    } else {
      delete out.video_url;
    }
  }
  out.can_watch_video = !!canWatch;
  return out;
}

export function registerContentRoutes(router) {
  router.any('/content/get_banners', async (request, env, ctx, args) => {
    const body = args.body || {};
    try {
      const position = str(body.position, 'news') || 'news';
      const limit = limitOf(body.limit, 5, 50);
      const rows = await all(
        env,
        'SELECT id,title,image_url,link_url FROM banner_images WHERE position=? AND status=1 ORDER BY sort_order ASC, id DESC LIMIT ?',
        position, limit === 0 ? 200 : limit
      );
      const data = rows.map((row) => ({
        id: row.id,
        title: row.title === undefined ? null : row.title,
        image_url: assetUrl(env, row.image_url),
        link_url: row.link_url === undefined ? null : row.link_url
      }));
      return bannersOk(data);
    } catch (error) {
      return bannersFail();
    }
  });

  router.any('/content/get_outdoor', (request, env, ctx, args) => topicHandler(request, env, args, 'outdoor_activities'));
  router.any('/content/get_motorcycle', (request, env, ctx, args) => topicHandler(request, env, args, 'motorcycle_trips'));

  async function topicHandler(request, env, args, table) {
    const body = args.body || {};
    // 成功文案与旧站逐字一致: 旧站两条专题接口各有自己的 msg/message
    const message = table === 'motorcycle_trips' ? '获取摩旅精选数据成功' : '获取户外精选数据成功';
    try {
      const user = await currentUser(env, request, body);
      const canWatch = !!(user && Number(user.is_trusted) === 1);
      const page = intOf(body.page, 0);
      const size = Math.min(Math.max(1, intOf(body.page_size || body.pageSize || body.limit, 2)), 20);
      const columns = COLUMNS[table];
      if (page <= 0) {
        const rows = await all(env, `SELECT ${columns} FROM ${table} WHERE status='approved' ORDER BY id ASC LIMIT ?`, 500);
        return legacyOk(rows.map((row) => normalizeTopic(row, env, canWatch)), message);
      }
      const total = Number((await one(env, `SELECT COUNT(*) AS c FROM ${table} WHERE status='approved'`)).c) || 0;
      const rows = await all(
        env,
        `SELECT ${columns} FROM ${table} WHERE status='approved' ORDER BY id ASC LIMIT ? OFFSET ?`,
        size, (page - 1) * size
      );
      return legacyOk({
        list: rows.map((row) => normalizeTopic(row, env, canWatch)),
        total,
        page,
        page_size: size
      }, message);
    } catch (error) {
      return legacyFail();
    }
  }

  router.any('/content/get_notices', async (request, env, ctx, args) => {
    const body = args.body || {};
    try {
      const page = clampPage(body.page, 1);
      let size = intOf(body.page_size || body.pageSize || body.limit, 10);
      if (size < 1) size = 10;
      if (size > 20) size = 20;
      const now = beijingNow();
      const where = "status=1 AND (start_at IS NULL OR start_at='' OR start_at<=?) AND (end_at IS NULL OR end_at='' OR end_at>=?)";
      const total = Number((await one(env, `SELECT COUNT(*) AS c FROM app_notices WHERE ${where}`, now, now)).c) || 0;
      const rows = await all(
        env,
        `SELECT id,title,content,level,link_type,link_value,create_time FROM app_notices WHERE ${where} ORDER BY sort_order ASC, id DESC LIMIT ? OFFSET ?`,
        now, now, size, (page - 1) * size
      );
      const list = rows.map((row) => {
        const level = LEVEL_TEXT[row.level] ? row.level : 'info';
        const linkType = row.link_type === 'page' ? 'page' : '';
        return {
          id: row.id,
          title: str(row.title),
          content: str(row.content),
          level,
          level_text: LEVEL_TEXT[level],
          link_type: linkType,
          link_value: linkType === 'page' ? str(row.link_value) : '',
          published_at: datePart(row.create_time)
        };
      });
      // 有有效 token 时才追加 is_read(旧站行为: 否则键不存在)
      const token = tokenOf(request, body);
      if (token) {
        const user = await currentUser(env, request, body);
        if (user && list.length) {
          const marks = list.map(() => '?').join(',');
          const readRows = await all(
            env,
            `SELECT notice_id FROM app_notice_reads WHERE user_id=? AND notice_id IN (${marks})`,
            user.id, ...list.map((item) => item.id)
          );
          const readSet = new Set(readRows.map((row) => Number(row.notice_id)));
          list.forEach((item) => { item.is_read = readSet.has(Number(item.id)); });
        }
      }
      return okMessage({
        list,
        total,
        page,
        page_size: size,
        pageSize: size,
        has_more: (page - 1) * size + list.length < total
      }, '获取通知公告成功');
    } catch (error) {
      return okMessage({ list: [], total: 0, page: 1, page_size: 10, pageSize: 10, has_more: false }, '获取通知公告成功');
    }
  });

  router.any('/content/get_notice_unread', async (request, env, ctx, args) => {
    const body = args.body || {};
    // 旧站口径: 未登录 **不是错误** —— 回 200 + msg"未登录" + 空数据(小程序启动即调, 不该弹错误)
    if (!tokenOf(request, body)) return ok({ unread_count: 0, ids: [] }, '未登录');
    const user = await currentUser(env, request, body);
    if (!user) return fail(401, '登录已过期，请重新登录');
    const now = beijingNow();
    try {
      const rows = await all(
        env,
        "SELECT id FROM app_notices WHERE status=1 AND (start_at IS NULL OR start_at='' OR start_at<=?) AND (end_at IS NULL OR end_at='' OR end_at>=?) ORDER BY id DESC",
        now, now
      );
      const readRows = await all(env, 'SELECT notice_id FROM app_notice_reads WHERE user_id=?', user.id);
      const readSet = new Set(readRows.map((row) => Number(row.notice_id)));
      const ids = rows.map((row) => Number(row.id)).filter((id) => !readSet.has(id));
      return ok({ unread_count: ids.length, ids }, '获取未读公告成功');
    } catch (error) {
      return fail(500, '获取未读公告失败，请稍后重试');
    }
  });

  router.any('/content/notice_read', async (request, env, ctx, args) => {
    const body = args.body || {};
    // 旧站文案: 无 token → "未登录"; token 失效 → "登录已过期，请重新登录"
    if (!tokenOf(request, body)) return fail(401, '未登录');
    const user = await currentUser(env, request, body);
    if (!user) return fail(401, '登录已过期，请重新登录');
    const noticeId = intOf(body.notice_id);
    if (!noticeId) return fail(400, '参数有误');
    try {
      await run(
        env,
        'INSERT INTO app_notice_reads (user_id, notice_id, read_at) VALUES (?,?,?) ON CONFLICT(user_id, notice_id) DO NOTHING',
        user.id, noticeId, beijingNow()
      );
    } catch (error) {
      return fail(500, '操作失败，请稍后重试');
    }
    const now = beijingNow();
    const total = Number((await one(
      env,
      "SELECT COUNT(*) AS c FROM app_notices WHERE status=1 AND (start_at IS NULL OR start_at='' OR start_at<=?) AND (end_at IS NULL OR end_at='' OR end_at>=?)",
      now, now
    )).c) || 0;
    const readCount = Number((await one(env, 'SELECT COUNT(*) AS c FROM app_notice_reads WHERE user_id=?', user.id)).c) || 0;
    return ok({ notice_id: noticeId, unread_count: Math.max(0, total - readCount) }, '已标记为已读');
  });
}
