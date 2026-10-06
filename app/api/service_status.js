// 状态类接口: /  /test  /index  /info  /apitest (共 5 条)
// 状态页(/)对照旧站 service_status.py + templates/status.html: 服务名、时间(走动)、数据统计、依赖监控、使用说明
import { fail, html, json, redirect } from '../core/response.js';
import { statusPage } from '../core/html.js';
import { beijingDaysAgo, beijingMidnight, beijingNow, nowEpoch, wallClockMs } from '../core/timeutil.js';
import { one } from '../core/db.js';
import { settings } from '../core/config.js';
import { logError } from '../core/logging.js';

/** 探一次依赖并计时(旧站表格里的"响应时间"列)。 */
async function timed(step) {
  const start = Date.now();
  try {
    await step();
    return { ok: true, ms: Date.now() - start, reason: '' };
  } catch (error) {
    logError('service_status.probe_failed', error);
    return { ok: false, ms: Date.now() - start, reason: String((error && error.message) || error || '') };
  }
}

/** 依赖探测: D1 与 R2(旧站是"逐个 DB 配置探活", 这里对应两个平台依赖)。 */
async function probe(env) {
  const database = await timed(() => one(env, 'SELECT 1 AS c'));
  const media = await timed(() => env.MEDIA.head('__probe__'));
  return { database, media };
}

/** /apitest 的布尔口径(与旧站 database_connected 同名字段)。 */
async function checks(env) {
  const state = await probe(env);
  return { database_connected: state.database.ok, media_connected: state.media.ok };
}

/** 数据统计: 与旧站同名的 6 项(总用户数/今日/本周/本月新增/笔记总数/评论总数), 取不到就显示 "-"。 */
async function collectStats(env) {
  const empty = {
    total_users: '-', today_new: '-', week_new: '-', month_new: '-', news_total: '-', comments_total: '-'
  };
  try {
    const row = await one(env,
      'SELECT (SELECT COUNT(*) FROM users) AS total_users, '
      + '(SELECT COUNT(*) FROM users WHERE create_time >= ?) AS today_new, '
      + '(SELECT COUNT(*) FROM users WHERE create_time >= ?) AS week_new, '
      + '(SELECT COUNT(*) FROM users WHERE create_time >= ?) AS month_new, '
      + '(SELECT COUNT(*) FROM news WHERE deleted_at IS NULL) AS news_total, '
      + '(SELECT COUNT(*) FROM news_comments) AS comments_total',
      beijingMidnight(), beijingDaysAgo(7), beijingDaysAgo(30));
    return Object.assign(empty, row || {});
  } catch (error) {
    logError('service_status.stats_failed', error);
    return empty;
  }
}

/** 进程启动时间: Worker 没有常驻进程, 给的是当前 isolate 的启动时刻(取不到就显示 "-")。 */
function isolateStartedAt() {
  try {
    const origin = Number(globalThis.performance && globalThis.performance.timeOrigin);
    if (Number.isFinite(origin) && origin > 0) return beijingNow(new Date(origin));
  } catch (error) {
    // 忽略: 该运行时没有 performance.timeOrigin
  }
  return '';
}

export function registerStatusRoutes(router, options = {}) {
  // 版本号由入口注入(main.js 的 API_VERSION 是唯一来源, 与旧站 APP_VERSION 同位置); 运行开关仍从 core/config.js 取
  const versionOf = () => String(options.version || '');
  // 与旧站逐字一致: / 的 JSON 与 HTML 状态页都展示这两行, 对拍脚本会比对
  const serviceName = '狼牙极限运动笔记API';
  const serviceDesc = '本服务为狼牙极限运动笔记微信小程序提供后端API支持，包括户外活动、摩旅路线等数据服务。';

  router.any('/', async (request, env) => {
    const url = new URL(request.url);
    const wantsJson = url.searchParams.get('format') === 'json'
      || (request.headers.get('accept') || '').includes('application/json')
      || (request.headers.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest';
    const serverTime = beijingNow();
    // JSON 分支与旧站同形(只 name/description/status/server_time): live_time.js 靠它校准时钟
    if (wantsJson) {
      const state = await checks(env);
      return json({
        name: serviceName,
        description: serviceDesc,
        // 正常态写死"运行中"(与旧站一致), 库不通时给"异常"
        status: state.database_connected ? '运行中' : '异常',
        server_time: serverTime
      });
    }

    const [state, stats] = await Promise.all([probe(env), collectStats(env)]);
    const deps = [
      {
        name: 'Cloudflare D1（主库）', type: 'SQLite (D1)', active: true,
        ok: state.database.ok, responseTime: state.database.ms, status: state.database.ok ? '正常' : '异常'
      },
      {
        name: 'Cloudflare R2（素材）', type: '对象存储 (R2)', active: true,
        ok: state.media.ok, responseTime: state.media.ms, status: state.media.ok ? '正常' : '异常'
      }
    ];
    const overallOk = state.database.ok && state.media.ok;
    const startedAt = isolateStartedAt();
    return html(statusPage({
      name: serviceName,
      description: serviceDesc,
      status: state.database.ok ? '运行中' : '异常',
      serverTime,
      wallMs: wallClockMs(),
      version: versionOf(env),
      startedAt,
      startedAtNote: startedAt ? '（当前 isolate）' : '',
      stats: [
        [stats.total_users, '总用户数'],
        [stats.today_new, '今日新增'],
        [stats.week_new, '本周新增'],
        [stats.month_new, '本月新增'],
        [stats.news_total, '笔记总数'],
        [stats.comments_total, '评论总数']
      ],
      deps,
      overallOk,
      overallMessage: overallOk ? '' : (state.database.ok ? state.media.reason : state.database.reason),
      mediaBase: settings(env).mediaBase
    }));
  });

  // 历史路径收敛: /index、/info 回首页; /test 回 /apitest(旧站的 301 目标就是它, 已实测)
  router.any('/test', () => redirect('/apitest'));
  router.any('/index', () => redirect('/'));
  router.any('/info', () => redirect('/'));

  // 连通性探测: 探库 + 报版本(ENABLE_PUBLIC_PROBE=0 时关闭)
  router.any('/apitest', async (request, env) => {
    if (!settings(env).enablePublicProbe) {
      // 旧站口径: 关闭时是 **HTTP 404** + code 404 + 文案"接口已关闭"(不是 403)
      return fail(404, '接口已关闭', { httpStatus: 404 });
    }
    const state = await checks(env);
    return json({
      code: 200,
      // 旧站文案(service_status.py): 小程序不判 msg, 但对拍脚本要逐字一致
      msg: 'API测试成功',
      data: {
        // 口径必须与旧站一致: 小程序「检测线路」判定 data.api_status === 'online', 写成 'ok' 会被判成这条线路不通
        api_status: 'online',
        server_time: beijingNow(),
        version: versionOf(env),
        database_connected: state.database_connected
      },
      timestamp: nowEpoch()
    });
  });
}
