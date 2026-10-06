-- 微信 access_token 缓存表(新站新增): 必须复用同一 token, 反复获取会顶掉旧的
-- 用法: wrangler d1 execute <DB_NAME> --file=app/api-cf/schema/0003_wechat_token.sql --remote

CREATE TABLE IF NOT EXISTS wechat_tokens (
  name TEXT PRIMARY KEY,       -- 目前只有 access_token 一条
  token TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,  -- Unix 秒, 已按提前 300 秒过期写入
  update_time TEXT DEFAULT (datetime('now','+8 hours'))
);
