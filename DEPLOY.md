# 部署到 Cloudflare（照着做即可）

> 项目：`app/api-cf/`（Workers + D1 + R2，**只有对外 API，没有管理后台**）。
> 迁移设计见 `Plan.md`，接口台账见 `notes/api-inventory.md`，限流方案见 `notes/limits-design.md`，运营改数见 `notes/ops-sql.md`，本地跑法见 `README.md`。
> 代码与自测已完成（33 条接口、175 条用例全绿），本文件只讲"怎么推上云"。部署动作全部由你执行。

## 0. 命名约定（固定，不要改）

| 东西 | 名字 | 谁在用 |
|---|---|---|
| Worker / Pages | **`lyjxxapp-api`** | `wrangler.toml` 的 `name` |
| D1 数据库 | **`lyjxxapp-d1`** | `wrangler.toml` → `database_name`，绑定名 `DB` |
| R2 桶 | **`lyjxxapp-r2`** | `wrangler.toml` → `bucket_name`，绑定名 **`STORAGE`**（代码只从 `core/config.js` 的 `storage` 取，那里兼容早期的 `MEDIA`） |

**变量与密钥都已经在项目里预置好了 —— 你只需要改值或填密文，不用去控制台一个个新建**：

| 类型 | 在哪 | 内容 | 你要做什么 |
|---|---|---|---|
| 变量（明文） | `wrangler.toml` 的 `[vars]` | `MEDIA_BASE`、`DEV_WECHAT_MOCK`、`UPLOAD_MAX_BYTES`、`ENABLE_PUBLIC_PROBE`、`OBSERVABILITY_ENABLED`、`ALLOWED_ORIGINS`（CORS 白名单，`*`=放开）、`ENABLE_SQL_TOOL`（数据库工具开关，默认 `0` 关） | 改值 → 部署时自动写进 Cloudflare（Git 连接部署也会自动带上） |
| 密钥（密文，推给生产） | `.secrets.json`（模板 `.secrets.json.example`） | `WECHAT_APPID`、`WECHAT_SECRET`、`ADMIN_SESSION_SECRET` | 填值 → `npm run secrets:put`（等价 `wrangler secret bulk .secrets.json`，一次推三个） |
| 密钥（密文，本地开发） | `.dev.vars`（模板 `.dev.vars.example`） | 同上三个 | 只给 `npm run dev`（本地 `wrangler dev`）用；不填则本地登录页会写"后台未就绪" |
| 绑定 | `wrangler.toml` | D1 `DB`→`lyjxxapp-d1`、R2 `STORAGE`→`lyjxxapp-r2`、Cron `17 3 * * *` | 只需先把库与桶建出来（下面第 2、3 步） |

> 版本号 `API_VERSION` **不是变量**：唯一来源是 `main.js` 顶部的 `API_VERSION`（与旧站 `fastapi/main.py` 的 `APP_VERSION` 同位置），
> 状态页 / `/health/ready` / `/apitest` 展示它，也是后台静态资源的 `?v=` 缓存键；**改了样式或脚本要顺手升它再部署**。

> ⚠️ **库名额**：账号内 D1 已用 **9 / 10**，新建 `lyjxxapp-d1` 会占掉最后一个名额。
> ⚠️ **R2 桶名与 backend-cf 不同**：backend-cf 用的是 `lyjxxapp-media`，本项目要 **`lyjxxapp-r2`**，需要新建（不是同一个桶）。
> ⚠️ 密钥不能进仓库：真值文件 `.secrets.json`、`.dev.vars` 已在 `.gitignore` 里，只提交 `.example` 模板。
> ⚠️ **区域都选亚太**：D1 建库时的 **Location**、R2 建桶时的 **Location** 都选 **Asia Pacific**（就近中国大陆，延迟最低）。
> D1 的 Location **建库后不能改**（要换只能新建库再导一遍数据），所以第一次建库就选对；R2 桶同理。
> ⚠️ **`.secrets.json` 与 `.dev.vars` 都要填，但用途不同**：前者推给 Cloudflare（生产），后者只作用于本机 `npm run dev`。

---

## 路线 A：只用网页端（GitHub 连接部署，不敲 wrangler）

### A1. 把代码放进 GitHub
1. GitHub → `+` → **New repository** → 名字填 **`lyjxxapp-api`** → **Private** → Create。
2. 把 `app/api-cf/` 里的这些传上去：`app/`、`app/sql/`、`tools/`、`tests/`、`wrangler.toml`、`package.json`、`README.md`、`DEPLOY.md`。
   > 网页版最省事：仓库页 **Add file → Upload files**，把目录整体拖进去 → Commit。
   > **不要**传 `node_modules/`、`.wrangler/`、`out/`、`.secrets.json`、`.dev.vars`（`.gitignore` 已忽略，手动上传时留意别勾）。

### A2. 建 D1 数据库
1. 控制台 → **Workers & Pages → D1**（有的界面叫 **Storage & Databases → D1**）→ **Create database**。
2. 名字填 **`lyjxxapp-d1`**，**Location 选 `Asia Pacific`（亚太）** → 创建。
   > 这个 Location 是**建库时定死的**：选错只能新建库 + 重新导数据（见 A4），别等导完才发现。
3. 复制那串 **Database ID**（UUID），回 GitHub 编辑 `wrangler.toml`：把 `database_id` 那行注释取消并填上真值 → Commit。
   > 也可以跳过本步：`wrangler.toml` 里 `database_id` **留空**时，首次部署会让 wrangler 按 `database_name` 自动把库建出来（只在控制台可见）。建完仍建议回填，否则本地 `wrangler d1 execute` 定位不到这个库。

### A3. 建 R2 bucket 并开公开域
1. **Storage & Databases → R2 → Create bucket**，名字填 **`lyjxxapp-r2`**，**Location 选 `Asia Pacific`（亚太）**（桶保持**私有**，公开读用自定义域单独开）。
2. 进 bucket → **Settings → Public access → Custom Domain** → 填 **`storage.250036.xyz`** → 按提示加 DNS 记录。
3. 完成后 `https://storage.250036.xyz/<key>` 能直接打开对象（先把素材传上去才验证得了，见"素材上传"）。
4. 绑定名固定是 **`STORAGE`**（`wrangler.toml` 的 `[[r2_buckets]].binding`）：代码侧统一读 `core/config.js` 的 `storage`，改绑定时只改这一个字段即可（`MEDIA` 是早期名字，代码仍兼容，避免改绑定期出现空窗）。

### A4. 建表 + 导数据（都在 D1 控制台逐块粘贴）

