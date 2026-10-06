// 微信接口: code2session 每次必取; access_token 必须缓存复用(重复获取会顶掉旧 token)
// 缓存放 D1(wechat_tokens 表, 见 schema/0003_wechat_token.sql), 不额外引入 KV 绑定
import { one, run } from './db.js';
import { md5Hex } from './md5.js';
import { nowEpoch } from './timeutil.js';
import { settings } from './config.js';

const SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session';
const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token';
const CHECK_URL = 'https://api.weixin.qq.com/wxa/msg_sec_check';
const EARLY_EXPIRE_SEC = 300;

function mockEnabled(env) {
  const cfg = settings(env);
  // 旧站同口径: 开关为 1 **或** 没配 secret 都走假数据
  return cfg.devWechatMock || !cfg.wechatSecret;
}

// 联调用的稳定假 openid: 同一 code 永远得到同一 openid
function mockOpenId(env, code) {
  const seed = code || settings(env).wechatAppid || 'mock';
  return `mock_${md5Hex(seed).slice(0, 16)}`;
}

export async function code2Session(env, code) {
  if (mockEnabled(env)) {
    return { openid: mockOpenId(env, code), session_key: 'mock_session_key' };
  }
  const url = `${SESSION_URL}?appid=${encodeURIComponent(settings(env).wechatAppid)}`
    + `&secret=${encodeURIComponent(settings(env).wechatSecret)}`
    + `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const payload = await response.json();
    if (payload && payload.openid) return payload;
    return { errcode: payload && payload.errcode ? payload.errcode : -1, errmsg: (payload && payload.errmsg) || 'no openid' };
  } catch (error) {
    return { errcode: -1, errmsg: String((error && error.message) || error) };
  }
}

// access_token: 先查表, 未过期直接用; 过期则取新的并写回
export async function accessToken(env) {
  if (mockEnabled(env)) return '';
  const cached = await one(env, 'SELECT token, expires_at FROM wechat_tokens WHERE name=?', 'access_token').catch(() => null);
  if (cached && Number(cached.expires_at) > nowEpoch() + 30) return String(cached.token || '');
  const url = `${TOKEN_URL}?grant_type=client_credential`
    + `&appid=${encodeURIComponent(settings(env).wechatAppid)}&secret=${encodeURIComponent(settings(env).wechatSecret)}`;
  try {
    const payload = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json();
    if (!payload || !payload.access_token) return '';
    const ttl = Math.max(60, Number(payload.expires_in || 7200) - EARLY_EXPIRE_SEC);
    await run(
      env,
      'INSERT INTO wechat_tokens (name, token, expires_at, update_time) VALUES (?,?,?,strftime(\'%s\',\'now\')) '
      + 'ON CONFLICT(name) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at, update_time=excluded.update_time',
      'access_token', payload.access_token, nowEpoch() + ttl
    ).catch(() => null);
    return String(payload.access_token);
  } catch (error) {
    return '';
  }
}

// 昵称送审: 拿不到 token 或接口异常时放行(不阻塞业务), 判定为风险内容时返回 false
export async function nicknameAllowed(env, nickname) {
  const token = await accessToken(env);
  if (!token) return { ok: true, reason: '' };
  try {
    const response = await fetch(`${CHECK_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, scene: 2, openid: '', content: nickname }),
      signal: AbortSignal.timeout(5000)
    });
    const payload = await response.json();
    const errcode = Number(payload && payload.errcode) || 0;
    if (errcode === 87014) return { ok: false, reason: '昵称包含违规内容，请修改后再试' };
    return { ok: true, reason: '' };
  } catch (error) {
    return { ok: true, reason: '' };
  }
}
