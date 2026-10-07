// 区域(Location)工具: 查 D1/R2 当前落在哪个区域; 需要时按 apac 新建一份(只新增, 不删任何东西)
//
// 背景: D1 的 primary location 与 R2 的 location hint 都是**建资源时定死的**, 建完不能改。
// 本项目当初靠 "database_id 留空 → wrangler 部署时自动建库/建桶" 起步, 自动创建不带 --location
// → 落到默认区域(西欧)。要挪到亚太只能"新建一份 + 迁数据", 迁完再改 wrangler.toml 的绑定。
//
// 用法:
//   node tools/cf_region.mjs report
//   node tools/cf_region.mjs create --d1 lyjxxapp-d1-apac --r2 lyjxxapp-r2-apac [--location apac]
// 环境变量:
//   CLOUDFLARE_API_TOKEN  必填(D1:Edit + R2:Edit 权限; report 只读也走它)
//   CLOUDFLARE_ACCOUNT_ID 可选: 账号里有多个时指定
//
// 说明: 本工具**只做查询与新建**, 不删除任何资源; 数据迁移见 DEPLOY.md「区域(Location)与资源重建」。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const DEFAULT_LOCATION = 'apac';   // 亚太(就近中国大陆), 与 DEPLOY.md 的口径一致

function argOf(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function tokenOf() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  // 没配 token 时试着从 wrangler 的登录态读(非交互环境下 wrangler 自己会拒绝, 这只是一次尝试)
  try {
    const raw = execFileSync('node', ['-e', `
      const fs=require('fs'),path=require('path');
      const file=path.join(process.env.APPDATA||'', 'xdg.config', '.wrangler', 'config', 'default.toml');
      const text=fs.readFileSync(file,'utf8');
      const hit=/^oauth_token\\s*=\\s*"([^"]+)"/m.exec(text);
      process.stdout.write(hit?hit[1]:'');
    `], { encoding: 'utf8' });
    return String(raw || '').trim();
  } catch (error) {
    return '';
  }
}

async function api(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, Object.assign({}, init, {
    headers: Object.assign({
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    }, init.headers || {})
  }));
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const detail = (body.errors || []).map((item) => `${item.code} ${item.message}`).join('; ');
    const stale = res.status === 403 && /9109|Invalid access token/i.test(detail);
    throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${detail || '请求失败'}`
      + (stale ? '\n令牌无效或已过期(wrangler 登录态里的 OAuth 令牌在非交互环境用不了): '
        + '请到控制台建 API 令牌(D1:Edit + R2:Edit)并设置 CLOUDFLARE_API_TOKEN 后重试。' : ''));
  }
  return body.result;
}

async function accountsOf(token) {
  const wanted = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const list = await api(token, '/accounts?per_page=50');
  const picked = wanted ? list.filter((item) => item.id === wanted) : list;
  if (!picked.length) throw new Error('没有匹配的账号(检查 CLOUDFLARE_ACCOUNT_ID 或令牌权限)');
  return picked;
}

async function report(token) {
  for (const account of await accountsOf(token)) {
    console.log(`账号 ${account.name} (${account.id})`);
    const dbs = await api(token, `/accounts/${account.id}/d1/database`);
    if (!dbs.length) console.log('  D1: (无)');
    for (const db of dbs) {
      // primary_location_hint 是建库时定死的; 有的接口版本把位置放在 location 字段
      const hint = db.primary_location_hint || db.location || '(接口未返回, 看控制台)';
      console.log(`  D1  ${db.name.padEnd(24)} uuid=${db.uuid}  location=${hint}  created=${db.created_at || '-'}`);
    }
    const buckets = await api(token, `/accounts/${account.id}/r2/buckets?per_page=100`);
    const items = (buckets && buckets.buckets) || [];
    if (!items.length) console.log('  R2: (无)');
    for (const bucket of items) {
      console.log(`  R2  ${bucket.name.padEnd(24)} location=${bucket.location || '(未设置 → 默认区域)'}`
        + `  created=${bucket.creation_date || '-'}`);
    }
  }
  console.log('\n区域期望: apac(亚太)。不是 apac 的资源只能"新建一份 + 迁数据"，见 DEPLOY.md。');
}

async function create(token, location) {
  const d1Name = argOf('d1');
  const r2Name = argOf('r2');
  if (!d1Name && !r2Name) throw new Error('至少要给 --d1 <新库名> 或 --r2 <新桶名>');
  for (const account of await accountsOf(token)) {
    if (d1Name) {
      const created = await api(token, `/accounts/${account.id}/d1/database`, {
        method: 'POST', body: JSON.stringify({ name: d1Name, primary_location_hint: location })
      });
      console.log(`已建 D1  ${created.name}  uuid=${created.uuid}  location=${created.primary_location_hint || location}`);
      console.log(`  → wrangler.toml: database_name = "${created.name}" / database_id = "${created.uuid}"`);
    }
    if (r2Name) {
      // R2 建桶用 locationHint(camelCase); 若接口改口径会报错, 那就用控制台建桶(Location 选 Asia Pacific)
      const created = await api(token, `/accounts/${account.id}/r2/buckets`, {
        method: 'POST', body: JSON.stringify({ name: r2Name, locationHint: location })
      });
      console.log(`已建 R2  ${created.name}  location=${created.location || location}`);
      console.log(`  → wrangler.toml: bucket_name = "${created.name}"`);
    }
  }
  console.log('\n注意: 新资源是**空的**, 迁完数据再改 wrangler.toml 并重新部署; 旧资源先留着做回滚。');
}

/** 先本地体检: wrangler.toml 缺 database_id 时, wrangler 任何命令都会直接报错(连 d1 export 都跑不了)。 */
function warnConfig() {
  try {
    const text = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    if (/^\s*database_id\s*=\s*"/m.test(text)) return true;
    console.warn('⚠️ wrangler.toml 里的 database_id 还是注释状态: wrangler 会拒绝加载配置'
      + '（报 "d1_databases[0] bindings must have a database_id field"），'
      + 'deploy / d1 export / d1 execute 全都跑不了。\n'
      + '   取法: 控制台 D1 详情页的 Database ID, 或先给 CLOUDFLARE_API_TOKEN 再跑 node tools/cf_region.mjs report。\n');
    return false;
  } catch (error) {
    console.warn('⚠️ 读不到 wrangler.toml:', error.message);
    return false;
  }
}

const command = (process.argv[2] || '').trim();
warnConfig();
const token = tokenOf();
if (!command || command === '--help' || command === '-h') {
  console.log('用法:\n  node tools/cf_region.mjs report\n'
    + '  node tools/cf_region.mjs create --d1 <新库名> --r2 <新桶名> [--location apac]\n\n'
    + '环境变量: CLOUDFLARE_API_TOKEN(必填), CLOUDFLARE_ACCOUNT_ID(可选)');
  process.exit(command ? 0 : 2);
}
if (!token) {
  console.error('缺少 CLOUDFLARE_API_TOKEN: 在 Cloudflare 控制台建一个令牌(D1:Edit + R2:Edit), '
    + '然后 $env:CLOUDFLARE_API_TOKEN="..." 再跑本工具。');
  process.exit(1);
}
try {
  if (command === 'report') await report(token);
  else if (command === 'create') await create(token, argOf('location', DEFAULT_LOCATION));
  else {
    console.error(`未知命令: ${command}(可用: report / create)`);
    process.exit(2);
  }
} catch (error) {
  console.error('失败:', error.message);
  process.exit(1);
}
