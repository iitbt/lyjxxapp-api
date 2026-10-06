// 响应形态: 旧站有 5 种形态并存, 逐接口对齐(依据 notes/api-inventory.md 与源码复核)
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({}, JSON_HEADERS, extraHeaders)
  });
}

// 通用: {code:200, msg, data}
export function ok(data, msg = 'success') {
  return json({ code: 200, msg, data });
}

// /config/get_app_config 与 /content/get_notices: 用 message 键, 没有 msg
export function okMessage(data, message = 'success') {
  return json({ code: 200, message, data });
}

// /config/get_app_config 额外带 timestamp
export function okMessageWithTimestamp(data, message, timestamp) {
  return json({ code: 200, message, data, timestamp });
}

// /content/get_banners: code=0, message 与 msg 并存, 无 status
export function bannersOk(data, message = 'success') {
  return json({ code: 0, message, msg: message, data });
}

export function bannersFail(message = '服务器错误') {
  return json({ code: 500, message, msg: message, data: [] });
}

// /content/get_outdoor 与 get_motorcycle: code + msg + status + message 四键并存
export function legacyOk(data, message = 'success') {
  return json({ code: 200, msg: message, status: 'success', message, data });
}

export function legacyFail(message = '服务器错误') {
  return json({ code: 500, msg: message, status: 'error', message });
}

// 失败: 旧站多为 {code,msg,data:null}; useMessageKey 用于 message 键的接口
//
// httpStatus 只给"框架层"错误用(未知路由 404 / 未捕获异常 500 / 探针关闭 404):
// 旧站这两处是真 HTTP 状态码, 而业务失败一律 HTTP 200 + body.code —— 口径不能混。
export function fail(code, message, options = {}) {
  const data = options.data === undefined ? null : options.data;
  const status = options.httpStatus === undefined ? 200 : options.httpStatus;
  return options.useMessageKey
    ? json({ code, message, data }, status)
    : json({ code, msg: message, data }, status);
}

// 少数接口失败时 data 是空数组(/news/list)
export function failList(code, message) {
  return json({ code, msg: message, data: [] });
}

export function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: Object.assign({ 'content-type': 'text/html; charset=utf-8' }, extraHeaders)
  });
}

export function text(body, contentType = 'text/plain; charset=utf-8', status = 200) {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

export function redirect(location, status = 301) {
  return new Response(null, { status, headers: { location } });
}
