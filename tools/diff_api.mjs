// 新旧站对拍: 同一批请求分别打旧站与新站, 逐字段比对 JSON, 只输出差异
// 用法: node scripts/diff_api.mjs --old https://api0.250036.xyz --new http://127.0.0.1:8787 --token <token>
const args = process.argv.slice(2);
const pick = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1].replace(/\/+$/, '') : fallback;
};

const OLD = pick('old', 'https://api0.250036.xyz');
const NEW = pick('new', 'http://127.0.0.1:8787');
const TOKEN = pick('token', '');
const NOTE_ID = pick('id', '1');

// 33 条接口的代表性调用(读接口全列, 写接口只做只读探测)
const CASES = [
  ['GET', '/'],
  ['GET', '/?format=json'],
  ['GET', '/apitest'],
  ['GET', '/health'],
  ['GET', '/news/list'],
  ['GET', `/news/list?page=1&page_size=2${TOKEN ? `&token=${TOKEN}` : ''}`],
  ['GET', `/news/detail?id=${NOTE_ID}`],
  ['GET', `/news/get_comments?news_id=${NOTE_ID}`],
  ['GET', `/news/check_user_action?news_id=${NOTE_ID}&user_id=1`],
  ['GET', '/content/get_banners'],
  ['GET', '/content/get_outdoor'],
  ['GET', '/content/get_motorcycle'],
  ['GET', '/content/get_notices?page=1&page_size=5'],
  ['GET', '/config/get_app_config'],
  ['GET', '/pages/terms'],
  ['GET', '/pages/privacy']
];

const POST_CASES = [
  ['/user/get_user_info', { token: TOKEN }],
  ['/user/user_favorites', { token: TOKEN, action: 'get', page: 1, page_size: 5 }],
  ['/user/user_likes', { token: TOKEN, action: 'get', page: 1, page_size: 5 }],
  ['/user/user_view_history', { token: TOKEN, action: 'get', page: 1, page_size: 5 }]
];

async function hit(base, method, path, body) {
  const init = { method, headers: {} };
  if (body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const response = await fetch(base + path, init);
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = { __html: text.slice(0, 200) };
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    return { status: 0, body: { __error: String(error.message || error) } };
  }
}

// 只比结构与值, 忽略时间戳类字段(每次调用必然不同)
const IGNORE = new Set(['timestamp', 'server_time', 'update_time', 'create_time', 'view_count']);
// 素材域不同不算差异(旧站拼 api0, 新站拼 media), 归一化后只比路径与文件名
const HOST_RE = /https?:\/\/(api0|media|lyjx|api)\.250036\.xyz/gi;
const norm = (value) => (typeof value === 'string' ? value.replace(HOST_RE, '<HOST>') : value);

function diff(a, b, path, out) {
  if (out.length > 60) return;
  const typeA = Array.isArray(a) ? 'array' : typeof a;
  const typeB = Array.isArray(b) ? 'array' : typeof b;
  if (typeA !== typeB) {
    out.push(`${path}: 类型不同 旧=${typeA} 新=${typeB}`);
    return;
  }
  // 数组必须逐元素递归: 原先只比引用, 导致 [] vs [] 也被当成差异(假阳性淹没真差异)
  if (typeA === 'array') {
    if (a.length !== b.length) {
      out.push(`${path}: 长度不同 旧=${a.length} 新=${b.length}`);
      return;
    }
    for (let index = 0; index < a.length; index += 1) {
      diff(a[index], b[index], `${path}[${index}]`, out);
    }
    return;
  }
  if (typeA === 'object' && a && b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (IGNORE.has(key)) continue;
      if (!(key in a)) out.push(`${path}.${key}: 新站多出该字段`);
      else if (!(key in b)) out.push(`${path}.${key}: 新站缺少该字段(旧值=${JSON.stringify(a[key]).slice(0, 40)})`);
      else diff(a[key], b[key], `${path}.${key}`, out);
    }
    return;
  }
  if (String(norm(a)) === String(norm(b))) return;
  out.push(`${path}: 旧=${JSON.stringify(norm(a)).slice(0, 60)} 新=${JSON.stringify(norm(b)).slice(0, 60)}`);
}

let failed = 0;
for (const [method, path] of CASES) {
  const [oldResult, newResult] = await Promise.all([hit(OLD, method, path), hit(NEW, method, path)]);
  const out = [];
  if (oldResult.status !== newResult.status) out.push(`HTTP 状态: 旧=${oldResult.status} 新=${newResult.status}`);
  diff(oldResult.body, newResult.body, '$', out);
  if (out.length) {
    failed += 1;
    console.log(`\n[差异] ${path}`);
    out.forEach((line) => console.log(`  - ${line}`));
  } else {
    console.log(`[一致] ${path}`);
  }
}

for (const [path, body] of POST_CASES) {
  if (!body.token) {
    console.log(`[跳过] POST ${path}（需要 --token）`);
    continue;
  }
  const [oldResult, newResult] = await Promise.all([hit(OLD, 'POST', path, body), hit(NEW, 'POST', path, body)]);
  const out = [];
  diff(oldResult.body, newResult.body, '$', out);
  if (out.length) {
    failed += 1;
    console.log(`\n[差异] POST ${path}`);
    out.forEach((line) => console.log(`  - ${line}`));
  } else {
    console.log(`[一致] POST ${path}`);
  }
}

console.log(`\n合计存在差异的入口: ${failed}`);
process.exit(failed ? 1 : 0);
