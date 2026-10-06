# api-cf：对外 API（Cloudflare Workers + D1 + R2）

按 `Plan.md` 实现的对外 API（**不含管理功能**），33 条接口。零运行时依赖：只用 Web 标准 API + D1/R2 绑定。

> **要部署请看 `DEPLOY.md`**（网页端 Git 连接 / wrangler 命令行两条路线，含建库、建表、搬迁、素材、验证与回滚）。本文件讲本地怎么跑。

```
main.js                  入口(对照旧站 fastapi/main.py): 只做装配 —— 中间件 + 路由 + 媒体直出 + 异常兜底 + 定时任务
app/                     全部业务代码, 与 fastapi/app/ 逐层对应
├── api/                 对外接口(33 条): user / news / content / app_config / pages / service_status
│                        + helpers(鉴权与身份, 对照 fastapi/app/api/helpers.py)
│                        + schemas(参数口径常量与夹取, 对照 fastapi/app/api/schemas.py)
├── core/                平台能力(对照 fastapi/app/core/):
│                        config(配置唯一来源) / middleware(安全头·CORS·预检·请求体上限) / response(5 种响应形态)
│                        / logging(结构化日志+脱敏+审计) / db / router / health / metrics / ratelimit
│                        / storage(R2 素材) / overview(统计口径) / media_scheme / sanitize / wechat / timeutil / html / md5
├── admin/               管理后台(/admin 前缀): 见 admin/README.md
│   ├── index.js         入口分发 + 写路径分类守卫 + 会话
│   ├── pages/           各页面模块(每个模块导出 routes)
│   ├── lib/             entities(权限清单) / controlled(声明式 CRUD) / dbTool(数据库工具安全内核)
│   │                    / mediaUpload / partials / layout / nav / guard / session / password …
│   ├── assets/          生成物: 旧站 CSS/JS 的文本模块(Worker 与 Node 都能 import)
│   └── static/          旧站静态原件(生成来源与对照)
└── sql/                 D1 建表脚本(0001 业务表 / 0002 限流 / 0003 微信 token / 0004 管理员)
tools/                   导出、行数校验、对拍、真实数据冒烟、素材小抄、缩略图 key 计划
tests/                   node --test 用例(175 条), 用函数桩模拟 D1/R2, 不联网
```

> 改代码时的边界：**对外口径改 `app/api/` + `app/core/`，后台改 `app/admin/`**；`app/admin/` 只通过 `/admin` 前缀对外，不进 33 条路由表。
> `fastapi/` ↔ `app/api-cf/` 的逐目录对应关系见 `notes/structure-map.md`。

## 一、首次准备（都在你机器上执行）

```bash
# 0. 命名约定(固定不变): Worker/Pages = lyjxxapp-api ; D1 = lyjxxapp-d1 ; R2 = lyjxxapp-r2

# 1. 建库: 首次部署可交给 wrangler 自动建(wrangler.toml 里 database_id 留空), 部署后把控制台的 Database ID 回填
#    也可以先手动建: wrangler d1 create lyjxxapp-d1 → 把返回的 database_id 填回 wrangler.toml
#    控制台建库时 Location 选 Asia Pacific(亚太): 该位置建库后不可改

# 2. 建 R2 桶(Location 同样选 Asia Pacific)并绑定公开域 storage.250036.xyz(自定义域在控制台加)
#    绑定名固定 STORAGE(见 wrangler.toml 的 [[r2_buckets]])
wrangler r2 bucket create lyjxxapp-r2

# 3. 微信凭据: 编辑 .secrets.json(模板 .secrets.json.example), 然后一条命令推上去
npm run secrets:put
#    联调时可把 wrangler.toml 的 DEV_WECHAT_MOCK 改成 "1", 走假 openid, 不调微信

# 4. 建表(三段都要跑; 用 npm run schema:remote 一条命令等价)
npm run schema:remote

# 5. 搬数据(旧库只读不动; 切换前重跑一次)
python tools/export_sqlite.py ../../fastapi/data/lyjx.db out/seed.sql
wrangler d1 execute lyjxxapp-d1 --file=out/seed.sql --remote
python tools/verify_counts.py ../../fastapi/data/lyjx.db     # 配了 D1 凭据会直接比对, 必须 0 差异

# 6. 搬素材(见 tools/media_to_r2.md), 注意 app/images 里的 4 个文件放 images/ 前缀
wrangler r2 object put lyjxxapp-r2/images/user.jpg --file=../../fastapi/app/images/user.jpg

# 7. 部署
npm run deploy
```

