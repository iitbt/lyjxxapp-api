// 路由表: 33 条对外接口都是固定路径, 无路径参数, 所以用 Map 直接精确匹配
export function createRouter() {
  const table = new Map();

  const key = (method, path) => `${method.toUpperCase()} ${path}`;

  function add(methods, path, handler) {
    for (const method of [].concat(methods)) {
      table.set(key(method, path), handler);
    }
  }

  function get(path, handler) {
    add(['GET', 'HEAD'], path, handler);
  }

  function post(path, handler) {
    add('POST', path, handler);
  }

  // GET/POST 都收(旧站很多接口两种方法都挂)
  function any(path, handler) {
    add(['GET', 'HEAD', 'POST'], path, handler);
  }

  function match(method, pathname) {
    const upper = method.toUpperCase();
    const direct = table.get(key(upper, pathname));
    if (direct) return direct;
    // HEAD 落回 GET; 旧站把 POST 接口也允许 GET 探测的情况由 any() 覆盖
    if (upper === 'HEAD') return table.get(key('GET', pathname)) || null;
    return null;
  }

  return { add, get, post, any, match, paths: () => Array.from(table.keys()) };
}
