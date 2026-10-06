# `admin/`：管理后台（同一个 Worker，`/admin` 前缀）

对外 API 的经营后台。与 `../api/`（33 条对外接口）**分开管理**：两者的鉴权方式、改动节奏、可访问范围完全不同，
放一起会让 `app/` 变成杂物间。来源是旧站 `fastapi/app/admin/`（79 条路由 + 58 个 Jinja2 模板）。
逐文件对应关系见 `../notes/structure-map.md`。

## 一、目录结构

```
app/admin/
├── index.js            # 入口: /admin 前缀分发 + 静态资源 + 写路径权限拦截
├── routes.js           # 控制面板(13 卡 + 趋势 + 最新列表)
├── pages/              # 19 个页面模块, 每模块导出 { methods, path, handler } 的 routes 数组
│   ├── index.js        # 汇总成 PAGE_ROUTES 交给入口分发
│   ├── banners.js notices.js categories.js appHome.js appFeatured.js
│   ├── appVersion.js appText.js appMenu.js topics.js
│   ├── users.js adminUsers.js userNews.js news.js comments.js
│   ├── settings.js systemInfo.js media.js(上传与素材库弹窗)
│   ├── dbTools.js      # 数据库工具 / 数据库管理(表浏览 + SQL 执行, ENABLE_SQL_TOOL 开关)
│   ├── mediaGovern.js  # 素材库治理(占用 / 引用 / 删除, 仅超管)
│   └── deleteConfirm.js(通用删除确认页)
├── routes/
│   └── auth.js         # 登录 / 登出 / 首次初始化
├── lib/
│   ├── entities.js     # 实体注册表 + 四份写权限清单 + classifyWritePath
│   ├── controlled.js   # 受控表 CRUD 工厂(字段声明 → 统一流程)
│   ├── status.js       # 状态切换注册表(12 个 kind) + applyStatus
│   ├── utils.js        # 分页/回跳/幂等/时间归一/localtime 等唯一实现
│   ├── catalog.js      # 文案分组/内置菜单/动作/可见性/页面前缀等常量
│   ├── categorySource.js # 分类真值来源(名称映射/启用集合/下拉选项)
│   ├── newsContent.js  # 正文视频 <wx-video> ↔ <video> 转换 + 摘要
│   ├── mediaUpload.js  # 上传校验(白名单+内容嗅探) + R2 写入 + 素材库列举
│   ├── dbTool.js       # 数据库工具安全内核(单语句/白名单表/脱敏) + D1 元信息与分页
│   ├── guard.js session.js password.js auth-store.js base64url.js
│   ├── layout.js       # 页面外壳(替代 base.html)
│   ├── partials.js     # 页面宏: 页头/统计条/列表骨架/表单字段/编辑外壳/删除确认卡
│   └── nav.js          # 侧栏菜单唯一来源(status: ready/todo)
├── assets/
│   └── static-assets.js # 生成物: static/** 全部资源(css/js/vendor/字体)的 JS 文本模块
└── static/             # 样式与脚本原件(生成来源与对照, Worker 不直接读它)
    ├── css/admin.css  js/{sidebar-groups,admin-shell,infinite_scroll,status-toggle,image_upload,media_library,live_time}.js
    └── vendor/{bootstrap.min.css,bootstrap-icons.min.css,bootstrap.bundle.min.js,fonts/*.woff*}
```

## 二、迁移状态

| 分类 | 页面 | 说明 |
|---|---|---|
| **已迁移（19）** | 控制面板、用户管理、用户笔记审核、管理员管理、笔记管理（含编辑/预览/回收站/批量）、留言管理、分类管理、轮播图、通知公告、首页板块、首页精选、专题精选（摩旅/户外）、版本配置、运营文案、我的页菜单、管理员设置、系统信息、**数据库工具 / 数据库管理**、**素材库管理** | 与旧站同路由、同文案、同口径（平台差异见第四节） |

两页"超管工具位"的实现口径：

