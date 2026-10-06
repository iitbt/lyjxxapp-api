-- 限流计数表(新站新增, 不属于旧库结构)
-- 为什么不用 Durable Objects: 只在 Workers 付费套餐可用, 本项目用免费套餐
-- 用法: wrangler d1 execute <DB_NAME> --file=app/api-cf/schema/0002_rate_limit.sql --remote

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  scope TEXT NOT NULL,            -- 限流场景: like / favorite / share / comment / view_history / avatar / login
  bucket_key TEXT NOT NULL,       -- 用户维度 w:<user_id>; IP 维度 ip:<客户端IP>
  window_start INTEGER NOT NULL,  -- 固定窗口起点(Unix 秒, 按窗口大小向下取整)
  count INTEGER NOT NULL DEFAULT 0,
  update_time TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 唯一键就是"同一场景 + 同一对象 + 同一窗口"一行, 靠 upsert 自增
CREATE UNIQUE INDEX IF NOT EXISTS rate_limit_counters_key ON rate_limit_counters (scope, bucket_key, window_start);

-- 过期行清理用(Cron Trigger 定期删)
CREATE INDEX IF NOT EXISTS rate_limit_counters_expire ON rate_limit_counters (window_start);