D1 的导入只有 **wrangler 命令**与**控制台 Console** 两条路（官方**没有**"上传 SQL 文件"入口），而
`0001` 约 11 KB、整份数据 84 KB，一次性粘会被截断。所以先用 `split_sql.py` 把两者都拆成"每块 ≤ 6 KB"，再按序号逐块粘：

```powershell
cd app\api-cf
# 1) 拆建表 → out\schema（5 块，含后台用的 admin_users）
python scripts\split_sql.py out\schema app\sql\0001_schema.sql app\sql\0002_rate_limit.sql app\sql\0003_wechat_token.sql app\sql\0004_admin.sql
# 2) 导出数据并拆块 → out\seed（14 块）
python scripts\export_sqlite.py ..\..\fastapi\data\lyjx.db out\seed.sql
python scripts\split_sql.py out\seed out\seed.sql
```

进 `lyjxxapp-d1` 库 → **Console / Query**，按文件名的两位序号从小到大逐块粘贴 → Run：

| 阶段 | 文件 | 内容 | 预期 |
|---|---|---|---|
| 建表 | `out/schema/01_0001_schema.sql` | `0001` 的前 12 条语句 | 无报错 |
| 建表 | `out/schema/02_0001_schema.sql` | 余下 51 条（索引为主） | 无报错 |
| 建表 | `out/schema/03_0002_rate_limit.sql` | `rate_limit_counters` 限流计数表 | 无报错 |
| 建表 | `out/schema/04_0003_wechat_token.sql` | `wechat_tokens` 微信 token 缓存表 | 无报错 |
| 建表 | `out/schema/05_0004_admin.sql` | `admin_users` 管理员账号表（后台登录用） | 无报错 |
| 导数据 | `out/seed/01_seed.sql` … `14_seed.sql` | 196 行数据 | 逐块 Run 无报错 |

要点：

- **先建表再导数据**，否则数据块全部报 `no such table`。
- 每块**块头注释**写了"本块涉及哪些表"，出错时按它定位。
- 数据块是 `INSERT OR REPLACE`，**可以反复粘贴**（切换前重跑导出补新数据也安全）；建表块只在第一次成功，重跑会报 `table ... already exists`，属正常。
- 正文里的换行是**真实换行**（一条 INSERT 可能占多行），复制时整块全选，别只框一行。
- 校验：表共 **21** 张（18 业务 + 限流 + token + `admin_users`）；`SELECT COUNT(*) FROM news` = **69**、`users` = **4**、`banner_images` = **18**。
- 想少粘几次：加 `--max-bytes 30000` 拆成 3 块（约 33/32/21 KB，实测可执行）；粘不动或报错再回到默认的 14 块。
- 试错没有代价：数据块是 `INSERT OR REPLACE`，粘重复了也只是覆盖同一行；建表块重跑才会报 `already exists`。

> 不想手工粘：把 Database ID 回填 `wrangler.toml` 后，一条命令即可 ——
> `wrangler d1 execute lyjxxapp-d1 --remote --file=out/seed.sql`（建表同理，换成 `app/sql/0001~0003`）。

> `0001` 是**从旧库真实 DDL 导出**的：旧后端启动会补列补索引，静态 sql 文件比线上库少 1 列与 7 条索引，别用 `fastapi/app/sql/schema_sqlite.sql` 代替。

### A5. 建 Worker 并连 Git
1. **Workers & Pages → Create → Workers → Connect to Git**。
2. 选仓库 → 分支 `main`。
3. 构建设置（照填）：
   - **Build command**：留空（零依赖、零构建）
   - **Deploy command**：`npx wrangler deploy`
   - **Root directory**：把 `app/api-cf` 内容当仓库根传的 → 留空；整仓库传的 → 填 `app/api-cf`
4. **Deploy**。构建日志若报 *binding DB … database_id* 相关错误 → 回 A2：要么把真值填对，要么把那行**整行注释掉**让 wrangler 自动预置，再 push。
   > Git 连接部署时，`[vars]` 与绑定会**自动生效**（不用去控制台手点）；**Cron 也会跟着部署**。

### A6. 只需配三个密钥
Worker → **Settings → Variables and Secrets** → 加三个**加密**类型：`WECHAT_APPID`、`WECHAT_SECRET`、`ADMIN_SESSION_SECRET`（后台会话密钥，32+ 位随机字符）→ 配完 **Deployments → 最新一条 → Retry deployment**。

| 文件 | 作用范围 | 怎么生效 |
|---|---|---|
| `.dev.vars`（模板 `.dev.vars.example`） | **只作用于本机** | `npm run dev`（`wrangler dev`）启动时读取；不填则本地后台登录页写"后台未就绪" |
| `.secrets.json`（模板 `.secrets.json.example`） | **推给 Cloudflare（生产）** | `npm run secrets:put`（= `wrangler secret bulk .secrets.json`）；本地跑 `dev` 时它**不生效** |

> 两个文件都要填（同一个 3 项），但它们互不替代：一个管本机，一个管线上。Git 连接部署时，生产密钥仍要在控制台配一次（或用 B6 的命令推）。

#### 怎么生成 `ADMIN_SESSION_SECRET`

它是后台会话 Cookie 的 **HMAC 签名密钥**：只要一串**随机**字符（32 位以上），**不要**用有意义的口令。任选一种生成方式：

```powershell
# 方式一（推荐，项目本来就要求 Node 22+）：生成 64 位十六进制
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 方式二（Windows 自带 PowerShell / .NET，无需额外安装）
$b = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
-join ($b | ForEach-Object { $_.ToString('x2') })

# 方式三（装了 git 就有 openssl）
openssl rand -hex 32
```

拿到那串字符后三处任一（推荐前两处都填）：

| 放到哪 | 怎么做 |
|---|---|
| `.secrets.json`（生产） | 填 `"ADMIN_SESSION_SECRET": "<那串字符>"` → `npm run secrets:put` |
| `.dev.vars`（本机） | 填 `ADMIN_SESSION_SECRET="<那串字符>"` → 重启 `npm run dev` |
| 控制台（不想用命令行时） | Worker → **Settings → Variables and Secrets** → 加**加密**类型 `ADMIN_SESSION_SECRET` → Retry deployment |

注意：① 它是**密文**，别提交进仓库（`.secrets.json` / `.dev.vars` 已在 `.gitignore`）；② **换了它，所有已登录的后台会话立刻失效**（管理员要重新登录，小程序不受影响）；③ 不配它时后台登录页会写"后台未就绪"（不会用默认值放行）。

