// 日志与审计 —— 对照旧站 app/core/logging.py
//
// 旧站: 文件/控制台双通道 + text/json 双格式 + 键名与文本双重脱敏 + 审计独立轮转文件(10MB×5)。
// Worker 没有文件系统, 输出统一进 Workers Logs(控制台 tail / Logpush), 所以这里保留两件
// **在 Cloudflare 上仍然有价值**的事, 其余(轮转、落盘、移动端折行)不照搬:
//   ① 结构化输出: 统一前缀 + JSON 字段, 便于在 Workers Logs 里按事件名检索;
//   ② 脱敏: 密钥 / token / 口令 / Cookie 永不进日志 —— 这条在旧站是硬规则, 迁移后必须保持。
//
// 刻意不做: 进程内日志缓冲与级别过滤(YAGNI; 需要时用 Workers Logs 侧过滤)。

//: 命中这些键名的字段一律打码(与旧站 logging.py 的 _redact 同口径 + 补充后台用到的键)
const REDACT_KEYS = /secret|token|password|passwd|pwd|authorization|cookie|session|appid|openid/i;
//: 文本里以 `key=value` 形态出现的敏感值(token=xxx / secret: xxx)
const REDACT_TEXT = /((?:secret|token|password|passwd|pwd|authorization|cookie|session)\s*[=:]\s*)([^\s,;&"']+)/gi;

const MASK = '***';

/** 键名级脱敏: 只处理浅层对象(日志字段都是扁平的, 不递归省 CPU)。 */
function redactFields(fields) {
  const out = {};
  Object.keys(fields || {}).forEach((key) => {
    const value = fields[key];
    out[key] = REDACT_KEYS.test(key) ? MASK : value;
  });
  return out;
}

/** 文本级脱敏: 把 `token=abc` 之类替换成 `token=***`(旧站的 redact_text 等价物)。 */
export function redactText(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(REDACT_TEXT, (all, prefix) => prefix + MASK);
}

/** 事件名 + 字段 → 一行结构化日志。level 直接映射到 Workers Logs 的级别。 */
function emit(level, event, fields) {
  const payload = redactFields(fields);
  const line = JSON.stringify({ level, event, ...payload });
  if (level === 'error') {
    console.error(redactText(line));
  } else if (level === 'warn') {
    console.warn(redactText(line));
  } else {
    console.log(redactText(line));
  }
}

export function logEvent(event, fields) {
  emit('info', event, fields);
}

export function logWarn(event, fields) {
  emit('warn', event, fields);
}

/** 异常日志: 保留 name/message/stack(便于定位), 但先过文本脱敏。 */
export function logError(event, error, fields) {
  emit('error', event, {
    ...(fields || {}),
    error: error && error.name ? error.name : typeof error,
    message: redactText(error && error.message ? error.message : error),
    stack: redactText(error && error.stack ? error.stack : '')
  });
}

/**
 * 后台写操作审计 —— 对照旧站 logging.py 的 audit_log()。
 *
 * 为什么保留: 旧站把"谁 / 何时 / 从哪个 IP / 做了什么 / 结果"写进独立审计文件;
 * 迁到 Cloudflare 后落到 Workers Logs, 事件名统一为 `admin.audit`, 字段与旧站一致
 * (需要长期可查询时再接 Logpush 或 D1 审计表 —— 当前不建表, 避免过度设计)。
 */
export function auditLog(action, { username, request, ...extra } = {}) {
  const headers = (request && request.headers) || null;
  emit('info', 'admin.audit', {
    action,
    username: username || '-',
    ip: request && typeof request.headers?.get === 'function'
      ? (headers.get('cf-connecting-ip') || headers.get('x-forwarded-for') || '-')
      : '-',
    ua: headers ? String(headers.get('user-agent') || '').slice(0, 200) : '',
    ...extra
  });
}