**变量与密钥都已预置好，你只需要改值**：

| 类型 | 放在哪 | 你要做什么 |
|---|---|---|
| 变量（明文） | `wrangler.toml` 的 `[vars]`：`MEDIA_BASE`、`DEV_WECHAT_MOCK`、`UPLOAD_MAX_BYTES`、`ENABLE_PUBLIC_PROBE`、`OBSERVABILITY_ENABLED`、`ALLOWED_ORIGINS`、`ENABLE_SQL_TOOL` | 需要改就改值 → 重新部署，部署时自动写进 Cloudflare，**不用去控制台手点** |
| 密钥（密文，生产） | `.secrets.json`（模板 `.secrets.json.example`）：`WECHAT_APPID`、`WECHAT_SECRET`、`ADMIN_SESSION_SECRET` | 填值 → `npm run secrets:put`（= `wrangler secret bulk`）一条命令推三个 |
| 密钥（密文，本机） | `.dev.vars`（模板 `.dev.vars.example`）：同样三个 | 只给 `npm run dev` 用；**两个文件都要填，互不替代**（一个管本机、一个管线上） |
| 绑定 | `wrangler.toml`：D1 `DB` → `lyjxxapp-d1`、R2 **`STORAGE`** → `lyjxxapp-r2` | 只需先把库与桶建好（`wrangler d1 create lyjxxapp-d1` / `wrangler r2 bucket create lyjxxapp-r2`）；代码侧只读 `core/config.js` 的 `storage`（兼容早期绑定名 `MEDIA`） |

## 二、本地开发与自测

```bash
npm run schema:local   # 本地 SQLite 建表(0001+0002+0003 中的前两个 + 0003 按需)
npm run dev            # wrangler dev --local, 默认 http://127.0.0.1:8787
npm test               # node --test, 175 条用例, 不需要网络与云账号
```

手工验收（`wrangler dev` 起来后，把 33 条逐条打一遍；`/news/list` 要同时试带 `page` 与不带 `page`）：

```bash
curl -s 'http://127.0.0.1:8787/news/list'
curl -s 'http://127.0.0.1:8787/news/list?page=1&page_size=2'
curl -s 'http://127.0.0.1:8787/content/get_banners?format=json'
curl -s 'http://127.0.0.1:8787/config/get_app_config'
curl -s 'http://127.0.0.1:8787/health/ready'
curl -s 'http://127.0.0.1:8787/?format=json'
curl -s -X POST 'http://127.0.0.1:8787/user/login' -H 'content-type: application/json' \
  -d '{"login_type":"wechat","code":"dev-code","nickname":"测试"}'
```

## 二·五、真实数据端到端验证（切换前建议跑）

```bash
# 1) 先把旧库导出成种子(会写到 out/seed.sql)
python tools/export_sqlite.py ../../fastapi/data/lyjx.db out/seed.sql
# 2) 用真实 18 张表结构与真实数据, 在内存库里跑一遍全部关键流程(不联网、不动线上)
#    需要 Node 22+(用到内置 node:sqlite)
node tools/live_smoke.mjs
```

覆盖：列表/详情/点赞(含重复 403 与计数自增)/配额 429 与计数表/轮播/专题/公告/配置/用户资料/三个列表/登录注册/改资料/注销(半角后缀)/已注销登录 409/恢复/彻底删除/静态页/探针。
它比 `tests/` 里的桩测更狠：**SQL 会真跑**，列名写错、唯一索引冲突、`ON CONFLICT` 行为这类问题当场暴露。

## 三、新旧站对拍（切换前必做）

```bash
node tools/diff_api.mjs --old https://api0.250036.xyz --new http://127.0.0.1:8787 --token <测试账号token>
```