**想先用假微信走通全流程**：把 `wrangler.toml` 的 `DEV_WECHAT_MOCK` 改成 `"1"` 再部署（不调微信、不做昵称送审，任意 `code` 都能登录，便于验收）；正式上线改回 `"0"` 并配真密钥。

### A7. 自定义域

Worker → **Settings → Domains & Routes → Add → Custom domain**。本项目实际只用两个域名：

| 域名 | 指向 | 用途 |
|---|---|---|
| **`lyjx.250036.xyz`** | 这个 Worker（`lyjxxapp-api`） | 小程序接口 **+** 管理后台 `/admin`，同一域名 |
| `storage.250036.xyz` | R2 桶 `lyjxxapp-r2` 的公开域（见 A3） | 素材直读 |

> 早期规划中的 `api.250036.xyz` / `pages.250036.xyz` **没有采用**：`api.250036.xyz` 至今指向旧站 FastAPI（也是回滚线路），
> 而协议 / 隐私 / 下载等静态页由同一个 Worker 的 `/pages/*` 提供，不需要单独的 Pages 项目。

**顺手加白名单**：微信公众平台 → 开发管理 → 服务器域名 → **request 合法域名**：
`https://lyjx.250036.xyz`、`https://storage.250036.xyz`（旧线路 `https://api0.250036.xyz` 一起留着，回滚要用）。

### A8. 进管理后台（`/admin`）

后台与对外 API 在**同一个 Worker** 里，路径前缀 `/admin`（本项目实际域名：`https://lyjx.250036.xyz/admin`）。
**没有初始用户名/口令** —— 第一个管理员由你在下面第 3 步自己设定（默认口令是后台被扫号的头号入口，刻意不预置）。

| # | 做什么 | 说明 |
|---|---|---|
| 1 | 建 `admin_users` 表 | 见 A4 的第 5 块：`app/sql/0004_admin.sql` |
| 2 | 配会话密钥 | 控制台 **Settings → Variables and Secrets** 加一个**加密**变量 `ADMIN_SESSION_SECRET`（一串 32+ 位随机字符），或 `wrangler secret put ADMIN_SESSION_SECRET`；不配时登录页会写"后台未就绪"（不会用默认值放行） |
| 3 | 首次初始化 | 浏览器打开 `https://lyjx.250036.xyz/admin/bootstrap`，填用户名 / 昵称 / 口令 → 提交后回到登录页，用这套账号登录 |

第 3 步的字段规则：

| 字段 | 规则 |
|---|---|
| 用户名 | 表单预填 `admin`；只能用 `字母 数字 _ . -`，3~32 位 |
| 昵称 | 可留空（留空取用户名） |
| 口令 | **至少 10 位**（与旧站一致） |

**`/admin/bootstrap` 只在 `admin_users` 为空时可用**，建完自动失效（再访问会提示"已经初始化过"），不必担心被别人抢先建号。

### A8.5 两个"超管工具位"（数据库工具 / 素材库治理）

| 页面 | 地址 | 开关与闸门 | 能做什么 |
|---|---|---|---|
| 数据库工具 / 数据库管理 | `/admin/db_tools`、`/admin/db_manage` | **默认关闭**：先把 `ENABLE_SQL_TOOL` 设为 `"1"` 再部署；另外仅超管可见（页面 GET 自查 + 写路径由 `entities` 拦） | 表清单（含行数）、每表的结构/索引/数据分页（敏感列自动打码）、SQL 执行（只允许 SELECT/INSERT/UPDATE/DELETE 的**单条**语句，且只能操作白名单业务表；写语句要二次确认） |
| 素材库管理（治理） | `/admin/media_manage` | 仅超管（菜单与页面都对普通管理员隐藏） | 按类型/文件名/排序筛选素材（来自 **R2 列举**）、看占用与被引用情况、删除无用素材；**有引用一律拒绝删除**（引用含回收站笔记），删除走服务端确认页且提交前会再复查一次 |

> 为什么数据库工具默认关：这一页能浏览全表数据、也能执行 SQL —— 与旧站同一个口径（`ENABLE_SQL_TOOL` 生产默认关）。
> 用完建议改回 `"0"` 再部署一次。

#### 验收（照着打一遍）

| 请求 | 期望 |
|---|---|
| `GET https://lyjx.250036.xyz/admin` | **302** → `/admin/login?next=/admin/dashboard` |
| `GET /admin/login` | **200** 出登录表单（若写"后台未就绪"，说明第 2 步没配好） |
| `GET /admin/bootstrap` | 表空时 **200** 出表单；已初始化则提示"已经初始化过" |
| `GET /admin/dashboard`（不带 Cookie） | **302** 回登录页 |
| 登录后再访问 `/admin/dashboard` | **200**，右上角显示登录用户名，四个统计与 D1 行数一致 |

#### 忘记口令怎么办

后台没有"找回密码"通道（也不该有邮件/短信那条路）。最省的重置方式是在 D1 Console 执行：

```sql
DELETE FROM admin_users;   -- 清掉全部管理员(通常只有 1 个)
```

然后重新打开 `/admin/bootstrap` 建一次（用户名沿用 `admin` 即可与旧站一致）。

#### 口令与会话是怎么存的

| 项 | 做法 |
|---|---|
| 口令存储 | 只存 **PBKDF2-SHA256** 哈希（`pbkdf2_sha256$迭代数$salt$hash`），明文不落库，代码与文档里也没有 |
| 为什么不是 bcrypt | Workers 免费套餐 CPU 只有 **10ms/请求**，bcrypt 要 100~300ms（直接报 Error 1102），连 PBKDF2 十万轮也会超；当前用 10000 轮 + 登录限速补偿。旧库 `admin_users` 的 bcrypt 口令**不能沿用**，bootstrap 时用同样用户名重建一次即可 |
| 会话 | `HttpOnly; SameSite=Strict` 的 HMAC 签名 Cookie（`Secure` **只在 https 下发** —— http 页面下浏览器会直接丢弃带 Secure 的 Cookie，本地预览会表现为"登录成功却立刻回到登录页"），载荷含 `id / 用户名 / 角色 / 过期时间 / 口令指纹`（改了口令即踢下线） |
| 登录限速 | IP 级 5 次 / 15 分钟锁定，外加同一账号 10 次 / 15 分钟；失败提示统一"用户名或密码错误"（与旧站 `admin/auth.py` 逐字一致，不暴露账号是否存在） |
| 登出 | `POST /admin/logout`（只收 POST，避免第三方用 `<img src="/admin/logout">` 把人踢下线） |