| 项 | 做法 |
|---|---|
| 数据库工具 `/admin/db_tools`、`/admin/db_manage` | 表清单（含行数）+ 表结构/索引/数据分页（只读，敏感列自动脱敏）+ SQL 执行；**默认关闭**，需把 `ENABLE_SQL_TOOL` 设为 `1`；只允许 SELECT/INSERT/UPDATE/DELETE 的**单条**语句，且只能操作白名单业务表；写语句必须 `confirm=1`（前端二次确认 + 后端再验） |
| 素材库管理 `/admin/media_manage` | 素材来自 **R2 列举**（旧站是 `os.walk`）；类型/文件名/排序筛选 + 占用统计 + 引用情况；删除走服务端确认页，**有引用一律拒绝**（引用含回收站笔记，避免"删素材→恢复回收站→裂图"）；返回地址收敛，防开放重定向 |
| 引用判定 | `pages/mediaGovern.js` 的 `scanReferences()` 是**列表列 / 查看引用 / 删除前复查**三处唯一实现（旧站 v2.3.4 的 BUG 就是两处判定不一致） |
| 两页的闸 | 页面 GET 自己判超管（中间件只拦写方法）；写路径 `/admin/db_manage`、`/admin/media_manage_delete` 已在 `entities.SUPER_ONLY_WRITE_PATHS` 登记 |

## 三、鉴权（与旧站同一套做法，只有哈希算法换了）

| 环节 | 做法 | 说明 |
|---|---|---|
| 账号 | D1 表 `admin_users`（`app/sql/0004_admin.sql`，与旧库同构） | 字段含 `username`/`password`/`role`/`last_login_time` |
| 口令 | **PBKDF2-SHA256**（`crypto.subtle` 原生实现，零依赖），哈希串 `pbkdf2_sha256$<迭代数>$<salt>$<hash>` 自描述 | 迭代数 10000，将来要提高不用改代码（旧哈希照样能验） |
| 会话 | **HMAC-SHA256 签名 Cookie**，载荷含 `id/username/role/exp/口令指纹` | `HttpOnly; SameSite=Strict`；**`Secure` 只在 https 下发**（http 下浏览器会丢弃它，本地预览会"登录成功却回到登录页"）；改口令即踢下线 |
| 防跨站 | `SameSite=Strict` + 登录/登出/初始化的 `Origin` 校验 | 不再另发 CSRF token |
| 登录限速 | **复用 `app/core/ratelimit.js`**：IP 级 5 次/15 分钟锁定，外加"同一账号 10 次/15 分钟" | 计数落在 D1 的 `rate_limit_counters` |
| 页面权限 | `lib/entities.js` 四份写路径清单：`super`（分发前拦）/`route_super`（页面内自查）/`normal`/`exempt`；**未登记一律拒绝并记日志** | `node --test` 里有"写入口是否都登记了口径"的自检 |
| 会话密钥 | 密文 `ADMIN_SESSION_SECRET` | **没配时登录页直接提示"后台未就绪"**，不会用默认值放行 |

### 为什么不是 bcrypt（旧站用的那个）

Workers **免费套餐 CPU 只有 10ms/请求**（超了报 Error 1102）：纯 JS bcrypt 要 100~300ms、连 PBKDF2 十万轮也会超。
所以迭代数压在 10000，并用登录限速补偿。要让哈希强度回到 bcrypt 级别，只能开 Workers 付费（CPU 上限 30 秒）。

### 首次初始化与"旧库密码为什么不能用"

1. 建表（`app/sql/0004_admin.sql`）后表是空的 → 浏览器打开 `/admin/bootstrap`，填用户名/昵称/口令（**≥10 位**）→ 建出 `role=super` 的账号。
2. 旧库 `admin_users` 里的口令是 **bcrypt** 哈希，免费套餐下无法校验，因此**不能直接沿用**；要保留原来的用户名，
   在 bootstrap 时填同样的用户名即可。表非空后 `/admin/bootstrap` 自动失效。

### 忘记口令怎么办

没有"找回密码"通道（也不该有邮件/短信那条路）。D1 Console 里执行下面这句清空后，重新访问 `/admin/bootstrap` 重建：