逐条比对同一请求在两个站上的 JSON（字段、类型、`code`/`msg`/`message` 键、分页字段），只打印差异。**有差异就必须先改到一致**，否则上线后小程序会表现异常。

## 四、响应形态的坑（已实现，别改坏）

| 接口 | 特例 |
| --- | --- |
| `/news/list` | 不带 `page` 时**只有 `{code,data}`**，没有 `msg` |
| `/content/get_banners` | `code=0`，且 `message` 与 `msg` 并存 |
| `/content/get_outdoor`、`/get_motorcycle` | `code+msg+status+message` 四键；非内部测试用户 **删掉 `video_url` 键**（不是置空），并带 `can_watch_video` |
| `/content/get_notices`、`/config/get_app_config` | 只有 `message`，没有 `msg`；notices 额外下发 `pageSize` |
| `/news/detail` | `author`/`author_nickname`/`is_admin` 三种情况按作者是否存在分别出现；正文图片补绝对地址 |
| `/news/get_comments` | `created_at` 截到分钟；不下发 `user_id`；`user_avatar` 是绝对地址 |
| 用户三个列表 | 时间字段转 **Unix 秒**；`has_more` 按"取回行数够一页"判定 |

## 五、已知差异与待确认（要新旧对拍复核）

1. **成功文案**：已按线上对拍改齐 `/apitest`（`API测试成功`）、`/content/get_outdoor`（`获取户外精选数据成功`）、`/content/get_motorcycle`（`获取摩旅精选数据成功`）、`/news/check_user_action` 的 404（`笔记不存在`）、`/` 与 `/health` 的文案/结构。
   仍待复核：`/news/like`、`/news/favorite`、用户三个列表的 `msg` —— 这些分支要带 `--token` 才能对拍（`diff_api.mjs` 的 POST 用例）。只影响提示文字，不影响数据。