> 目录结构、迁移进度、与旧站的逐项差异见 `admin/README.md`。

### A9. 后台能做什么（迁移后的功能清单）

| 分组 | 页面 | 备注 |
|---|---|---|
| 概览 | 控制面板 | 13 张统计卡 + 近 7 日用户/笔记趋势（纯 SVG，不引图表库）+ 最新用户/笔记/留言 |
| 用户与审核 | 用户管理（详情、设为/取消内部测试、恢复注销账号、删除）、管理员管理 | 敏感操作仅超管可见，服务端也拦 |
| 内容管理 | 笔记管理（发布/编辑/预览/回收站/批量）、分类、通知公告、留言 | 删除走服务端确认页，先摊开影响面 |
| 小程序配置 | 首页板块、首页精选、专题精选（摩旅/户外）、轮播图、版本更新、运营文案、我的页菜单 | 改完按端上缓存策略刷新 |
| 系统 | 管理员设置（改昵称/邮箱/口令）、系统信息 | 改口令后强制重新登录 |
| **不迁移** | 数据库工具、素材库治理页（查占用/查引用/删素材） | 菜单里标「未迁移」并说明原因，用 D1 控制台代替 |

上传说明：笔记封面/正文插图/轮播图/专题封面走 `POST /admin/image_upload` 写入 **R2**（图片 `image/`、视频 `video/`；历史素材仍在 `news_uploads/`，两边都能读），
视频走同一入口的 `purpose=video` 分支（按文件头嗅探类型，不只看扩展名）。
**Worker 不生成缩略图**（没有 Pillow），列表按"有则用、无则回退原图"。

> ⚠️ **改了 `admin/static/**`（样式/脚本）或后台页面模板 → 必须升 `main.js` 的 `API_VERSION` 再部署**：
> 资源地址带 `?v=<main.js 的 API_VERSION>` 且缓存一天，图标字体缓存一年；不升版本号浏览器会继续用旧文件。

---

## 路线 B：wrangler 命令行

```powershell
cd D:\Users\Administrator\Desktop\开发者\xapp\iitbt\app\api-cf
```

### B1. 登录
```powershell
wrangler login                      # 方式一: 浏览器授权

# 方式二: API Token(无浏览器/CI)
# 控制台 → My Profile → API Tokens → Create Token, 权限: Workers Scripts:Edit、D1:Edit、R2:Edit、Account Settings:Read
$env:CLOUDFLARE_API_TOKEN = '<token>'
$env:CLOUDFLARE_ACCOUNT_ID = '<Account ID>'
wrangler whoami
```

### B2. 建 D1 并回填 id
```powershell
wrangler d1 create lyjxxapp-d1 --location apac
# --location apac = 亚太(就近中国大陆); 控制台建库就是 Location 选 Asia Pacific
# 这个位置建库后不可改, 选错只能新建库再导一遍数据
# 把输出的 database_id 填回 wrangler.toml 的 [[d1_databases]].database_id
```

### B3. 建 R2 bucket
```powershell
wrangler r2 bucket create lyjxxapp-r2 --location apac
# 同样选亚太; 绑定名固定 STORAGE(见 wrangler.toml 的 [[r2_buckets]] 与 A3 第 4 步)
wrangler r2 bucket list
```

### B4. 建表（远端，一条命令）
```powershell
npm run schema:remote
# 等价于:
#   wrangler d1 execute lyjxxapp-d1 --remote --file=app/sql/0001_schema.sql
#   wrangler d1 execute lyjxxapp-d1 --remote --file=app/sql/0002_rate_limit.sql
#   wrangler d1 execute lyjxxapp-d1 --remote --file=app/sql/0003_wechat_token.sql

# 核对: 应为 20 张表(18 业务 + 限流表 + token 表)
wrangler d1 execute lyjxxapp-d1 --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```
> 想先本地演练：`npm run schema:local`（本地文件在 `.wrangler/` 下，不动线上）。

### B5. 搬迁数据（旧库只读，旧后端不受影响）
```powershell
python scripts\export_sqlite.py ..\..\fastapi\data\lyjx.db out\seed.sql
wrangler d1 execute lyjxxapp-d1 --remote --file=out\seed.sql
python scripts\verify_counts.py ..\..\fastapi\data\lyjx.db      # 必须 0 差异
```
> 预期总量：18 张表 196 行（`users` 4、`news` 69、`banner_images` 18 …）。
> **切换前再跑一次前两步**，把旧库这段时间的新数据补上（按主键覆盖，重复执行安全）。

### B6. 密钥（改值就行，不用去控制台）
```powershell
# 1) 复制模板并填真值
copy .secrets.json.example .secrets.json
#    编辑 .secrets.json: {"WECHAT_APPID":"...","WECHAT_SECRET":"...","ADMIN_SESSION_SECRET":"..."}
# 2) 一条命令推上 Cloudflare
npm run secrets:put
#    等价: wrangler secret bulk .secrets.json
```
> 若你的 wrangler 版本不支持 `secret bulk`（以官方文档为准），退回逐条：`wrangler secret put WECHAT_APPID`、`wrangler secret put WECHAT_SECRET`、`wrangler secret put ADMIN_SESSION_SECRET`。
> 本地开发用 `.dev.vars`（`copy .dev.vars.example .dev.vars` 后填同一个三项），变量仍来自 `wrangler.toml` 的 `[vars]`。
> 一句话记：**`.dev.vars` 管本机 `npm run dev`，`.secrets.json` 管生产 `npm run secrets:put`** —— 两个都填。

### B7. 本地自检（部署前）
```powershell
npm test          # 175 条用例, 应全绿(不需要账号与网络)
npm run dev       # 本地起服务 http://127.0.0.1:8787, 先看 / 与 /health/ready
```

### B8. 部署
```powershell
npm run deploy    # 等价 wrangler deploy; 成功会给出 https://lyjxxapp-api.<子域>.workers.dev
```

### B9. 自定义域
```toml
# wrangler.toml 里加, 然后重新部署(媒体域 storage.250036.xyz 不在这里 —— 它绑的是 R2 桶, 见 A3)
routes = [
  { pattern = "lyjx.250036.xyz", custom_domain = true }
]
```

### B10. 日志与回滚
```powershell
wrangler tail                        # 实时日志(带 request-id), 免费额度内可用
wrangler deployments list
wrangler rollback                    # 回退到上一个版本
wrangler d1 execute lyjxxapp-d1 --remote --command "SELECT scope,bucket_key,count FROM rate_limit_counters ORDER BY window_start DESC LIMIT 10"
```

