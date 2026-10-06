-- 管理员账号表: 供 /admin 登录使用
-- 与旧库 fastapi/app/sql/schema_sqlite.sql 的 admin_users 同构, 只把时间默认值改成 +8 小时(新站统一口径)
-- 部署后表是空的, 访问 /admin/bootstrap 建第一个超管(仅在表为空时可用)
CREATE TABLE IF NOT EXISTS "admin_users" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "username" TEXT NOT NULL,
  "nickname" TEXT,
  "password" TEXT,
  "login_type" TEXT DEFAULT 'account',
  "create_time" TEXT DEFAULT (datetime('now','+8 hours')),
  "last_login_time" TEXT,
  "avatar" TEXT,
  "email" TEXT,
  "role" TEXT DEFAULT 'normal'
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username ON admin_users (username);