```sql
DELETE FROM admin_users;   -- 清掉全部管理员(通常只有 1 个)
```

验收与排查（`/admin` 该回什么、登录页提示"后台未就绪"是什么意思）见 `../DEPLOY.md` 的 A8。

## 四、与旧站的差异（有意为之）

| 项 | 旧站 | 这里 |
|---|---|---|
| 模板 | Jinja2 58 个模板 + `base.html` | 手写 HTML 生成（`lib/layout.js` + `lib/partials.js`），零模板引擎 |
| 口令哈希 | bcrypt（轮数 10） | PBKDF2-SHA256 10000 轮（免费套餐 CPU 限制） |
| **口令长度下限** | 前端模板写 6、后端判 10（旧站已知缺陷 B9） | **前后端统一 10 位** |
| 管理员头像 | 无（设置页从未做过头像编辑） | **保持一致：也没有** |
| 会话 | Starlette 签名 Cookie（含会话复核 TTL） | 自己的 HMAC 签名 Cookie（含口令指纹，等价于"改口令即失效"） |
| 上传缩略图 | Pillow 上传时预生成 + CLI 补跑 | **不生成**：接口与列表按"有则用、无则回退原图"（`app/core/media_scheme.js` 同口径） |
| 进程内缓存 | `invalidate_entity_cache` 真清缓存 | 无进程内缓存，`invalidateEntityCache()` 是**有意空实现**（将来上 Cache API 只改这一处） |
| 表单一次性防重 | 进程内缓存 `add_if_absent` | 落 D1 `rate_limit_counters` 抢键（`INSERT OR IGNORE`） |
| 审计 | 写日志文件 | `app/core/logging.js` 的结构化 `admin.audit` 事件进 Workers Logs（**不建审计表**，需要可查询审计时再补） |
| 侧栏交互 | 折叠记忆 + 滚动位置恢复（~250 行 JS） | **原样复用**（`static/js/sidebar-groups.js` 从 base.html 提取） |
| 列表加载 | 触底加载行片段 | **原样复用** `infinite_scroll.js`（契约一致：`{success, rows}`） |
| 数据库工具 | 支持 SQLite/MySQL 双驱动、库文件备份、表结构自愈、VACUUM | 只有 D1：无备份/无自愈/无压缩；浏览范围是全部表，执行 SQL 仍限白名单业务表；**默认关闭**（`ENABLE_SQL_TOOL`） |
| 素材库治理 | `os.walk` 扫本地目录 + 15 秒进程内扫描缓存 | **R2 列举**（无进程内缓存，每次真扫元信息）；占用统计分"原文件"与"派生缩略图"两栏 |
| 素材删除 | `os.remove`（同样不可恢复） | R2 `delete`（无回收站）；同样"有引用一律拒绝 + 服务端确认页" |

## 四·五、四处实现约定（改这里之前先读）

| 约定 | 为什么 | 改哪里 |
|---|---|---|
| **版本号只有一个来源**：`main.js` 的 `API_VERSION`；入口用 `handleAdmin(request, env, { version })` 注入，侧栏 `.ver` 与静态资源 `?v=` 都读它 | 版本号若各页自己读 env/配置，就会出现"首页正常、后台侧栏只显示一个 v"这种不一致（2026-10-06 的线上故障就是入口漏传参） | `main.js`（注入）；`lib/layout.js`（版本为空时**不渲染** `.ver`，宁可没有也不留裸 `v`） |
| **表头要放真 HTML 必须显式声明**：`listShell` 的列支持 `{ label, html: true }`，其余一律转义 | 默认转义是安全底线；笔记列表的"全选"复选框曾因此被显示成 `&lt;input …&gt;` 源码文本 | `lib/partials.js` 的 `listShell`；调用方如 `pages/news.js` 的 `COLUMNS` |
| **动作字段一律用隐藏域**：`<input type="hidden" name="action" value="restore_user">` 或 `name="delete_admin" value="1"`，**不要**把动作挂在提交按钮的 `name/value` 上 | 表单数据是在 submit 事件**走完之后**才构造的，"提交时被禁用/被脚本锁定的按钮"不进表单数据 → 那个字段整条丢失 → 后端只回"未识别的操作"（2026-10-06 线上：用户管理两个按钮只发出 `user_id`/`page`，真实 Chromium 实测复现）。同理 `admin-shell.js` 锁按钮**只能**用 `aria-disabled` + `pointer-events`，绝不能设 `btn.disabled = true`（`tests/admin_submit_action.test.mjs` 会拦回退） | `lib/partials.js` 之外的各页表单；`static/js/admin-shell.js` 的 `lockButton` |
| **用户管理两个写操作的语义**（下表） | 它们直接对应小程序侧判定，改错会连带影响小程序 | `pages/users.js` 的 `writeSubmit` / `restoreUser` |