### B11. 定时清理（已配好，确认一下）
`wrangler.toml` 已声明 `[triggers] crons = ["17 3 * * *"]`，`main.js` 的 `scheduled` 每天清一次过期计数行。部署后在 Worker → **Settings → Triggers** 应能看到这条 Cron。

### B12.（可选）GitHub Actions 自动部署
```yaml
name: deploy-api
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          workingDirectory: app/api-cf
          command: deploy
```

---

## 素材上传（含缩略图，别漏 `images/`）

实测体量：`news_uploads/` 23 个文件 0.57 MB（全在 `home/`），`avatar_uploads/` 空，`app/images/` 4 个文件。详见 `tools/media_to_r2.md`：

1. **先预生成缩略图**（Workers 没有 Pillow，不能在线生成）：在旧后端环境跑现成工具
   ```powershell
   cd ..\..\fastapi
   python tools\make_cover_thumbs.py     # 产出 <素材目录>/_thumb/480|800/<名>.webp(目录随原图走, 见下)
   ```
2. **上传时保持 key = 库内相对路径**：历史素材仍是 `news_uploads/...`、`avatar_uploads/...`，新上传的走 `image/`、`video/`、`avatar/`（数据库字段一个字都不用改，见下节「素材目录」）。
3. **`app/images` 必须传到 `images/` 前缀**（Worker 的 `/images/*` 从这里读，不传则「我的」页菜单图标 404；**站点图标 `/favicon.ico` 不在这里** —— 它已内联进 Worker，见下节）：
   ```powershell
   wrangler r2 object put lyjxxapp-r2/images/user.jpg --file=..\..\fastapi\app\images\user.jpg
   # 文件多时用 rclone(需 R2 的 S3 凭据): rclone copy ..\..\fastapi\app\images r2:lyjxxapp-r2/images
   ```
4. 抽查：`https://storage.250036.xyz/news_uploads/home/<某个图>` 能打开；缩略图缺失时列表自动回退原图（不会白图）。

---

## 素材目录（新目录 + 历史目录共存）

| 类型 | 新上传落哪 | 历史素材还在哪 | 谁在写 |
|---|---|---|---|
| 笔记封面/正文插图/轮播图/精选图标 | `image/` | `news_uploads/` | 后台「本地上传」→ `POST /admin/image_upload`（purpose=cover/content） |
| 视频（笔记视频、专题视频） | `video/` | `news_uploads/` | 同上（purpose=video） |
| 小程序头像 | `avatar/` | `avatar_uploads/` | `POST /user/upload_avatar` |

口径（真值在 `app/core/storage.js`，只有这一处定义）：

- **列举/引用判定同时覆盖新目录与历史目录**（`MEDIA_PREFIXES`）：素材库弹窗、素材占用统计、素材治理页的"是否被引用"都把两个目录算进来，所以老素材不会"消失"，新素材也不会被误判成未引用。
- **Worker 直出同时覆盖新旧路径**（`SERVED_PREFIXES`）：`/image/*`、`/video/*`、`/avatar/*`、`/news_uploads/*`、`/avatar_uploads/*`、`/images/*`，都带 `etag` + `cache-control` + `accept-ranges`（Range 回 206）。
- **数据库里存的是相对路径，一个字段都不用改**：历史值（`news_uploads/…`）继续有效，新值（`image/…`）由 `MEDIA_BASE` 拼绝对地址下发。**不需要迁移数据、也不需要搬动 R2 对象**。

### 缩略图（规则：目录随原图走）

一条规则、一处真值：`app/core/storage.js::thumbKeyOf`（后台弹窗与对外接口都复用它）。

| 原图 | 缩略图（480 / 800 两个宽度） |
|---|---|
| `image/a.png` | `image/_thumb/480/a.webp`、`image/_thumb/800/a.webp` |
| `image/home/deep.png`（有子目录） | `image/_thumb/480/deep.webp` —— 子目录**扁平**到素材目录下的 `_thumb/<宽>/`，与历史 `news_uploads/home/*` 的排布一致 |
| `news_uploads/home/a.jpg`（历史素材） | `news_uploads/_thumb/480/a.webp` —— **历史缩略图继续命中**：老对象一个都不用重生成、不用搬 |
| `video/x.mp4` | `video/_thumb/480/x.webp`（不会有人生成；探不到就回退原图） |
| `avatar/…`、`avatar_uploads/…`、外链 `https://…` | 不派生（`thumbKeyOf` 返回空 → 不下发 `image_thumb`） |

影响与结论（本次**未搬运/未批量处理**任何对象，只改了规则与说明）：

- **历史缩略图仍可访问、不需要重生成**：规则对 `news_uploads/…` 同样成立，历史对象 key 没变、页面照旧引用。
- **新目录的缩略图要补（可选，不补不影响功能）**：Cloudflare 侧只读不生成（无 Pillow），要离线产出后按 key 上传。先算清缺哪些：

  ```powershell
  wrangler r2 object list lyjxxapp-r2 --prefix=image > $env:TEMP\orig.txt
  wrangler r2 object list lyjxxapp-r2 --prefix=image/_thumb > $env:TEMP\have.txt
  node tools/thumb_plan.mjs --check $env:TEMP\have.txt $env:TEMP\orig.txt   # 逐条标"有/缺", 有缺时退出码 1
  ```

  `tools/thumb_plan.mjs` 就是按上表规则算出 `原图 → 缩略图 key`（`--widths 480` 可只算一个宽度）。生成出 webp 后按列出的 key 上传，例如
  `wrangler r2 object put lyjxxapp-r2/image/_thumb/480/<名>.webp --file=<本地 webp>`。
- **缺失时的回退**：探不到缩略图就**不下发** `image_thumb` 键（`app/core/media_scheme.js::existingThumbs`）→ 小程序与后台列表回退原图，只是流量大一些，不白图、不报错。
- **宽度**：Cloudflare 侧只读 `480`（`NEWS_COVER_THUMB_WIDTH`，封面/列表用）；`800` 只有旧站预览页用（`fastapi/app/admin/render.py`），`thumb_plan.mjs` 默认把两个都列出来。
- ⚠️ **与旧站的差异（本次不改 `fastapi/` 任何代码）**：旧站 `app/core/storage.py::ensure_news_cover_thumb` 与 `tools/make_cover_thumbs.py` 仍把缩略图写死到 `news_uploads/_thumb/<宽>/`。所以**用旧站工具跑新目录（`image/`）的素材，产出会落到 `news_uploads/_thumb/` 下、与新规则不匹配**（表现是"依旧回退原图"，不影响功能）。要让旧站工具也按"目录随原图走"产出，需改旧站那份规则并重跑 —— **待确认**（改不改、何时改；本次范围内不动它）。
- **上传接口的字段与口径**：`file`（或历史名 `image`）+ `purpose`（`cover` / `content` / `video`），图片 8MB、视频 64MB，并按**文件头**判类型（改扩展名蒙不过去）。

