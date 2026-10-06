// 探针与指标: /health /health/ready /metrics
import { json } from './response.js';
import { beijingNow } from './timeutil.js';
import { one } from './db.js';

export async function probe(env) {
  const checksMap = { database: false, media: false };
  try {
    await one(env, 'SELECT 1 AS c');
    checksMap.database = true;
  } catch (error) {
    checksMap.database = false;
  }
  try {
    await env.MEDIA.head('__probe__');
    checksMap.media = true;
  } catch (error) {
    checksMap.media = false;
  }
  return checksMap;
}

export function registerHealthRoutes(router, options = {}) {
  // 版本号由入口注入(main.js 的 API_VERSION 是唯一来源, 与旧站 APP_VERSION 同位置)
  const versionOf = () => String(options.version || '');

  // 存活: 只要 Worker 能跑就 200; uptime_s 在 Worker 里没有进程概念, 固定为 0
  // 与旧站同为"裸结构"(不带 code/msg 包装): 旧站 /health 直接回 status/service/uptime_s/checks
  router.get('/health', async (request, env) => {
    const state = await probe(env);
    return json({
      status: 'ok',
      service: '狼牙极限运动笔记API',
      uptime_s: 0,
      server_time: beijingNow(),
      checks: state
    });
  });

  // 就绪: 数据库或素材不可用时 503(未包装的裸结构, 与旧站一致)
  router.get('/health/ready', async (request, env) => {
    const state = await probe(env);
    const ready = state.database && state.media;
    return json({
      status: ready ? 'ready' : 'starting',
      version: versionOf(env),
      server_time: beijingNow(),
      checks: state
    }, ready ? 200 : 503);
  });

  // /metrics 已拆到 app/core/metrics.js(与旧站 core/health.py + core/metrics.py 的文件划分一致)
}
