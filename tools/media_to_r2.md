# 素材搬迁到 R2（由你自行执行）

实测体量（2026-10-04 于 `fastapi/`）：`news_uploads/` 23 个文件 0.57 MB（全在 `home/` 子目录），`avatar_uploads/` 空，`app/images/` 4 个文件 0.1 MB。**体量极小，几乎是一次性的复制操作。**

本次只搬仓库内这些现有文件，**不涉及视频**（已定），因此不需要私有块与签名 URL。

## 一、原则

- **R2 key 与数据库里存的相对路径保持一致**（`news_uploads/xxx.jpg`、`avatar_uploads/xxx.png`），这样库里字段一个都不用改。
- 三个前缀（`news_uploads/`、`avatar_uploads/`、`images/`）全部公开，走自定义域直读。
- 派生文件（缩略图）**必须在旧环境预生成**：Workers 里没有 Pillow，无法在线生成。

## 二、步骤

1. 生成缩略图（在旧后端环境跑现成工具，不要重写）：

   ```bash
   cd fastapi
   python tools/make_cover_thumbs.py        # 宽度 480 / 800, 输出 news_uploads/_thumb/<宽度>/<名>.webp
   ```

2. 建立 bucket 与公开域（公开域已定：`storage.250036.xyz`）：

   ```bash
   wrangler r2 bucket create lyjxxapp-r2
   ```

3. 批量上传（保持目录层级即 key）：

   ```bash
   cd fastapi
   # 逐个上传; 文件只有二十几个, 不必写复杂脚本
   wrangler r2 object put lyjxxapp-r2/news_uploads/home/<文件> --file=news_uploads/home/<文件>
   wrangler r2 object put lyjxxapp-r2/news_uploads/_thumb/480/<文件>.webp --file=news_uploads/_thumb/480/<文件>.webp
   ```

   文件多时改用 S3 兼容方式（rclone / aws-cli，需 R2 的 Access Key 与 Secret —— **待确认**）：

   ```bash
   rclone copy fastapi/news_uploads r2:lyjxxapp-r2/news_uploads --transfers 8
   rclone copy fastapi/avatar_uploads r2:lyjxxapp-r2/avatar_uploads
   # app/images 里的 4 个文件必须放到 images/ 前缀: Worker 的 /images/* 从这里读
   # (站点图标 /favicon.ico 不在这里 —— 它是内联进 Worker 的, 见 DEPLOY.md「站点图标」)
   rclone copy fastapi/app/images r2:lyjxxapp-r2/images
   ```

4. 核对数量与体积：

   ```bash
   find fastapi/news_uploads -type f | wc -l          # 本地文件数
   wrangler r2 object list lyjxxapp-r2 --prefix=news_uploads | wc -l   # R2 对象数
   ```

5. 验证公开访问：用一个真实 key 直接请求自定义域，确认 200 与 `Content-Type` 正确，并核对 **`Cache-Control`** 是否符合旧口径（媒体 7 天、缩略图 1 年 immutable、vendor 1 年 immutable）—— 由自定义域缓存规则或前置 Worker 设置（**待确认**用哪种）。

## 三、验收

- 随机抽 5 个 key：R2 上的 key、体积与本地一致。
- `/news/list` 返回的 `image_url` / 缩略图地址能直接打开（HTTP 200）。
- 缩略图缺失时接口仍要正常工作（旧实现是"查得到就用，查不到回退原图"），这条必须实测。