---

## 素材对外域名（`MEDIA_BASE`）怎么选

库里只存**相对路径**（历史是 `news_uploads/home/a.jpg`，新上传是 `image/a.png`），下发时由 Worker 拼上 `MEDIA_BASE`。两种填法都能用：

| 填法 | 值 | 谁在服务素材 | 什么时候选它 |
|---|---|---|---|
| **A. R2 公开域（推荐）** | `https://storage.250036.xyz`（A3 建的自定义域） | 直接由 R2 边缘返回 | 默认。**不吃 Worker 请求额度、不经 Worker CPU**；视频 Range/拖动由 R2 原生支持；缓存命中率最高 |
| B. Worker 域名 | `https://lyjx.250036.xyz` | Worker 从 R2 读出来再返回 | 想少维护一个域名时用。`/image/*`、`/video/*`、`/avatar/*`、`/news_uploads/*`、`/avatar_uploads/*`、`/images/*` 都已由 Worker 直出（带 `etag`、`cache-control: max-age=604800`、`accept-ranges`，Range 回 **206**），与旧站 `StaticFiles` 挂载同口径 |

要点：

- 换成 B 只需改 `[vars]` 的 `MEDIA_BASE` 后重新部署，**代码不用动**（旧库里存的是相对路径，不涉及数据迁移）。
- 选 B 的代价：每条图片/视频请求都算一次 Worker 请求（免费套餐 100,000 次/日）并占用 CPU 时间；列表页一屏十几张图就十几个请求。素材量大时优先 A。
- 选 B 时**微信公众平台的 request 合法域名**只需保留 `https://lyjx.250036.xyz`（`storage.250036.xyz` 可留可不留，回滚要用就留着）。
- 不管选哪个，`/images/*`（包内图标）始终由 Worker 直出（旧站也是 StaticFiles，与素材域无关）。

---

## 站点图标（favicon，所有页面共用）

图标只有一个来源：`app/favicon.ico`（与旧站 `fastapi/app/favicon.ico` 是同一个文件，48725 字节）。
它被**内联进 Worker**（生成物 `app/core/favicon.js`），由 `main.js` 在 `/favicon.ico` 直出：

| 项 | 做法 | 为什么 |
|---|---|---|
| 页面引用 | `<link rel="icon" href="/favicon.ico?v=<内容指纹>" type="image/png">`，由 `core/html.js` 的 `FAVICON_LINK` 统一注入（状态页 / 协议·隐私·下载页 / 后台所有页 / 登录页 / 初始化页） | **根绝对路径、不带域名**：自定义域 `lyjx.250036.xyz`、`*.workers.dev` 预览域、本地 `wrangler dev` 都成立；写死域名会在预览域失效 |
| 服务侧 | Worker 路由 `GET /favicon.ico`，返回内联字节（在 `/images/*` 判定之后、路由表之前） | Workers/Pages 上 `/favicon.ico` 只是一次普通请求，**不会自动命中静态托管**；图标必须由 Worker 自己响应 |
| 响应头 | `content-type: image/png`、`cache-control: public, max-age=604800`、`etag`（内容指纹） | 浏览器对图标是**按地址缓存**的：没有长缓存 + 稳定 ETag，每个页面都会再拉一次（旧站 StaticFiles 给的也是 `max-age=604800`） |
| 类型要与字节一致 | 这个 `favicon.ico` **其实是 800×800 的 PNG**（前 8 字节是 PNG 魔数），所以声明 `image/png`；页面 `type=` 与响应 `Content-Type` 同源取自 `core/favicon.js` | 类型与真实字节不符、又带 `x-content-type-options: nosniff` 时，挑剔的客户端（非 Chromium 内核的 WebView 等）会直接丢掉图标 |
| 带 `?v=<指纹>` | 指纹 = 图标内容 hash（`FAVICON_HASH`），与 `etag` 同源 | 浏览器**按站点**记"有没有图标"：本站以前 404 过（内联之前就是 404），不加指纹它不会主动重取，表现为"改好了也一直不显示" |
| 换图标 | 覆盖 `app/favicon.ico` → `node tools/embed_favicon.mjs` → 升 `main.js` 的 `API_VERSION` → 部署 | 生成物与版本号联动，避免"换了图标但用户看到的是旧缓存" |
| 后端直出 | 不依赖 R2 里有没有该对象，也不额外消耗 R2 子请求 | 内联之前线上 `/favicon.ico` 就是"R2 里没这个对象 → 404" |

部署后自查：

```powershell
curl.exe -I https://lyjx.250036.xyz/favicon.ico
# 期望: 200 / content-type: image/png / cache-control: public, max-age=604800 / 有 etag
curl.exe -s https://lyjx.250036.xyz/admin/login | Select-String 'rel="icon"'
# 期望: <link rel="icon" href="/favicon.ico?v=<指纹>" type="image/png">
```

> **浏览器仍不显示时**（服务端已 200 却还是默认地球图标）：这是浏览器按站点缓存的旧结论，按顺序试——
> ① 强刷 `Ctrl+F5`（或 `Ctrl+Shift+R`）；② 关掉全部本站标签页再打开；
> ③ 清掉该站点数据（Chrome：地址栏左边图标 → Cookie 和网站数据 → 删除）；
> ④ 换个浏览器/隐身窗口验证（隐身窗口一定是最新结果）。
> 本次已经用"换 URL（`?v=`）"来规避这一条，正常用户重新打开页面就会取到新图标。

> `/images/logo.png` 是另一回事（登录页品牌图标，走 R2 的 `images/` 前缀）。
> R2 里没有它时登录页显示兜底的盾牌图标（不会裂图）；想换成真 logo，把它传到 `images/` 前缀即可。

---

## 验证清单（切线路前必须全过）

