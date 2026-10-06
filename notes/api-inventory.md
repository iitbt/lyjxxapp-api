# 对外接口台账（`Plan.md` 的取值来源）

依据：逐文件通读 `fastapi/main.py`、`fastapi/app/api/*.py`、`fastapi/app/core/{health,metrics}.py`（2026-10-04）。**对外路由共 33 条**，涉及 7 个文件；`/favicon.ico` 与 4 个静态挂载不计入。

## 一、挂载情况（`main.py`）

| 位置 | 内容 |
| --- | --- |
| `main.py:1596-1600` | `user` / `news` / `content` / `app_config` / `service_status` 五个 router，无 prefix、无 tags，全部非 admin |
| `main.py:1609` | `core.health` router，始终挂载 |
| `main.py:1611-1614` | `core.metrics` router，仅 `OBSERVABILITY_ENABLED` 时挂载 |
| `main.py:1617-1620` | `app.admin.router`，**prefix=/admin（本次排除）** |
| `main.py:1590-1593` | StaticFiles 挂载：`/avatar_uploads`、`/news_uploads`、`/admin/static`、`/images` |
| `main.py:1671` | `GET /favicon.ico` |

## 二、逐条清单（33）

### `app/api/user.py`（9 条）

| 方法 | 路径 | 登录 | 作用 | 关键字段（请求 → 响应 data） | 依据 |
| --- | --- | --- | --- | --- | --- |
| POST | `/user/login` | 否 | 微信登录，不存在则注册 | `login_type,code,nickname,avatar` → `id,username,nickname,nickname_raw,avatar(绝对URL),login_type,is_trusted,token` | `246,390` |
| POST | `/user/get_user_info` | 是 | 取资料 | `token` → 同上 | `423,452` |
| POST | `/user/update_profile` | 是 | 改昵称/头像 | `token,nickname,avatar` → `nickname` / `avatar_url` | `471,607` |
| POST | `/user/upload_avatar` | 是 | 头像上传（multipart，字段名 `avatar`） | → `avatar_url`（绝对 URL） | `618,683` |
| POST | `/user/delete_account` | 是 | 软注销 | `token,confirm=yes` | `691,710` |
| POST | `/user/deleted_account_action` | 否 | 注销后 `defer/restore/purge` | `code` → `account_deleted` | `752,804` |
| POST | `/user/user_favorites` | 是 | 收藏列表 / 增删 | `token,action,page,page_size,content_id` → `favorites[],page,page_size,has_more` | `859,932` |
| POST | `/user/user_likes` | 是 | 点赞列表 | 同上 | `864` |
| POST | `/user/user_view_history` | 是 | 浏览历史 / 增删 | `token,action,page,page_size,content_id,news_id` → `views[],has_more` | `998,1061,1101` |

### `app/api/news.py`（9 条）

| 方法 | 路径 | 登录 | 作用 | 关键字段 | 依据 |
| --- | --- | --- | --- | --- | --- |
| GET | `/news/list` | 否 | 列表（无 `page` 返回数组） | `page,page_size/limit,category,token` → 有 page：`list,total,page,page_size,has_more` | `229,334,337` |
| GET | `/news/detail` | 否 | 详情 | `id,token` → 笔记全字段 + `author,author_nickname,is_admin,is_liked,is_favorited,is_shared,is_viewed` | `344,394,400` |
| POST | `/news/like` | 是 | 点赞 | `news_id,action(add/remove)` → `likes,is_liked` | `422,453` |
| POST | `/news/favorite` | 是 | 收藏 | 同上 | `459,488` |
| POST | `/news/share` | 否 | 分享计数（可游客） | `news_id` → `shares,is_shared` | `527,573` |
| POST | `/news/add_comment` | 是 | 留言（≤500 字） | `news_id,content` → `id,status,is_approved` | `580,635` |
| GET | `/news/get_comments` | 否 | 评论列表 | `news_id,page,limit` → `comments[],pagination{total,total_pages,current_page,limit,has_more}` | `645,716` |
| GET/POST | `/news/check_user_action` | 否（须给 `user_id`） | 行为状态 | `news_id,user_id` → 4 个 bool + `likes,favorites,view_count,shares` | `731,766` |
| POST | `/news/check_user_like_batch` | 是 | 批量点赞态（≤200 个） | `news_ids` → `liked_news_ids` | `785,814` |

### `app/api/content.py`（6 条）