2. **分享 3 秒去重**、**浏览量 60 秒去重**：旧站在进程内做，Workers 无进程内状态；浏览量去重我按"同用户 60 秒"实现，分享未做去重（每次都计数）。
3. **`access_token` 缓存**放 D1 表 `wechat_tokens`（不是 KV，不额外加绑定）。
4. **昵称送审**（微信 msg_sec_check）：拿不到 token 或接口异常时放行，只有明确判定违规（87014）才拒绝。
5. **`/health` 的 `uptime_s` 固定 0**（Worker 没有进程概念）；`/health/ready` 返回裸结构，未就绪 503；`checks` 字段是 `database/media`（旧站是 `serving_cache/cache_backend`，Worker 无缓存概念）。
6. **`/metrics`** 仅在 `OBSERVABILITY_ENABLED=1` 时输出最小 Prometheus 文本（指标集比旧站小）。
7. **`/pages/download`** 是本次新增页面（旧站没有），文案可用 `app_texts` 的 `download.tip` 覆盖。
8. **素材目录分新老两套**：新上传按类型落 `image/`（图片）、`video/`（视频）、`avatar/`（小程序头像）；历史素材仍在 `news_uploads/`、`avatar_uploads/`。列举、引用判定与 Worker 直出**同时覆盖两套**（真值在 `app/core/storage.js` 的 `MEDIA_PREFIXES` / `SERVED_PREFIXES`），数据库里的相对路径一个都不用改、R2 对象也不用搬。**缩略图规则 = 目录随原图走**（`image/a.png` → `image/_thumb/480/a.webp`，子目录扁平到 `_thumb/<宽>/`；历史 `news_uploads/a.png` → `news_uploads/_thumb/480/a.webp`，所以历史缩略图照旧命中、不用重生成）。Cloudflare 侧**只读不生成**：探不到就不下发 `image_thumb`、回退原图；新目录要补缩略图时用 `tools/thumb_plan.mjs` 算出期望 key（`--check` 报缺哪些），生成与上传由离线侧执行。旧站工具（`fastapi/app/core/storage.py::ensure_news_cover_thumb`）仍写死 `news_uploads/_thumb/`，**本次未改旧站代码**，差异见 `DEPLOY.md`「素材目录」节。
9. **`/images/*`、`/image/*`、`/video/*`、`/avatar/*`、`/news_uploads/*`、`/avatar_uploads/*` 都由 Worker 从 R2 直出**（旧站是 `StaticFiles` 挂载，同样支持 Range/206），所以 `app/images` 的 4 个文件必须上传，否则菜单图标会 404。
10. **素材对外域名 `MEDIA_BASE` 可填两种**：① R2 公开域 `https://storage.250036.xyz`（**推荐**，不经 Worker，不吃请求额度）；② Worker 域名 `https://lyjx.250036.xyz`（少维护一个域名，但每条图片/视频请求都算一次 Worker 请求）。换法只是改 `[vars]` 后重新部署，代码与数据都不用动。
11. **管理功能**：**已全量迁移**（18 个页面，含数据库工具与素材库治理），见 `app/admin/README.md`；仍未实现的是 ffmpeg（旧站也没有）与进程内缓存（先不加）。
12. **框架层状态码与旧站一致**：未知路由 = 真 HTTP 404（`{code:404,msg:"接口不存在"}`）、未捕获异常 = 真 HTTP 500、请求体 >5MB = 413、`/apitest` 关闭 = HTTP 404 + `code:404` + `接口已关闭`。**业务失败仍是 HTTP 200 + `body.code`**（这条是硬口径，别改）。
13. **CORS**：`ALLOWED_ORIGINS` 默认 `*`（与迁移前一致，小程序不带 Origin 不受影响）；填域名后只回白名单内的 Origin，且不启用 `allow-credentials`（旧站也是 `False`）。
14. **参数语义对齐**：`intOf` = 旧站 `intval`（`int(float(v))`、溢出夹 `±2^31`、非法回退）；`/news/list` 的 `page` 夹到 1000；`/content/get_notice_unread` 未登录回 **200 + `未登录` + 空数据**（旧站口径，不是 401）；请求体上限 5MB（旧站 `BODY_LIMIT_BYTES`），multipart 豁免。
15. **R2 绑定名是 `STORAGE`**（`wrangler.toml` 的 `[[r2_buckets]].binding`）：代码只从 `core/config.js` 的 `storage` 取值，那里兼容早期的 `MEDIA`；改绑定名时只改 `wrangler.toml` 一个字段。
16. **站点图标按真实格式下发**：`app/favicon.ico` 实际是 800×800 的 **PNG**（前 8 字节 PNG 魔数），所以响应与页面 `type=` 都声明 `image/png`；页面引用统一带 `?v=<内容指纹>`（`core/favicon.js` 的 `FAVICON_HASH`）—— 浏览器按**站点**记"有没有图标"，不带指纹就换不掉内联之前 404 留下的旧结论。
17. **弹窗类静态脚本由外壳统一引**：`image_upload.js`（弹窗里「上传」走 XHR + 回填字段）与 `media_library.js`（素材库弹窗拉列表 + 回填字段）在 `app/admin/lib/layout.js` 的 `MODAL_SCRIPTS` 里统一引入。旧站是 `_image_upload_field.html` / `_media_library_modal.html` **各自**带 `<script src>`，而 `partials.js` 只渲染弹窗的 HTML（不带标签）——漏引时的表现是"点上传整页刷新、素材库弹窗空白"，且**服务端直出的 `/admin/media_manage` 照常正常**（因为它不依赖脚本），很容易误判成后端问题。两个脚本都自带幂等守卫（`window.__imageUploadBound` / `window.__mediaLibraryBound`）；`tests/admin_submit_action.test.mjs` 里有一条"资源包里不许有孤儿脚本"的检查防止再漏。
18. **`route_super` 类写路径现在有两道闸**：`app/admin/index.js` 分发前按 `entities.js` 的清单拦一道（原先只靠页面自查，管理员页漏了自查 → 任何登录账号都能增删管理员/重置口令），页面内仍可再自查。

## 六、部署（你自己执行）

```bash
wrangler deploy
# 自定义域: api.250036.xyz 指向这个 Worker(控制台或 wrangler.toml 的 routes)
# 旧 api0.250036.xyz 保持不动, 作为回滚入口
```
