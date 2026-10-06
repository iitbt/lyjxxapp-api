# `fastapi/` ↔ `app/api-cf/` 结构与机制对照

这份表是"两边怎么对应"的唯一出处。改动任何一边时，先按它找到对面的文件，再决定是"必须逐字一致"（对外口径）还是"允许不同"（平台机制）。

> 结论先说：**对外行为必须一致**（33 条接口的路径、参数、响应形态、错误码与文案），
> **平台机制无法一致**（Python 进程 ↔ Worker isolate），后者在下面第 2 节逐条说明并被"替代"。

## 1. 文件/目录对照

| fastapi | app/api-cf | 说明 |
| --- | --- | --- |
| `main.py` | `main.js` | 入口只做装配：中间件 + 路由 + 静态/媒体直出 + 异常兜底 + 定时任务 |
| `app/api/user.py` | `app/api/user.js` | 用户 9 条 |
| `app/api/news.py` | `app/api/news.js` | 笔记 9 条 |
| `app/api/content.py` | `app/api/content.js` | 内容 6 条 |
| `app/api/app_config.py` | `app/api/app_config.js` | 启动配置 1 条 |
| `app/api/service_status.py` | `app/api/service_status.js` | 状态类 5 条（`/`、`/test`、`/index`、`/info`、`/apitest`） |
| `app/api/helpers.py` | `app/api/helpers.js` | token 取值顺序、身份校验、鉴权文案 |
| `app/api/schemas.py` | `app/api/schemas.js` | 参数口径常量与夹取（`PAGE_MAX`、`MAX_PAGE_SIZE`、`MAX_COMMENT_LENGTH`…） |
| `app/api/actions.py` | `app/api/news.js` + `app/api/user.js` | 点赞/收藏/浏览历史的公共实现（合并进调用方） |
| `app/core/config.py` | `app/core/config.js` | **配置唯一来源**：`settings(env)` |
| `app/core/response.py` | `app/core/response.js` | 5 种响应形态 + `fail()`（含 HTTP 状态码选项） |
| `app/core/middleware.py` | `app/core/middleware.js` | 安全头 / CORS / 预检 / 请求 ID / 请求体上限 |
| `app/core/logging.py` | `app/core/logging.js` | 结构化日志 + 键名与文本双重脱敏 + 审计 |
| `app/core/database.py` | `app/core/db.js` | D1 薄封装（`all/one/run` + `intOf/str/idList`） |
| `app/core/ratelimit.py` | `app/core/ratelimit.js` | 写操作配额（D1 计数表） |
| `app/core/wechat.py` | `app/core/wechat.js` | `code2session` + `access_token` 缓存 + 昵称送审 |
| `app/core/health.py` | `app/core/health.js` | `/health`、`/health/ready`（+ 导出的 `probe()`） |
| `app/core/metrics.py` | `app/core/metrics.js` | `/metrics` 最小 Prometheus 文本 |
| `app/core/timeutil.py` | `app/core/timeutil.js` | 东八区时间口径 |
| `app/core/media_scheme.py` | `app/core/media_scheme.js` | 素材地址拼装（`assetUrl`/`iconAssetUrl`/`thumbKey`） |
| `app/core/storage.py` | `app/core/storage.js` | 素材清单 / 占用统计 / 删除 / 路径归一化（R2） |
| `app/core/overview.py` | `app/core/overview.js` | 表行数与核心计数的**唯一实现** |
| `app/core/catalog.py` | `app/api/app_config.js` 的内置兜底常量 | 配置全回退默认值 |
| `app/core/security.py` | `app/admin/lib/password.js` + `session.js` | 口令哈希与会话签名（仅后台用） |
| `app/core/cache.py`、`distcache.py` | 无 | Worker 无进程内缓存（见第 2 节） |
| `app/core/db_pool.py`、`db_dialect.py`、`schema_init.py`、`seed.py` | 无 | D1 托管 + 一次性建表脚本（`app/sql/`） |
| `app/core/common.py`、`stats.py`、`debounce.py`、`account_ops.py`、`category_source.py` | 拆分进 `app/core/*` 与 `app/admin/lib/*` | 无一对一同名文件，按用途归位 |
| `app/admin/**`（27 py + 58 模板） | `app/admin/**`（pages/lib/assets/static） | 后台：页面模块化 + 字符串拼 HTML（见 `app/admin/README.md`） |
| `app/sql/*.sql` | `app/sql/*.sql` | 建表脚本，命名与顺序一致（0001 业务 / 0002 限流 / 0003 token / 0004 管理员） |
| `tests/` | `tests/` | `node --test`（142 条），桩模拟 D1/R2 |
| `tools/*.py`（6 个 CLI） | `tools/*.py` + `*.mjs` | 导出、行数校验、对拍、冒烟、素材小抄 |

