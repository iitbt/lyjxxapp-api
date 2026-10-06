// 测试桩: 用函数决定每条 SQL 的返回, 不联网、不依赖 wrangler
import worker from '../main.js';

// 用例可以返回裸值, 也可以返回 {first}/{all}/{meta}: 这里统一解包
function unwrap(raw, kind) {
  if (raw === undefined) raw = null;
  if (kind === 'all') {
    if (Array.isArray(raw)) return raw;
    return (raw && raw.all) || [];
  }
  if (kind === 'first') {
    if (raw && typeof raw === 'object' && 'first' in raw) return raw.first;
    return raw;
  }
  if (raw && typeof raw === 'object' && raw.meta) return raw.meta;
  return raw || { changes: 1, last_row_id: 1 };
}

export function makeEnv(options = {}) {
  const { db, media = {}, vars = {} } = options;
  const calls = [];
  const env = {
    DB: {
      prepare(sql) {
        const entry = { sql, args: [] };
        calls.push(entry);
        const api = {
          bind(...args) {
            entry.args = args;
            return api;
          },
          first: async () => unwrap(db ? db(sql, entry.args, 'first') : null, 'first'),
          all: async () => ({ results: unwrap(db ? db(sql, entry.args, 'all') : null, 'all') }),
          run: async () => ({ meta: unwrap(db ? db(sql, entry.args, 'run') : null, 'run') })
        };
        return api;
      },
      batch: async (list) => list.map(() => ({ meta: { changes: 1 } }))
    },
    STORAGE: {
      head: async () => (media.head === undefined ? null : media.head),
      get: async (key, opts) => {
        if (media.get === undefined) return null;
        return typeof media.get === 'function' ? media.get(key, opts) : media.get;
      },
      put: async () => ({})
    },
    MEDIA_BASE: 'https://media.test',
    UPLOAD_MAX_BYTES: '20971520',
    ENABLE_PUBLIC_PROBE: '1',
    ...vars
  };
  return { env, calls };
}

export function request(path, options = {}) {
  const { method = 'GET', body, env, headers = {} } = options;
  const isRaw = body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer;
  const init = { method, headers: Object.assign({}, headers) };
  if (body !== undefined) {
    // FormData 必须由运行时自己设置 multipart 边界, 不能手写 content-type
    if (!isRaw) init.headers['content-type'] = 'application/json';
    init.body = isRaw ? body : JSON.stringify(body);
  }
  return worker.fetch(new Request(`https://api.test${path}`, init), env, {});
}

export const get = (path, env) => request(path, { env });
export const post = (path, body, env) => request(path, { method: 'POST', body, env });
export const postJson = async (path, body, env) => (await post(path, body, env)).json();
export const getJson = async (path, env) => (await get(path, env)).json();

// 常用返回: 用户行 / 笔记行
export const USER_ROW = {
  id: 7,
  username: 'wx_abc12345',
  nickname: '老王',
  nickname_raw: '老王',
  avatar: 'avatar_uploads/a.png',
  login_type: 'wechat',
  token: 'tok-1',
  status: 0,
  is_trusted: 0,
  openid: 'openid-1'
};

export const TRUSTED_USER_ROW = Object.assign({}, USER_ROW, { id: 8, token: 'tok-trusted', is_trusted: 1 });
