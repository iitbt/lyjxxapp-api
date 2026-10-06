# 限流设计：D1 计数表（已定，免费套餐可用）

**结论变化**：原本选 Durable Objects，但用户确认**只能用免费套餐**，而 Durable Objects 只在 Workers 付费套餐可用 → 改为 **D1 计数表**：同一个数据库、免费额度内、跨 isolate 精确。

计数表定义在 `app/sql/0002_rate_limit.sql`（`rate_limit_counters`），不混进 `0001_schema.sql`（那 18 张表是旧库结构的照搬）。

## 一、口径（与旧站逐项一致）

| 场景 | 配额 | 维度 | `scope` |
| --- | --- | --- | --- |
| 点赞 / 收藏 | 各 60 次 / 分钟 | 用户 | `like` / `favorite` |
| 分享 | 30 次 / 分钟 | 用户 | `share` |
| 留言 | 20 次 / 分钟 | 用户 | `comment` |
| 浏览历史上报 | 120 次 / 分钟 | 用户 | `view_history` |
| 头像上传 | 5 次 / 60 秒 | 用户 | `avatar` |
| 登录失败 | 5 次后锁 900 秒 | IP | `login` |

配额原值来自 `fastapi/app/core/ratelimit.py:114-115`；登录锁定默认值 `LOGIN_MAX_ATTEMPTS=5`、`LOGIN_LOCK_SECONDS=900`（`fastapi/app/core/config.py:239-240`，旧站 `.env` 若覆盖以实际值填）。超额一律 429 + 旧文案「操作过于频繁，请稍后再试」。

## 二、调用流程（读 → 判 → 与业务写入同批）

```js
// 1) 取窗口起点
const windowSec = 60;
const windowStart = Math.floor(Date.now() / 1000 / windowSec) * windowSec;

// 2) 先读当前计数(只读一次, 超限就不写业务)
const row = await env.DB.prepare(
  'SELECT count FROM rate_limit_counters WHERE scope=? AND bucket_key=? AND window_start=?'
).bind('like', `w:${userId}`, windowStart).first();
if (row && row.count >= 60) {
  return json({ code: 429, msg: '操作过于频繁，请稍后再试', data: null });
}

// 3) 计数自增与业务写入放进同一批(原子, 单次往返)
await env.DB.batch([
  env.DB.prepare(
    `INSERT INTO rate_limit_counters (scope, bucket_key, window_start, count) VALUES (?,?,?,1)
     ON CONFLICT(scope, bucket_key, window_start) DO UPDATE SET count = count + 1`
  ).bind('like', `w:${userId}`, windowStart),
  // ...这里放本次点赞的 INSERT/DELETE 与计数自增
]);
```

登录锁定（IP 维度，成功即清零）：

```sql
-- 失败一次
INSERT INTO rate_limit_counters (scope, bucket_key, window_start, count) VALUES ('login', ?, ?, 1)
ON CONFLICT(scope, bucket_key, window_start) DO UPDATE SET count = count + 1;

-- 登录成功: 清掉该 IP 的失败计数
DELETE FROM rate_limit_counters WHERE scope = 'login' AND bucket_key = ?;
```

## 三、过期清理（免费套餐可用）

在 `wrangler.toml` 配一个 Cron Trigger（免费套餐包含），每天跑一次：

```sql
DELETE FROM rate_limit_counters WHERE window_start < strftime('%s','now') - 86400;
```

## 四、代价与已知上限（刻意接受）

- **多一次读 + 一次写**：每条受限额度的写操作多 **1 行读 + 1 行写**。免费额度实测（2026-10-04 控制台）：**读 5,000,000 行/日、写 100,000 行/日**，当前已用 6.4k 读 / 1.4k 写 → 即使每天上万次点赞与浏览上报，也只吃掉额度的百分之几。
   - 提醒：该写入额度是**整个库共用**的（业务表写入也算），若将来写路径增长，先把浏览历史上报（120/分钟配额，最频繁）改成"合并上报"再看额度。
- **窗口边界不是严格原子**：两个并发请求可能同时读到 59 而都通过，实际最多超出并发数。业务侧的唯一索引（`news_likes_uniq` 等）保证不会写重复行，所以这是"配额可能多放一两个"，不是数据错误。
- **不做滑动窗口**：固定窗口与旧站一致，口径对齐优先于精度。
- **免费套餐没有 Durable Objects**：若将来升级付费且要求严格限流，把这一层换成 DO（改一个模块，调用点不变）。

## 五、验收

- 压到上限：第 61 次点赞返回 429，文案与旧站逐字一致；同一用户不同接口互不影响。
- 登录连续失败 5 次后，同 IP 被锁 900 秒；换 IP 不受影响；成功登录后计数清零。
- 读接口（列表/详情/公告）**不产生**计数写入。
- 清理任务跑完后，过期窗口的行数归零。