## 2. 机制对照：能对齐的 / 只能替代的

| 机制 | fastapi | app/api-cf | 状态 |
| --- | --- | --- | --- |
| 路由定义 | `@router.get(...)` 装饰器 | `router.get(path, handler)` 注册表（`app/core/router.js`） | **形态不同，行为一致**（路径/方法/免登录名单逐条对齐） |
| 依赖注入 | `Depends(get_db)` 等 | 处理函数参数 `(request, env, ctx, args)` | 平台无容器，语义等价 |
| 请求/响应模型 | Pydantic `schemas.py` | `app/api/schemas.js` 的常量 + `intOf/str` 宽松转换 | 口径一致；无自动 422（旧站有，属差异） |
| 中间件 | `add_middleware` 栈 | 入口里按序调用的函数（`app/core/middleware.js`） | 等价；gzip 交边缘 |
| 启动钩子 | `lifespan`：建表自愈、种子、预热、模板预编译 | 无（一次性 SQL + 首次初始化页） | **替代**（Worker 无常驻进程） |
| 日志 | 文件/控制台 + JSON/text + 轮转 + 审计文件 | `app/core/logging.js`：结构化 + 脱敏 → Workers Logs | **替代**（无文件系统） |
| 缓存 | 进程内 `SharedCache`（可切 Redis） | 无 | **替代**（无进程内状态） |
| 限流 | 进程内计数（每 worker 一份） | D1 计数表（跨实例一致）+ Cron 清理 | **替代且更严** |
| 缩略图 | Pillow 在线生成 | 迁移期预生成，存在才下发（R2） | **替代**（无 Pillow） |
| 模板 | Jinja2（58 个） | 字符串拼 HTML + 原生 JS | **替代**（零构建） |
| 静态文件 | `StaticFiles` 挂载（支持 Range） | 同口径：`/images/*`、`/image/*`、`/video/*`、`/avatar/*`、`/news_uploads/*`、`/avatar_uploads/*` 都由 Worker 从 R2 直出（含 Range/206）；素材默认另走 R2 公开域 `storage.250036.xyz`，把 `MEDIA_BASE` 换成 Worker 域名即可单域名 | **一致**（底层换成 R2） |
| 口令哈希 | bcrypt（12 轮） | PBKDF2-SHA256（10000 轮） | **让步**：免费套餐 CPU 10ms/请求，bcrypt 跑不动 |
| 数据库 | SQLite/MySQL + 连接池 + 熔断 | D1（单写者） | **替代** |
| 表清单与逐表行数 | 读 `sqlite_master` + 一条 `UNION ALL` 拿回所有表行数 | 同样读 `sqlite_master`，但**必须排除 D1 内部表**（`sqlite_%`、`_cf_%`、`d1_migrations` —— `_cf_KV` 是 D1 自带的 KV 影子表，对它计数会让整条复合查询失败），行数改用 `batch()` 逐表 COUNT | **替代** |

## 3. 三档"一致性"的判定口径

| 档 | 含义 | 例子 |
| --- | --- | --- |
| **必须逐字一致** | 小程序或对拍脚本会判 | 响应形态（`code/msg/message/status` 组合）、错误文案、`api_status=online`、`/test` 的 301 目标、免登录名单、参数上下限 |
| **允许不同（有意）** | 平台事实或新站设计 | `/health` 的 `checks` 字段名、`uptime_s=0`、`version` 值、`/metrics` 指标集、图/视频绝对地址用 `storage.250036.xyz`、4 个新增静态页 |
| **必须替代** | 平台不提供 | 上表第 2 节带"替代/让步"的行 |

## 4. 改代码时的自查清单

1. 改对外口径 → 同步 `tests/api_*.test.mjs` 断言，并跑 `node tools/diff_api.mjs --old https://api0.250036.xyz --new https://lyjx.250036.xyz` 对拍。
2. 加/改对外路由 → `routeTable()` 的条数断言（33 条）会红，确认是有意改动后再更新。
3. 加/改后台写路由 → `app/admin/lib/entities.js` 的四份清单必须登记，`auditAdminWriteRoutes()` 的自检会点名未登记项。
4. 改后台页面/脚本/CSS → 重新生成 `app/admin/assets/static-*.js`，并升 `main.js` 的 `API_VERSION`（`?v=` 缓存键）。
5. 任何一边改了行为，回这份表确认对面是否需要跟进。
