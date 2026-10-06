// 后台页面测试共用桩: 一个能登录的环境 + 按表名回数据的 D1 桩 + 便捷请求帮手
// 单表桩的默认口径: COUNT(*) 走 counts[表名], SELECT 走 rows[表名](列表)或 rows[表名][0](单行)
import { handleAdmin } from '../app/admin/index.js';
import { API_VERSION } from '../main.js';
import { hashPassword } from '../app/admin/lib/password.js';

export const HOST = 'https://admin.test';
export const ADMIN_PASSWORD = 'password-12345';
export const ADMIN_HASH = await hashPassword(ADMIN_PASSWORD);

function tableOf(sql) {
  const matched = /(?:FROM|UPDATE|INTO)\s+"?(\w+)"?/i.exec(String(sql));
  return matched ? matched[1] : '';
}

export function makeAdminEnv(options = {}) {
  const rows = options.rows || {};
  const counts = options.counts || {};
  const state = { role: options.role || 'super', calls: [], puts: [], deletes: [] };
  const adminRow = { id: 1, username: 'admin', nickname: '管理员', password: ADMIN_HASH, role: state.role };
  const env = {
    ADMIN_SESSION_SECRET: 'test-secret',
    ADMIN_ACCESS_MODE: 'access',
    MEDIA_BASE: 'https://media.test',
    // R2 桩: list 回 options.mediaObjects, put 记录 key, head 由 options.mediaHead 决定
    MEDIA: {
      list: async () => ({ objects: options.mediaObjects || [] }),
      head: async (key) => (options.mediaHead ? options.mediaHead(key) : null),
      get: async () => null,
      put: async (key) => { state.puts.push(key); return {}; },
      delete: async (key) => { state.deletes.push(key); return {}; }
    },
    DB: {
      prepare(sql) {
        const entry = { sql, args: [] };
        state.calls.push(entry);
        const api = {
          sql,
          args: entry.args,
          bind(...args) { entry.args = args; return api; },
          async first() {
            if (options.db) {
              const custom = options.db(sql, entry.args, 'first');
              if (custom !== undefined) return custom;
            }
            if (/FROM admin_users WHERE username=/i.test(sql)) return adminRow;
            // 控制面板/版本页那条 aggregrate 查询: 直接回一份完整数字, 便于断言卡片内容
            if (/AS total_users/i.test(sql)) {
              const base = Object.assign({
                total_users: 4, today_users: 1, week_users: 2, prev_week_users: 1, yesterday_users: 0,
                total_news: 69, approved_news: 66, pending_news: 3, total_comments: 12, pending_comments: 2,
                total_likes: 30, total_favorites: 18, total_banners: 18, motorcycle_total: 10, outdoor_total: 8
              }, options.dashboardCounts || {});
              return base;
            }
            // 唯一性检查(WHERE xxx=? AND id<>?): 默认"没被占用" —— 否则桩会拿表里第一行当重复
            if (/AND id\s*<>\s*\?/i.test(sql)) return null;
            // 设置页/详情页会按 id 取当前管理员: 默认回一条, 免得每个用例都要塞 rows.admin_users
            if (/FROM admin_users WHERE id\s*=\s*\?/i.test(sql)) {
              const list = rows.admin_users || [];
              return list.length ? list[0] : {
                id: 1, username: 'admin', nickname: '管理员', email: '',
                password: ADMIN_HASH, create_time: '2026-09-01 10:00:00', last_login_time: '2026-10-01 08:00:00'
              };
            }
            const table = tableOf(sql);
            if (/COUNT\(\*\)/i.test(sql)) {
              const value = counts[table];
              if (value !== undefined) return { total: value, c: value };
            }
            const list = rows[table] || [];
            return list.length ? list[0] : null;
          },
          async all() {
            if (options.db) {
              const custom = options.db(sql, entry.args, 'all');
              if (custom !== undefined) return { results: custom };
            }
            return { results: rows[tableOf(sql)] || [] };
          },
          async run() {
            if (options.db) {
              const custom = options.db(sql, entry.args, 'run');
              if (custom !== undefined) return custom;
            }
            return { meta: { changes: 1, last_row_id: 42 } };
          }
        };
        return api;
      },
      // batch 按 D1 的真实形状回: 每条语句一项 { results, meta }。
      // COUNT 语句用 counts[表名] 喂数(与 first() 同一口径), 这样统计页的用例可以直接写期望值。
      async batch(list) {
        if (options.batch) return options.batch(list);
        return list.map((statement) => {
          const sql = String((statement && statement.sql) || '');
          if (/COUNT\(\*\)/i.test(sql)) {
            const value = counts[tableOf(sql)] || 0;
            return { results: [{ c: value }], meta: { changes: 0 } };
          }
          return { results: [], meta: { changes: 1 } };
        });
      }
    }
  };
  return { env, state, adminRow };
}

function request(path, options = {}) {
  const method = options.method || 'GET';
  const headers = Object.assign({ origin: HOST }, options.headers || {});
  if (options.cookie) headers.cookie = options.cookie;
  const init = { method, headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(options.body).toString();
  }
  return new Request(`${HOST}${path}`, init);
}

// 与 main.js 一致: 后台入口的版本号由调用方注入(唯一来源是 main.js 的 API_VERSION)
const ADMIN_OPTIONS = { version: API_VERSION };
export const get = (path, env, cookie) => handleAdmin(request(path, { env, cookie }), env, ADMIN_OPTIONS);

export const post = (path, body, env, cookie) => handleAdmin(request(path, { method: 'POST', body, env, cookie }), env, ADMIN_OPTIONS);

export async function loginCookie(env) {
  const res = await post('/admin/login', { username: 'admin', password: ADMIN_PASSWORD }, env);
  return String(res.headers.get('set-cookie') || '').split(';')[0];
}

// 找出桩里收到过的某类 SQL(断言"到底发没发/参数对不对")
export function findCall(state, pattern) {
  return state.calls.find((item) => pattern.test(item.sql)) || null;
}