| 方法 | 路径 | 登录 | 作用 | 关键字段 | 依据 |
| --- | --- | --- | --- | --- | --- |
| GET/POST | `/content/get_banners` | 否 | 轮播图 | `position,limit(≤50)` → `[{id,title,image_url,link_url}]`，**`code=0`** | `56,82-84` |
| GET/POST | `/content/get_outdoor` | 否 | 户外专题分页 | `page,page_size(≤20),token` → `list,total,page,page_size`；`video_url` 仅内部测试可见 | `247,150-170` |
| GET/POST | `/content/get_motorcycle` | 否 | 摩旅专题分页 | 同上 | `256,231-238` |
| GET/POST | `/content/get_notices` | 否 | 公告分页 | `page,page_size(≤20),token` → 含 `level,level_text,link_type,link_value,published_at,is_read` | `407,487,503` |
| GET/POST | `/content/get_notice_unread` | 是 | 未读数 | `token` → `unread_count,ids` | `518,538,562` |
| POST | `/content/notice_read` | 是 | 标记已读 | `token,notice_id` → `notice_id,unread_count` | `565,596` |

### `app/api/app_config.py`（1 条）

| 方法 | 路径 | 登录 | 作用 | 关键字段 | 依据 |
| --- | --- | --- | --- | --- | --- |
| GET/POST | `/config/get_app_config` | 否 | 小程序整包配置 | 无参 → `categories,home_sections,featured,version,texts,menu` + `timestamp` | `337,388-405` |

### `app/api/service_status.py`（5 条）

| 方法 | 路径 | 登录 | 作用 | 依据 |
| --- | --- | --- | --- | --- |
| GET | `/` | 否 | 状态页（HTML；`?format=json` 或 AJAX 返回 `{name,description,status,server_time}`） | `161,178` |
| GET/POST | `/test` | 否 | 301 重定向到 **`/apitest`**（实测 `api0.250036.xyz/test` → `location: /apitest`） | `220,223` |
| GET/POST | `/index` | 否 | 301 重定向 | `324,328` |
| GET/POST | `/info` | 否 | 301 重定向 | `325,328` |
| GET/POST | `/apitest` | 否 | 连通性探测（`ENABLE_PUBLIC_PROBE` 可关） | `280,286,304` |

### `app/core/`（3 条）

| 方法 | 路径 | 登录 | 作用 | 依据 |
| --- | --- | --- | --- | --- |
| GET | `/health` | 否 | 存活探针（`status,service,uptime_s,server_time,checks`） | `health.py:82` |
| GET | `/health/ready` | 否 | 就绪探针（未就绪 503） | `health.py:100,148` |
| GET | `/metrics` | 否 | Prometheus 文本（仅开关开启时挂载） | `metrics.py:133` |

## 二·五、后台（管理端）路由台账

迁移目标 `app/api-cf/admin/`：**17 个页面已全量迁移**；数据库工具与素材库治理两页**明确不迁移**（用 D1 控制台代替）。
权限口径由 `admin/lib/entities.js` 的四份写路径清单统一决定（分发前拦截，未登记一律拒绝）；
角色 `admin_users.role ∈ super/admin/normal`，会话带口令指纹（改口令即踢下线）。

| 分组 | 页面（GET） | 写入口 | 权限 |
| --- | --- | --- | --- |
| 概览 | `/admin/dashboard` | —— | 登录即可 |
| 用户 | `/admin/users`、`/admin/users_rows`、`/admin/user_detail` | `POST /admin/users`（设/取消内部测试、恢复账号、彻底删除） | **仅超管** |
| 用户笔记 | `/admin/user_news_manage`、`/admin/user_news_rows` | `POST /admin/user_news_manage`（通过/驳回/移入回收站） | **仅超管** |
| 管理员 | `/admin/admin_users`、`/admin/admin_users_rows` | `POST /admin/admin_users`（新增/删除/重置口令） | **仅超管** |
| 笔记 | `/admin/news_manage`、`news_manage_rows`、`news_preview`、`news_edit`、`news_recycle` | `news_edit`（发布/编辑）、`news_copy`、`news_batch_action`、`news_restore` | 复制/批量 **仅超管** |
| | 同上 | `news_delete`（软删除）、`news_purge`（彻底删） | **仅超管** |
| 留言 | `/admin/comments_manage`、`comments_rows` | `POST /admin/comments_manage`（通过/拒绝/删除） | **仅超管** |
| 分类 | `/admin/app_category_manage`、`app_category_edit`、`app_category_delete_confirm` | `app_category_edit`、`app_category_delete` | 登录即可 |
| 公告 | `/admin/notice_manage`、`notice_rows`、`notice_edit` | `notice_edit`、`notice_delete` | 登录即可 |
| 轮播图 | `/admin/banner_manage`、`banner_rows`、`banner_edit` | `banner_edit`、`banner_copy`、`banner_delete` | 删除/复制 **仅超管** |
| 首页板块 | `/admin/app_home_manage`、`app_home_edit` | `app_home_edit`、`app_home_delete` | 登录即可 |
| 首页精选 | `/admin/app_featured_manage`、`app_featured_edit` | `app_featured_edit`、`app_featured_delete` | 登录即可 |
| 专题精选 | `/admin/topics_manage`、`motorcycle_edit`、`outdoor_edit`、`*_preview`、`*_manage`(302→聚合页)、`*_rows` | `motorcycle_edit/outdoor_edit`、`motorcycle_delete/outdoor_delete` | 删除 **仅超管** |
| 版本配置 | `/admin/app_version_edit` | 同路径 POST（单行 upsert，id=1） | 登录即可 |
| 运营文案 | `/admin/app_text_manage`、`app_text_edit` | `app_text_edit`、`app_text_delete` | 登录即可 |
| 我的页菜单 | `/admin/app_menu_manage`、`app_menu_edit` | `app_menu_edit`、`app_menu_delete`、`app_menu_restore_missing`（补齐内置项） | 登录即可 |
| 管理员设置 | `/admin/settings` | 同路径 POST（`update_profile` / `change_password` 隐藏域区分） | 本人 |
| 系统信息 | `/admin/system_info` | —— | 登录即可 |
| 上传与素材 | —— | `POST /admin/image_upload`（旧地址 `news_image_upload`）；`GET /admin/media_library`、`media_videos` | 登录即可 |
| 删除确认 | `/admin/delete_confirm?kind=&id=&back=` | ——（跳各模块删除接口） | 登录即可 |

