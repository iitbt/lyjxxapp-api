// 配置的唯一来源 —— 对照旧站 app/core/config.py
//
// 旧站: .env → Settings(全局单例) → 各模块 `from ..core.config import settings`
// 新站: 配置来自两处, 部署时由 Cloudflare 注入到 env ——
//   [vars](wrangler.toml, 明文) 与 Secrets(控制台加密变量 / wrangler secret, 密文)
// 约定: **只有这个文件读 env.XXX**, 其它模块一律 settings(env).xxx。
// 这样"默认值 / 开关语义 / 变量名"只有一份, 与旧站"配置项集中"是同一条纪律。
import { intOf } from './db.js';

//: 头像上传上限默认 20MB —— 与旧站 config.py 的 UPLOAD_MAX_BYTES 默认值一致
const DEFAULT_UPLOAD_MAX_BYTES = 20971520;

//: 把 env 上的值统一成字符串(undefined/null → ''), 与旧站 os.getenv 取不到时的行为对应
function str(value) {
  return String(value === undefined || value === null ? '' : value);
}

/**
 * 读取当前请求的配置快照(纯函数, 不缓存 —— Worker 每个 isolate 的环境相同, 但配置改了要立刻生效)。
 *
 * 为什么是函数而不是旧站那样的模块级单例: Worker 的 env 由运行时按请求注入,
 * 模块顶层拿不到; 语义上等价于旧站"启动时读一次 .env"。
 */
export function settings(env) {
  const e = env || {};
  return {
    // 站点品牌(旧站 config.py 的 site_name/site_short): 后台标题、登录页与图标 alt 都用它
    siteName: str(e.SITE_NAME) || '狼牙极限运动笔记',
    siteShort: str(e.SITE_SHORT) || '狼牙极限',
    // 素材对外域名(库里只存相对路径, 下发时拼这个前缀); 空 = 未配置
    mediaBase: str(e.MEDIA_BASE),
    // 密钥未配置时也走假数据分支(旧站同口径: 没配 secret 就 mock)
    devWechatMock: str(e.DEV_WECHAT_MOCK) === '1',
    wechatAppid: str(e.WECHAT_APPID),
    wechatSecret: str(e.WECHAT_SECRET),
    // 头像上传字节上限; 配了非法值(非数字/0/负数)时回退默认
    uploadMaxBytes: intOf(e.UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES) || DEFAULT_UPLOAD_MAX_BYTES,
    // 1 = 开放 /apitest 探测(默认开); '0' = 关闭
    enablePublicProbe: str(e.ENABLE_PUBLIC_PROBE || '1') !== '0',
    // 1 = 输出 /metrics 最小 Prometheus 文本(默认关)
    observabilityEnabled: str(e.OBSERVABILITY_ENABLED || '0') === '1',
    // 后台会话签名密钥(密文): 空 = 后台未就绪, 登录页明确提示, 不用默认值放行
    adminSessionSecret: str(e.ADMIN_SESSION_SECRET),
    // 1 = 开放"数据库工具 / 数据库管理"页(默认关) —— 与旧站 ENABLE_SQL_TOOL 同口径:
    // 能浏览全表数据、能执行 SQL 的入口不长期暴露
    enableSqlTool: str(e.ENABLE_SQL_TOOL || '0') === '1',
    // CORS 白名单(逗号分隔); '*' = 放开(默认, 与迁移前一致), 填域名后只回白名单内的 Origin
    allowedOrigins: str(e.ALLOWED_ORIGINS) || '*'
  };
}