用户管理两个写操作（与旧站 `users_admin.py` 同口径）：

| 操作 | 落库 | 语义与判定依据 |
|---|---|---|
| **恢复账号** | `UPDATE users SET status=0, nickname='<原昵称>(已恢复)', raw_nickname='<原昵称>'`；**`deleted_at` 保留** | `status != 0` = 已注销（不能再登录）；恢复后该用户可用微信重新登录；`deleted_at` 留作"曾被注销过"的标记，列表据此显示"已恢复"。**与对外 `/user/deleted_account_action` 的 restore 不同**：那个给小程序用，会换 token 并清 `deleted_at` |
| **设为 / 取消内部测试** | `UPDATE users SET is_trusted = 1 / 0` | `users.is_trusted`（1=内部测试）就是判定依据，小程序侧四处生效：① 专题视频可见（`app/api/content.js` 仅 `is_trusted=1` 才下发 `video_url`）；② 留言免审（`app/api/news.js` 里 `is_trusted=1` 直接 `approved`，否则 `pending`）；③ 登录载荷带 `is_trusted`（`app/api/user.js`）供前端区分；④ 菜单 `app_menu_items.trusted_only`（`app/api/app_config.js`）的"仅内部测试可见" |

两个按钮都是：仅超管可见（`actionCell` 判 `isSuper`，另有 `entities.SUPER_ONLY_WRITE_PATHS` 的 `/admin/users` 拦一道）→ 点击先 `confirm()` → `POST /admin/users`（隐藏域 `action=set_trusted|remove_trusted|restore_user` + `user_id`）→ 成功 302 回列表并带 `message`（整页刷新即最新状态），失败带 `error` 显示在页面顶部。

## 五、样式与脚本怎么改

原件在 `app/admin/static/`，Worker 读的是 `app/admin/assets/static-assets.js`（生成物）。改了原件后重新生成：

```powershell
cd app\api-cf
# 遍历 app/admin/static/**: css/js 用 [IO.File]::ReadAllText + ConvertTo-Json -Compress;
# 字体(.woff/.woff2) 用 ToBase64String 包成 data: URL(serveStatic 会解码回二进制返回);
# 最后拼成 export default { ... } 写进 app/admin/assets/static-assets.js
```

> 别用 `Get-Content -Raw`：它会给字符串挂上 `PSPath`/`PSDrive` 等属性，`ConvertTo-Json` 会把整个对象序列化进去（踩过一次）。

改完记得改 `main.js` 的 `API_VERSION`（资源地址带 `?v=`，不升版本号浏览器会用旧缓存）。

## 六、本地怎么测

- `cd app/api-cf && node --test`：**156 条**用例，覆盖三件套(权限归类/工厂/工具)、外壳(守卫/状态切换/宏/版本号注入/动作字段防回退)、
  全部页面模块的端到端（列表/片段/编辑/删除/上传/预览）、数据库工具与素材治理两页的闸门与判定、对外接口的契约定档。
- `node tools/live_smoke.mjs`：真实库结构与数据下的对外接口端到端（后台改动不该影响它）。
- 浏览器实测：可以用内存桩起一个本地预览服务（把 `handleAdmin` 接到 `http.createServer`），
  用 playwright 逐页看渲染与响应式 —— 注意会话 Cookie 的 `Secure` 只在 https 下发，所以 http 预览也能正常登录。
