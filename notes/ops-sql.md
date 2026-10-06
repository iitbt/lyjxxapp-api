# 运营改数据：手工执行 SQL 速查（已定方案）

切换后管理后台留在旧站、旧库，**D1 只能由你手工改**。这份小抄覆盖运营日常要改的 8 张配置表，语句都是可直接执行的成品。

## 零、怎么执行

```bash
# 单条
wrangler d1 execute <DB_NAME> --remote --command "SELECT text_key, content FROM app_texts WHERE text_key='login.prompt';"

# 多条（把下面的语句存成文件）
wrangler d1 execute <DB_NAME> --remote --file=app/api-cf/notes/ops-change.sql
```

改之前**先说清要改什么**，改完用同一条 `SELECT` 复核；这几张表的字段都是"相对路径 or 完整 URL"两种都收，与旧后台口径一致。

## 一、文案 `app_texts`（按 `text_key` 唯一）

```sql
INSERT INTO app_texts (text_key, title, content, group_name, sort_order, status)
VALUES ('login.prompt', '授权登录提示语', '登录后可同步收藏与点赞', '登录授权', 10, 1)
ON CONFLICT(text_key) DO UPDATE SET
  title = excluded.title, content = excluded.content, group_name = excluded.group_name,
  sort_order = excluded.sort_order, status = excluded.status,
  update_time = datetime('now','+8 hours');
```

## 二、「我的」页菜单 `app_menu_items`（按 `menu_key` 唯一）

```sql
INSERT INTO app_menu_items (menu_key, title, icon, link_type, link_value, need_login, trusted_only, sort_order, status)
VALUES ('likes', '我的点赞', '/images/like.png', 'page', '/pages/likes/likes', 1, 0, 20, 1)
ON CONFLICT(menu_key) DO UPDATE SET
  title = excluded.title, icon = excluded.icon, link_type = excluded.link_type,
  link_value = excluded.link_value, need_login = excluded.need_login,
  trusted_only = excluded.trusted_only, sort_order = excluded.sort_order, status = excluded.status,
  update_time = datetime('now','+8 hours');
```

- `need_login=1` = 未登录点击提示先登录；`trusted_only=1` = 仅内部测试用户可见（两个字段只能是 0 或 1）。

## 三、轮播图 `banner_images`（无唯一键，按 `id` 改）

```sql
-- 新增一张（position 与前台一致: news 为笔记首页）
INSERT INTO banner_images (title, image_url, link_url, position, sort_order, status, create_time, update_time)
VALUES ('国庆活动', 'news_uploads/home/banner_101.png', '/pages/activity/activity', 'news', 5, 1, datetime('now','+8 hours'), datetime('now','+8 hours'));

-- 换图 / 换跳转 / 下架（把 1 改成实际 id）
UPDATE banner_images SET image_url = 'news_uploads/home/banner_101.png', update_time = datetime('now','+8 hours') WHERE id = 1;

UPDATE banner_images SET status = 0, update_time = datetime('now','+8 hours') WHERE id = 1;
```

## 四、公告 `app_notices`（无唯一键，用 `INSERT` / 按 `id` 改）

```sql
INSERT INTO app_notices (title, content, level, link_type, link_value, start_at, end_at, sort_order, status, create_time)
VALUES ('国庆期间暂停配送', '10 月 1 日至 3 日暂停发货。', 'warning', '', '', '2026-10-01 00:00:00', '2026-10-04 00:00:00', 10, 1, datetime('now','+8 hours'));

UPDATE app_notices SET status = 0, update_time = datetime('now','+8 hours') WHERE id = 1;
```

- `level` 只用 `info` / `warning` / `important`（前台按它显示颜色）；`start_at`、`end_at` 留空表示不限时间。

## 五、精选项 `app_featured_items`（`page_path` 必填）

```sql
INSERT INTO app_featured_items (item_key, name, image_url, page_path, sort_order, status)
SELECT 'outdoor', '户外精选', 'images/featured/outdoor.png', '/pages/outdoor/outdoor', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM app_featured_items WHERE item_key = 'outdoor');

UPDATE app_featured_items SET image_url = 'images/featured/outdoor.png', page_path = '/pages/outdoor/outdoor', update_time = datetime('now','+8 hours')
WHERE item_key = 'outdoor';
```

## 六、首页板块 `app_home_sections`（`featured` 板块才用 `page_path`）

```sql
INSERT INTO app_home_sections (section_key, item_id, name, image_url, page_path, sort_order, status)
VALUES ('featured', 'outdoor', '户外精选', 'images/featured/outdoor.png', '/pages/outdoor/outdoor', 1, 1);

UPDATE app_home_sections SET status = 0, update_time = datetime('now','+8 hours') WHERE section_key = 'featured' AND item_id = 'outdoor';
```

- `section_key` 三种：`main`（主题项目）/ `ext`（更多）/ `featured`（精选）。

## 七、分类 `app_categories`（按 `category_key` 唯一）

```sql
INSERT INTO app_categories (category_key, name, sort_order, status)
VALUES ('outdoor', '户外', 10, 1)
ON CONFLICT(category_key) DO UPDATE SET
  name = excluded.name, sort_order = excluded.sort_order, status = excluded.status,
  update_time = datetime('now','+8 hours');
```

> 新增分类后，首页板块与精选里的 `item_id` / `item_key` 必须引用**已启用**的分类标识，否则前台不展示（与旧后台同一口径）。

## 八、版本更新提示 `app_version_config`（永远只有 `id=1` 一行）

```sql
INSERT INTO app_version_config (id, latest_version, min_version, update_tip, update_content, update_time)
VALUES (1, '4.3.1', '4.0.0', '本次更新：列表更快、公告更准', '1. 列表分页与下拉刷新优化\n2. 公告红点更准', datetime('now','+8 hours'))
ON CONFLICT(id) DO UPDATE SET
  latest_version = excluded.latest_version, min_version = excluded.min_version,
  update_tip = excluded.update_tip, update_content = excluded.update_content,
  update_time = excluded.update_time;
```

- 版本号必须形如 `4.3.1`（两到四段数字）；`latest_version` 留空 = 不提示更新。

## 九、改错了怎么还原

1. **先备份再动手**：把要改的行 `SELECT * FROM 表 WHERE ...;` 结果存下来。
2. 改错了：用备份值原样 `UPDATE` 回去；或直接从旧库重导这一张表（`export_sqlite.py` 会导出全部 18 张表）。
3. 涉及删除时优先 `status = 0`（停用）而不是 `DELETE`，可随时恢复。

## 十、通用注意

- `status`、`need_login`、`trusted_only` 一律 0/1，不要写 `true`/`Y`。
- 时间统一 `datetime('now','+8 hours')`（全站东八区），不要写 `localtime`。
- 只改这 8 张配置表；`news`、`users`、`news_likes` 等是**小程序产生的数据**，不要手工改。
- 当前设计**不加 edge 缓存**，所以改完立即生效；若以后加了缓存，改完必须清对应缓存（届时补进本小抄）。
- 图片字段填**站内相对路径**（如 `news_uploads/home/x.png`）最稳；填完整 URL 也能用，但要保证域名与 `media` 域一致。