> 权限分类不是"多几行"的问题：**未登记写入口默认拒绝**并记 warn，`node --test` 里有自检断言全部写入口都能归类。

## 三、响应格式（**不统一，必须逐接口对齐**）

- 构造函数：`app/core/response.py:10` `resp()` → `{code,msg,data}`；`:15 resp_no_data`；`:20 resp_message` → `{code,message,data}`。
- 成功码：多数 `200`；`/content/get_banners` 为 **`0`**（`content.py:84`）；`_legacy_ok` 额外带 `status:'success'` 与 `message`（`content.py:100`）；`get_app_config`、`get_notices` 用 `message` 键（`app_config.py:390`、`content.py:505`）；`/news/list` 无 `page` 时只有 `{code,data}`；`/apitest` 带 `timestamp`。
- 错误码与文案：400「参数错误」；401「未授权，请先登录」/「登录已过期，请重新登录」/「未登录」；403「身份校验失败，请重新登录」；404「笔记不存在或已删除」；409 已注销（`user.py:76-77`）；429「操作过于频繁，请稍后再试」；500「服务器错误，请稍后重试」；503「服务繁忙」；422「参数不合法」（`main.py:1448`）。
- 分页口径三种并存：`MAX_PAGE_SIZE=50`（`schemas.py:16`）、页面级上限（公告 20 / 轮播 50 / 用户侧默认 10）、`PAGE_MAX=1000`（`helpers.py:553`）；`has_more` 有"行数够"（`user.py:934,1063`）与"按 total 算"（`news.py:339`、`content.py:513`）两种，评论另走 `pagination.has_more`。

## 四、鉴权

- **没有中间件/依赖注入**，全部路由内手工校验：`helpers.py:582,598` `validate_token_and_get_user_id(_async)` → `SELECT id FROM users WHERE token=?`；`news.py:75-104` `_identity_check` 额外做 token ↔ body `user_id` 一致性。
- token：`secrets.token_urlsafe(32)`，写入 `users.token`（`user.py:276,372,811`）；来源顺序 body/query → `Authorization: Bearer`（`helpers.py:453-476`）。
- 失败：401；数据库抖动抛 `IdentityStoreUnavailable` → 503（`helpers.py:572,595`）。

## 五、对外接口与管理功能的耦合点（拆分依据）

| 字段 | 出现位置 | 处理方式 |
| --- | --- | --- |
| `is_trusted` | 下发 `user.py:84,302,444,464`；留言免审 `news.py:615-618`；专题 `video_url` 可见性 `content.py:150-170` | 保留字段与语义，值来自 `users.is_trusted`，写路径不在本次范围 |
| `is_admin` | 作者标识 `news.py:394-396`；列表 `type IN ('admin_users','users')` `news.py:258-259` | 仅语义，不查 `admin_users` 表 |
| `trusted_only` | 菜单项下发 `app_config.py:306-308,401` | 原样透传 |
| `admin_users` 表 | **对外接口一律不查**（仅 `core/seed.py:61-104` 与 admin 包使用） | 不迁移该表 |

## 六、排除清单（本次不迁移）

`app/admin/` 全部：27 个 py + 58 个 Jinja2 模板（登录、仪表盘、用户与管理员、笔记与回收站、轮播图、分类、首页板块、精选、专题、公告、留言、配置中心、设置、工具、数据库管理、素材库管理）、`/admin/static` 静态资源、`admin_users` 表与超管权限口径、管理端上传与审计落盘。