| 请求 | 期望 |
|---|---|
| `GET /` | HTML 状态页（服务名 + 运行中药丸 / 服务器时间·走动 / 进程启动时间·当前 isolate / 数据统计 6 项 / 依赖状态监控 D1+R2 与总连接状态 / 使用说明），与旧站 `templates/status.html` 同形 |
| `GET /favicon.ico` | **200** + `content-type: image/png` + `cache-control: public, max-age=604800`（内联字节直出，不需要往 R2 传） |
| 任意页面 `view-source` 或 `curl` 看 `<head>` | 都有同一串 `<link rel="icon" href="/favicon.ico?v=<指纹>" type="image/png">`（状态页 / 协议页 / 登录页 / 后台各页都一致） |
| `GET /images/<已上传的图>` | **200** + `etag` + `cache-control: public, max-age=604800` + `accept-ranges: bytes` |
| `GET /image/<新上传的图>`、`GET /video/<新上传的视频>`、`GET /avatar/<头像>` | 同上；历史路径 `/news_uploads/...`、`/avatar_uploads/...` 同样能直出（带 `Range: bytes=0-1023` 时回 **206** + `content-range`，视频拖动/续播靠它） |
| `GET /image/<不存在的对象>` | **404**；R2 绑定名写错时是 **502**（说明 `wrangler.toml` 与桶没对上） |
| 后台「本地上传」选一张图/一段视频 → 点上传 | 进度条走完并提示 `上传成功: image/xxx.png`（视频为 `video/xxx.mp4`），字段被回填；素材库弹窗里能立刻看到它（带目录徽章） |
| 后台笔记编辑页点「图片素材库」/「视频素材库」 | 弹窗按类型列出来自 R2 的素材（每行带目录徽章 `image`/`news_uploads`，图片优先显示缩略图，没有则回退原图），点一行即把相对路径回填到对应字段 |
| 后台笔记编辑页的 HTML 里 | 必须能看到 `/admin/static/js/image_upload.js?v=` 与 `/admin/static/js/media_library.js?v=`（这两个脚本由外壳统一引，见下表"点上传没反应"） |
| `node tools/thumb_plan.mjs --check <已有清单> <原图清单>` | 逐条标 `有`/`缺`；有缺失时退出码 **1**（原图 → 期望缩略图 key 的映射见「素材目录」节的缩略图表） |
| 笔记列表（带 `page`）里某条有缩略图 | 该条带 `image_thumb` 且指向 `<素材目录>_thumb/480/<名>.webp`；没有就**没有这个键**（不是空串） |
| `GET /?format=json` | `{"name":"狼牙极限运动笔记API","description":"本服务为…数据服务。","status":"运行中","server_time"}`（name/description/status 三值与旧站逐字一致） |
| `GET /health` | **裸结构**（无 code 包装）`{"status":"ok","service":"狼牙极限运动笔记API","uptime_s":0,"server_time",checks:{database,media}}` |
| `GET /health/ready` | **裸结构**（无 code 包装）`{"status":"ready",version,server_time,checks}`；D1 或 R2 不通时 **503** 且 `status:"starting"` |
| `GET /apitest` | `{code:200,msg:"API测试成功",data:{api_status:"online",server_time,version,database_connected:true},timestamp}` —— `api_status` 必须是 `online`（与旧站同口径，小程序「检测线路」只认它） |
| `GET /test` | **301** → `location: /apitest`（旧站目标，已实测） |
| `GET /index`、`/info` | **301** → `location: /` |
| `GET /config/get_app_config` | `{code:200,message:"获取应用配置成功",data:{categories,home_sections,featured,version,texts,menu},timestamp}`（有行说明搬迁成功） |
| `GET /news/list` | `{code:200,data:[…]}` —— **没有 `msg` 键**（旧站如此，不是 bug） |
| `GET /news/list?page=1&page_size=2` | `data` 是 `{list,total,page,page_size,has_more}`，并带 `msg:"获取成功"` |
| `GET /content/get_banners` | `code` 是 **0**，`message` 与 `msg` 并存 |
| `GET /content/get_outdoor` | `code/msg/status/message` 四键；未登录时每行**没有 `video_url` 键**、有 `can_watch_video:false` |
| `GET /pages/terms`、`/pages/privacy`、`/pages/download` | 200 HTML；协议与隐私正文来自 D1 `app_texts`（改了库就变） |
| `POST /user/login`（`DEV_WECHAT_MOCK=1`） | `code:200,msg:"登录成功"`，`data` 有 `token` 与绝对头像地址 |
| 写接口（点赞/收藏/分享/留言） | 正常写入；压到配额（点赞 60/分钟）返回 `429`「操作过于频繁，请稍后再试」 |
| `node tools/diff_api.mjs --old https://api0.250036.xyz --new https://lyjx.250036.xyz --token <测试token>` | **全部 `[一致]`**；任何 `[差异]` 都必须先改到一致再切 |
| `python tools/export_sqlite.py ../../fastapi/data/lyjx.db out/seed.sql` + `node tools/live_smoke.mjs` | 真实数据结构与数据下的端到端冒烟（列表/详情/点赞/限流/内容/配置/用户/登录/注销恢复删除/静态页/探针）**全部 OK**；需要 Node 22+ |

---

## 切线路与回滚

1. **先只部署、不切小程序**：按上面的清单验收，观察 1~2 天（`wrangler tail` 看有无 5xx）。
2. 小程序侧改 `lyjx/utils/constants.js`：把 `https://lyjx.250036.xyz` 作为线路之一并指为默认（版本号按你的口径升一版）。
3. 灰度：内部测试账号先用线路切换走新站（不用发版）。
4. **回滚**：把小程序线路切回 `api0.250036.xyz` 即可 —— 旧后端与旧库全程没动过；服务端也可 `wrangler rollback`。
5. 旧后端与旧库**先别删**，保留 1~2 周做兜底。

---

## 常见错误对照表

