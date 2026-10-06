// 状态类接口: /  /test  /index  /info  /apitest (共 5 条)
import { fail, html, json, redirect } from '../core/response.js';
import { statusPage } from '../core/html.js';
import { beijingNow, nowEpoch } from '../core/timeutil.js';
import { one } from '../core/db.js';
import { settings } from '../core/config.js';

async function checks(env) {
  const result = { database_connected: false, media_connected: false };
  try {
    await one(env, 'SELECT 1 AS c');
    result.database_connected = true;
  } catch (error) {
    result.database_connected = false;
  }
  try {
    await env.MEDIA.head('__probe__');
    result.media_connected = true;
  } catch (error) {
    result.media_connected = false;
  }
  return result;
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
    const state = await checks(env);
    const serverTime = beijingNow();
    if (wantsJson) {
      return json({
        name: serviceName,
        description: serviceDesc,
        // 旧站正常态写死"运行中"(service_status.py:163), 这里对齐; 库不通时给"异常"
        status: state.database_connected ? '运行中' : '异常',
        server_time: serverTime
      });
    }
    return html(statusPage([
      ['服务', serviceName],
      ['版本', versionOf(env)],
      ['状态', state.database_connected ? '正常' : '异常', state.database_connected ? 'ok' : 'bad'],
      ['数据库', state.database_connected ? '连接正常' : '不可用', state.database_connected ? 'ok' : 'bad'],
      ['素材存储', state.media_connected ? '连接正常' : '不可用', state.media_connected ? 'ok' : 'bad'],
      ['媒体域', settings(env).mediaBase || '-'],
      ['服务器时间', serverTime]
    ], '接口文档见 app/api-cf/Plan.md'));
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
