-- D1 建表脚本(仅对外 API 所需 18 张表)
-- 来源: 旧库 fastapi/data/lyjx.db 的真实 DDL(含运行时自愈补出的列), 而非静态的 app/sql/schema_sqlite.sql
-- 差异一: 剔除 admin_users(管理后台专用)、schema_migrations(旧库自愈台账)、app_api_routes(代码已无引用的遗留表)
-- 差异二: datetime('now','localtime') 改为 datetime('now','+8 hours'), 固定东八区且不依赖时区表
-- 保留说明: news.type 的默认值 'admin_users' 属业务取值, 原样保留
-- 用法: wrangler d1 execute <DB_NAME> --file=app/api-cf/schema/0001_schema.sql --remote
CREATE TABLE app_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_key TEXT NOT NULL,            -- outdoor / motorcycle ...(小写字母数字下划线)
  name TEXT NOT NULL DEFAULT '',         -- 展示名(户外 / 摩旅 ...)
  sort_order INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,     -- 1 启用 / 0 停用
  create_time TEXT DEFAULT (datetime('now','+8 hours')),
  update_time TEXT
);
CREATE TABLE app_featured_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key TEXT NOT NULL,               -- 笔记分类标识(如 outdoor): 与首页板块同口径
  name TEXT NOT NULL DEFAULT '',        -- 入库快照; 下发/展示时实时取自分类表
  image_url TEXT NOT NULL DEFAULT '',   -- 站内相对路径或完整 URL(圆形展示, 建议方形图)
  page_path TEXT NOT NULL DEFAULT '',   -- 小程序跳转页面(精选的核心字段, 后台必填)
  sort_order INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,    -- 1 启用 / 0 停用
  create_time TEXT DEFAULT (datetime('now','+8 hours')),
  update_time TEXT
);
CREATE TABLE app_home_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_key TEXT NOT NULL,            -- main / ext / featured
  item_id TEXT NOT NULL,                -- outdoor / motorcycle ...(精选页兼作跳转标识)
  name TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',   -- 站内相对路径或完整 URL
  page_path TEXT DEFAULT '',            -- 仅 featured 使用(小程序跳转页面)
  sort_order INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,    -- 1 启用 / 0 停用
  create_time TEXT DEFAULT (datetime('now','+8 hours')),
  update_time TEXT
);
CREATE TABLE app_menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_key TEXT NOT NULL,                    -- 菜单标识(本表内唯一, 前端当 wx:key 用)
  title TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',             -- 本地图标(/images/x.png)或完整 https 地址
  link_type TEXT NOT NULL DEFAULT 'page',
  link_value TEXT NOT NULL DEFAULT '',
  need_login INTEGER NOT NULL DEFAULT 0,     -- 1=未登录点击提示先登录
  trusted_only INTEGER NOT NULL DEFAULT 0,   -- 1=仅特权用户可见
  sort_order INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  create_time TEXT DEFAULT (datetime('now','+8 hours')),
  update_time TEXT
);
CREATE TABLE app_notice_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  notice_id INTEGER NOT NULL,
  read_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE app_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT,
  level TEXT NOT NULL DEFAULT 'info',        -- info / warning / important
  link_type TEXT NOT NULL DEFAULT '',        -- 空=不跳转 / page=小程序页面路径
  link_value TEXT NOT NULL DEFAULT '',
  start_at TEXT,                             -- 生效开始时间(空=不限)
  end_at TEXT,                               -- 生效结束时间(空=不限)
  sort_order INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  create_time TEXT DEFAULT (datetime('now','+8 hours')),
  update_time TEXT
);
CREATE TABLE app_texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text_key TEXT NOT NULL,                    -- 文案标识(模块.用途, 如 login.prompt)
  title TEXT NOT NULL DEFAULT '',            -- 后台列表里的说明文字
  content TEXT,                              -- 文案正文(可多行)
  group_name TEXT NOT NULL DEFAULT '',       -- 分组: 登录授权 / 隐私与关于 / 分享
  sort_order INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,         -- 1 启用 / 0 停用
  create_time TEXT DEFAULT (datetime('now','+8 hours')),
  update_time TEXT
);
CREATE TABLE app_version_config (
  id INTEGER PRIMARY KEY,
  latest_version TEXT NOT NULL DEFAULT '',   -- 最新版本号(留空=不提示更新)
  min_version TEXT NOT NULL DEFAULT '',      -- 最低可用版本号(低于它强制更新)
  update_tip TEXT NOT NULL DEFAULT '',       -- 一句话更新提示
  update_content TEXT,                       -- 更新说明(多行, 可选)
  update_time TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE "banner_images" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "title" TEXT NOT NULL DEFAULT '',
  "image_url" TEXT NOT NULL DEFAULT '',
  "link_url" TEXT,
  "position" TEXT NOT NULL DEFAULT 'news',
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "status" INTEGER NOT NULL DEFAULT 1,
  "create_time" TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  "update_time" TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE "motorcycle_trips" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "title" TEXT NOT NULL DEFAULT '',
  "description" TEXT NOT NULL DEFAULT '',
  "distance" TEXT NOT NULL DEFAULT '',
  "duration" TEXT NOT NULL DEFAULT '',
  "difficulty" TEXT NOT NULL DEFAULT '',
  "poster" TEXT NOT NULL DEFAULT '',
  "videoUrl" TEXT,
  "status" TEXT DEFAULT 'approved',
  "created_at" TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE "news" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER,
  "title" TEXT NOT NULL DEFAULT '',
  "desc" TEXT,
  "content" TEXT,
  "category" TEXT NOT NULL DEFAULT '',
  "image" TEXT,
  "video_url" TEXT,
  "publish_time" TEXT DEFAULT (datetime('now','+8 hours')),
  "activity_time" TEXT,
  "view_count" INTEGER NOT NULL DEFAULT 0,
  "shares" INTEGER DEFAULT 0,
  "likes" INTEGER DEFAULT 0,
  "favorites" INTEGER DEFAULT 0,
  "type" TEXT DEFAULT 'admin_users',
  "status" TEXT DEFAULT 'approved'
, deleted_at TEXT);
CREATE TABLE "news_comments" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "news_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0,
  "content" TEXT NOT NULL DEFAULT '',
  "status" TEXT DEFAULT 'pending',
  "created_at" TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE "news_favorites" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "news_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE "news_likes" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "news_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE "news_shares" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "news_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE "news_view_history" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "news_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE "outdoor_activities" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "title" TEXT NOT NULL DEFAULT '',
  "description" TEXT NOT NULL DEFAULT '',
  "date" TEXT NOT NULL DEFAULT '',
  "location" TEXT NOT NULL DEFAULT '',
  "poster" TEXT NOT NULL DEFAULT '',
  "videoUrl" TEXT,
  "status" TEXT DEFAULT 'approved',
  "created_at" TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE "users" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "openid" TEXT,
  "username" TEXT,
  "nickname" TEXT,
  "password" TEXT,
  "login_type" TEXT DEFAULT 'account',
  "email" TEXT,
  "avatar" TEXT,
  "token" TEXT,
  "create_time" TEXT DEFAULT (datetime('now','+8 hours')),
  "last_login_time" TEXT,
  "is_trusted" INTEGER NOT NULL DEFAULT 0