| 现象 | 原因 | 解决 |
|---|---|---|
| `Not logged in` / 需要 API Token | 没登录 | B1 |
| 部署报 `database_id` 相关错误（code 10021） | `database_id` 是占位符或填错；它**只有整行注释掉**时 wrangler 才会自动建库 | 回 A2 填真值，或注释掉该行再 push |
| `/health/ready` 里 `checks.database:false` | 绑定名不是 `DB`，或库不是 `lyjxxapp-d1` | 名字必须一致 |
| `checks.media:false` | 绑定名不是 `STORAGE`（或早期 `MEDIA`），或桶不是 `lyjxxapp-r2` | 名字必须与 `wrangler.toml` 的 `[[r2_buckets]].binding` 一致 |
| 图片/头像地址是空串 | `MEDIA_BASE` 没配（或写成别的域名） | 改 `[vars]` 的 `MEDIA_BASE` → 重新部署 |
| 登录报「微信登录失败，请稍后重试」 | 密钥没推上去（`npm run secrets:put`）或 AppID 不对 | 重推密钥；本地联调可先 `DEV_WECHAT_MOCK="1"` |
| 菜单图标 404 | `app/images` 没传到 R2 的 `images/` 前缀 | 见"素材上传"第 3 条 |
| 系统信息里"业务表数量/记录总数"显示 **统计失败，无法判定** | 行数统计那条查询没跑通（2026-10-06 线上曾因表清单混进 D1 内部表 `_cf_KV` 而整条统计失败） | 页面会直接显示失败原因原文；修好后正常显示张数与总数。若原因里出现 `_cf_` 之类内部表，说明表清单过滤需要更新（见 `app/core/overview.js` 的 `tableNames`） |
| 列表里没有 `image_thumb` | 缩略图没预生成（正常回退，显示原图） | 跑 `tools\make_cover_thumbs.py` 后重传 |
| 改了变量/密钥但没生效 | 运行中的是旧部署 | Retry deployment / `npm run deploy` 再来一次 |
| 小程序请求被微信拦 | 服务器域名白名单没加 | 加 `lyjx.250036.xyz` 与 `storage.250036.xyz`（旧线路 `api0.250036.xyz` 一起留着，回滚要用） |
| 访问 `/admin` 看到"后台未就绪" | 没配 `ADMIN_SESSION_SECRET` | 见 A8 第 2 步（加密变量），配完重新部署 |
| 图标不显示，但 `curl -I /favicon.ico` 是 200 | 浏览器按**站点**记着旧的"没有图标"（本站此前 404 过；浏览器不因服务端变好就重取） | 本版页面引用已带 `?v=<指纹>`，重开页面即生效；仍不显示看「站点图标」节的四步（强刷 / 关标签页 / 清站点数据 / 隐身窗口） |
| 点「上传」没反应（页面刷新或什么都不发生） | 上传表单靠 `static/js/image_upload.js` 认领并改走 XHR；该脚本是**生成物里的一份**，只改源文件不重跑 `tools/embed_admin_assets.mjs` 就不会生效 | 重跑 `node tools/embed_admin_assets.mjs` 并升 `main.js` 的 `API_VERSION` 后重新部署 |
| 素材库弹窗里看不到刚上传的图 | 列举只认 `image/`、`video/` 与历史 `news_uploads/`；若 R2 里对象被放到别的目录（例如手工 `r2 object put` 时写错前缀）就不会出现 | 按 `库内相对路径 = R2 key` 重传；目录清单见「素材目录」节 |
| 素材库/编辑页里的缩略图不显示 | 缩略图离线生成（Cloudflare 侧不生成），且 key 必须落在"目录随原图走"的位置：`image/` 的原图要放 `image/_thumb/480/…`，放成 `news_uploads/_thumb/…` 不会被命中 | 用 `node tools/thumb_plan.mjs --check …` 列出缺的 key 并按它上传（见「素材目录」节的缩略图段）；没有缩略图只是回退原图，不影响功能 |
| 编辑页（`news_edit` 等）点「本地上传」没反应；「图片/视频素材库」弹窗点开是空白 —— 而 `/admin/media_manage` 一切正常 | 上传与素材库这两块**由前端脚本驱动**（`image_upload.js` 认领表单并改走 XHR、`media_library.js` 拉列表并回填），而素材库管理页是**服务端直出**、不依赖脚本，所以只有编辑页会坏。这两个脚本由 `app/admin/lib/layout.js` 的 `MODAL_SCRIPTS` 统一引入（旧站是模板各自带 `<script>`，抽成 `partials.js` 时标签丢了→页面有弹窗有表单却没人处理 submit） | 打开编辑页看 HTML 里有没有 `/admin/static/js/image_upload.js?v=`、`/admin/static/js/media_library.js?v=`；改过 `app/admin/static/**` 必须 `node tools/embed_admin_assets.mjs` 并升 `API_VERSION` 后重新部署（`tests/admin_submit_action.test.mjs` 有"资源包不许有孤儿脚本"的检查拦这类回退） |
| 后台"执行 SQL"一直提示"请输入要执行的 SQL" | 前端发的是 JSON，而入口只解析 urlencoded（2.1.6 已修） | 升级部署到 2.1.6+ |
| 普通管理员能打开"管理员管理"或提交成功 | 该页原本只在页面内自查超管（2.1.6 起分发层也拦 `route_super`） | 升级部署到 2.1.6+；普通管理员会看到 403 |
| `/admin/bootstrap` 说"已经初始化过" | `admin_users` 里已有账号 | 直接去 `/admin/login`；**忘了口令**就 `DELETE FROM admin_users;` 后重新 bootstrap（A8 有完整步骤） |
| 登录总说"用户名或密码不正确" | 输错了，或 15 分钟内的失败次数到了上限（5 次/IP） | 等窗口过期再试；急着清就 `DELETE FROM rate_limit_counters WHERE scope='login'` |
| `/admin/db_manage` 提示"数据库工具未开启" | `ENABLE_SQL_TOOL` 还是 `0` | 改成 `"1"` 重新部署（A8.5）；用完改回 |
| 数据库工具里执行 SQL 报"只允许操作这些业务表" | 语句里出现了白名单外的表（如 `admin_users`、`wechat_tokens`） | 这是设计如此：执行范围与浏览范围是两件事，需要看这类表就用 D1 控制台 |
| 素材库管理删除报"仍有 N 处引用，已拒绝删除" | 该素材被笔记（含回收站）或轮播/专题/菜单引用 | 先改引用或清理回收站；点行内「查看引用明细」看具体位置 |
| 限流计数想立刻清 | 压测留下的计数 | 等窗口过（≤60 秒）或 `DELETE FROM rate_limit_counters` |
| 分享次数偏多 | 旧站 3 秒去重是进程内的，Workers 没做 | 见 `README.md` 第五节"已知差异"，需要就补 |

---

## 需要你拍板 / 待你确认

1. **D1 名额**：`lyjxxapp-d1` 占掉最后一个名额（9/10 → 10/10），确认可以。
2. **R2 桶**：新建 `lyjxxapp-r2`（与 backend-cf 的 `lyjxxapp-media` 不是同一个桶），确认。
3. **域名**：`api.` / `media.` / `pages.` 三个都用，还是只用其中一两个。
4. **是否先开 `DEV_WECHAT_MOCK`** 走一遍验收，再切真密钥。
5. **运营改数**：切换后改文案/菜单/轮播/公告只能手工执行 SQL（`notes/ops-sql.md`），确认接受。
6. **旧后端去向**：保留（回滚兜底）还是停服 —— 建议先保留 1~2 周。
