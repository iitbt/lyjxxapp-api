// 分类真值来源(唯一实现, 照旧站 fastapi/app/core/category_source.py 的口径)
// 谁在用: 「分类管理」自身、「首页板块管理」(入口必须命中启用中的分类)、列表页的"分类"列
import { all } from '../../core/db.js';
import { strOf } from './utils.js';

// 分类名映射 {category_key: name}: 列表页"分类"列实时取它,
// 这样在「分类管理」里改了名字, 其它页面立即跟随, 不必等每条数据被重新保存一遍
export async function getNameMap(env) {
  const rows = await all(env, 'SELECT category_key, name FROM app_categories ORDER BY sort_order ASC, id ASC')
    .catch(() => []);
  const map = {};
  for (const row of rows) map[strOf(row.category_key)] = strOf(row.name);
  return map;
}

// 启用中的分类 key 集合(首页板块校验"入口必须命中启用分类", 否则点进去是空列表)
export async function getActiveKeys(env) {
  const rows = await all(env, 'SELECT category_key FROM app_categories WHERE status=1 ORDER BY sort_order ASC, id ASC')
    .catch(() => []);
  return new Set(rows.map((row) => strOf(row.category_key)).filter(Boolean));
}

// 编辑页的下拉选项: 文案统一「名称（标识）」; 当前值已停用或已删除时补一个兜底项,
// 否则编辑历史数据时下拉里没有当前值, 一保存就把分类改掉了
export async function optionsForSelect(env, current) {
  const rows = await all(env, 'SELECT category_key, name, status FROM app_categories ORDER BY sort_order ASC, id ASC')
    .catch(() => []);
  const options = rows.map((row) => {
    const key = strOf(row.category_key);
    return [key, `${strOf(row.name) || key}（${key}）`];
  });
  const wanted = strOf(current);
  if (wanted && !options.some(([value]) => value === wanted)) {
    options.unshift([wanted, `${wanted}（已停用或已删除）`]);
  }
  return options;
}

// 取分类名: 未知(已删除)时回退到标识本身, 便于在页面上发现历史脏数据
export function nameFor(nameMap, key, fallback = '') {
  const wanted = strOf(key);
  if (!wanted) return fallback;
  const found = nameMap[wanted];
  return found !== undefined && found !== '' ? found : (fallback || wanted);
}
