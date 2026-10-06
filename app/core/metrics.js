// 指标: /metrics —— 对照旧站 app/core/metrics.py
//
// 旧站自实现了一个 Prometheus 客户端(http_requests_total、请求耗时直方图、database_up), 由
// OBSERVABILITY_ENABLED 控制挂载。新站在免费套餐下**不引依赖**、也不做全量打点(Worker 里累积计数
// 无进程内状态可存), 只输出最小可用集: 接口存活 + 依赖探针 —— 指标名与旧站不同属已知差异,
// 已在 app/api-cf/README.md 的「已知差异」声明。
//
// 未开启时返回 404 与纯文本(与旧站"开关关掉就不挂载该路由"的状态码一致)。
import { text } from './response.js';
import { settings } from './config.js';
import { probe } from './health.js';

export function registerMetricsRoutes(router, options = {}) {
  router.get('/metrics', async (request, env) => {
    if (!settings(env).observabilityEnabled) {
      return text('# metrics disabled\n', 'text/plain; charset=utf-8', 404);
    }
    const state = await probe(env);
    // 版本号由入口注入(唯一来源是 main.js 的 API_VERSION)
    const version = String(options.version || '');
    const lines = [
      '# HELP api_up 对外 API 可用性(1=可用)',
      '# TYPE api_up gauge',
      `api_up{version="${version}"} ${state.database ? 1 : 0}`,
      '# HELP api_check 依赖检查(1=正常)',
      '# TYPE api_check gauge',
      `api_check{name="database"} ${state.database ? 1 : 0}`,
      `api_check{name="media"} ${state.media ? 1 : 0}`
    ];
    return text(`${lines.join('\n')}\n`);
  });
}