, status INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, orig_nickname TEXT, orig_avatar TEXT, nickname_modified INTEGER NOT NULL DEFAULT 0, raw_nickname TEXT);
CREATE UNIQUE INDEX app_categories_key ON app_categories (category_key);
CREATE UNIQUE INDEX app_featured_items_uniq
  ON app_featured_items (item_key);
CREATE INDEX idx_app_featured_items_status
  ON app_featured_items (status, sort_order, id);
CREATE INDEX idx_app_home_sections_key
  ON app_home_sections (section_key, status, sort_order);
CREATE UNIQUE INDEX app_menu_items_key ON app_menu_items (menu_key);
CREATE INDEX idx_app_menu_items_status ON app_menu_items (status, sort_order, id);
CREATE UNIQUE INDEX app_notice_reads_uniq ON app_notice_reads (user_id, notice_id);
CREATE INDEX idx_app_notices_active ON app_notices (status, sort_order, id);
CREATE UNIQUE INDEX app_texts_key ON app_texts (text_key);
CREATE INDEX idx_app_texts_group ON app_texts (group_name, status, sort_order);
CREATE INDEX idx_banner_pos_status_sort ON banner_images (position, status, sort_order, id);
CREATE INDEX "idx_position_status" ON "banner_images" ("position", "status");
CREATE INDEX idx_motorcycle_status_id ON motorcycle_trips (status, id);
CREATE INDEX idx_news_category ON news (category);
CREATE INDEX idx_news_category_deleted ON news (category, deleted_at);
CREATE INDEX idx_news_publish ON news (publish_time);
CREATE INDEX idx_news_status ON news (status);
CREATE INDEX idx_news_status_deleted_publish ON news (status, deleted_at, publish_time);
CREATE INDEX "idx_news_status_type_publish" ON "news" ("status", "type", "publish_time");
CREATE INDEX idx_news_type_deleted_publish
  ON news (type, deleted_at, publish_time, id);
CREATE INDEX idx_news_user ON news (user_id);
CREATE INDEX "user_id" ON "news" ("user_id");
CREATE INDEX idx_news_comments_created ON news_comments (created_at);
CREATE INDEX idx_news_comments_news ON news_comments (news_id);
CREATE INDEX idx_news_comments_news_status ON news_comments (news_id, status, created_at);
CREATE INDEX idx_news_comments_status ON news_comments (status);
CREATE INDEX idx_news_comments_user ON news_comments (user_id);
CREATE INDEX "status" ON "news_comments" ("status");
CREATE INDEX idx_news_favorites_user ON news_favorites (user_id, created_at);
CREATE UNIQUE INDEX news_favorites_uniq ON news_favorites (news_id, user_id);
CREATE UNIQUE INDEX "unique_favorite" ON "news_favorites" ("news_id", "user_id");
CREATE INDEX idx_news_likes_user ON news_likes (user_id, created_at);
CREATE UNIQUE INDEX news_likes_uniq ON news_likes (news_id, user_id);
CREATE UNIQUE INDEX "unique_like" ON "news_likes" ("news_id", "user_id");
CREATE INDEX idx_news_shares_user ON news_shares (user_id);
CREATE UNIQUE INDEX "news_id" ON "news_shares" ("news_id", "user_id");
CREATE UNIQUE INDEX news_shares_uniq ON news_shares (news_id, user_id);
CREATE INDEX "idx_nvh_user_time" ON "news_view_history" ("user_id", "created_at", "id");
CREATE UNIQUE INDEX "news_view_history_uniq" ON "news_view_history" ("news_id", "user_id");
CREATE INDEX idx_outdoor_status_id ON outdoor_activities (status, id);
CREATE UNIQUE INDEX "email_unique" ON "users" ("email");
CREATE INDEX "idx_users_token" ON "users" ("token");
CREATE UNIQUE INDEX users_email ON users (email);
CREATE UNIQUE INDEX "users_openid" ON "users" ("openid");
CREATE UNIQUE INDEX "users_username" ON "users" ("username");
