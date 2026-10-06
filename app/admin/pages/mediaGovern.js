// 素材库管理(治理页, 仅超管) —— 逐条对齐旧站 app/admin/media_admin.py
//
// 旧站头注释点名的三条口径, 这里原样继承:
//   ① 这一页做的是**治理**(看占用 / 查引用 / 删无用文件), 不是"选素材" —— 选素材在字段旁的弹窗里;
//   ② **引用判定只有一个来源**: 列表列 /「查看引用」/ 删除前复查三处都调 scanReferences();
//      (旧站 v2.3.4 的 BUG 就是两处判定不一致: 等值比较 vs LIKE, 导致正文里的引用永远显示未引用)
//   ③ **引用检查必须包含回收站**: 软删除的笔记仍在库里、content 里仍写着路径,
//      否则会出现"删素材 → 恢复回收站 → 裂图"的静默事故。
//
// 平台差异(已在 README「已知差异」声明):
//   · 素材来源: 旧站 os.walk 本地目录 → 这里 R2 list(新目录 image//video/ + 历史目录 news_uploads/);
//   · 15 秒扫描短缓存: Worker 没有进程内状态, 不实现(每次真扫, 但对 R2 是读元信息, 成本低);
//   · 不做上传/重命名/转码(与旧站一致: 上传入口在字段旁, 重命名要同步改引用风险最高)。
import { escapeHtml } from '../../core/html.js';
import { settings } from '../../core/config.js';
import { all } from '../../core/db.js';
import { fmtBytes } from '../../core/overview.js';
import { MEDIA_PREFIXES, listNewsMedia, mediaUsage, removeMediaFile, relPathsIn, normRel } from '../../core/storage.js';
import { adminLayout } from '../lib/layout.js';
import { backButton, deleteConfirmCard, pageHeader } from '../lib/partials.js';
import { auditLog, buildListUrl, fmtDatetime, strOf, urlenc } from '../lib/utils.js';

const LIST_URL = '/admin/media_manage';
const DELETE_URL = '/admin/media_manage_delete';
const REFS_URL = '/admin/media_manage_refs';
const PER_PAGE = 10;

//: 排序选项(与旧站 _SORT_CHOICES 同口径)
const SORT_CHOICES = [
  ['time_desc', '最新优先'],
  ['time_asc', '最早优先'],
  ['size_desc', '体积从大到小'],
  ['size_asc', '体积从小到大'],
  ['name_asc', '文件名 A→Z']
];

//: 其它引用来源(表, 列, 中文名) —— 只列"可能装素材相对路径的列"(与旧站 _OTHER_REF_SOURCES 一致)
const OTHER_REF_SOURCES = [
  ['banner_images', 'image_url', '轮播图'],
  ['motorcycle_trips', 'poster', '摩旅精选封面'],
  ['motorcycle_trips', 'videoUrl', '摩旅精选视频'],
  ['outdoor_activities', 'poster', '户外精选封面'],
  ['outdoor_activities', 'videoUrl', '户外精选视频'],
  ['app_home_sections', 'image_url', '首页板块图标'],
  ['app_featured_items', 'image_url', '首页精选图标'],
  ['app_menu_items', 'icon', '我的页菜单图标']
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function redirectTo(url) {
  return new Response(null, { status: 302, headers: { location: url } });
}

/** 返回地址收敛: 只接受本页地址(防开放重定向, 旧站 _safe_back 同口径)。 */
function safeBack(raw) {
  const value = strOf(raw);
  if (!value.startsWith(LIST_URL) || value.startsWith('//')) return LIST_URL;
  if (value.includes('\\') || value.includes('://')) return LIST_URL;
  const rest = value.slice(LIST_URL.length);
  if (rest && rest[0] !== '?' && rest[0] !== '#') return LIST_URL;
  return value;
}

function backWith(back, params) {
  // 返回地址自带查询串(类型/排序/关键词)时不能再拼 `?`, 否则第二个问号会变成参数值的一部分
  const search = new URLSearchParams();
  Object.keys(params || {}).forEach((key) => search.set(key, String(params[key])));
  const joiner = back.includes('?') ? '&' : '?';
  return `${back}${joiner}${search.toString()}`;
}

/**
 * 全库引用扫描 —— **唯一判定实现**(列表列 /「查看引用」/ 删除前复查三处共用)。
 * only 传入时只保留这批路径(列表页用, 免得为几百条素材攒无用条目)。
 */
export async function scanReferences(env, only = null) {
  const hits = {};
  const keep = only ? new Set(only) : null;
  const record = (value, source, id, title, recycle) => {
    for (const rel of relPathsIn(value)) {
      if (keep && !keep.has(rel)) continue;
      if (!hits[rel]) hits[rel] = [];
      hits[rel].push({ source, id, title, recycle: Boolean(recycle) });
    }
  };

  // 粗筛: 任一素材目录命中就取回(真正的判定在 relPathsIn 的归一化等值比较)
  const likeSql = MEDIA_PREFIXES.map(() => 'LIKE ?').join(' OR ');
  const likeArgs = MEDIA_PREFIXES.map((prefix) => `%${prefix}%`);
  // 笔记: 三个来源列一起取(deleted_at 两种状态都查 —— 回收站里的笔记同样算引用)
  const newsRows = await all(
    env,
    'SELECT id,title,image,video_url,content,deleted_at FROM news '
    + `WHERE image ${likeSql} OR video_url ${likeSql} OR content ${likeSql} LIMIT 2000`,
    ...likeArgs, ...likeArgs, ...likeArgs
  ).catch(() => []);
  for (const row of newsRows) {
    const recycle = row.deleted_at !== null && row.deleted_at !== undefined && strOf(row.deleted_at) !== '';
    record(row.image, '笔记 · 封面', row.id, row.title, recycle);
    record(row.video_url, '笔记 · 视频地址', row.id, row.title, recycle);
    record(row.content, '笔记 · 正文', row.id, row.title, recycle);
  }

  for (const [table, column, label] of OTHER_REF_SOURCES) {
    const rows = await all(env,
      `SELECT id, "${column}" AS value FROM "${table}" WHERE "${column}" ${likeSql} LIMIT 500`,
      ...likeArgs).catch(() => []);
    for (const row of rows) record(row.value, label, row.id, '', false);
  }
  return hits;
}

function sortItems(items, sort) {
  const list = items.slice();
  if (sort === 'time_asc') list.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  else if (sort === 'size_desc') list.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  else if (sort === 'size_asc') list.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  else if (sort === 'name_asc') list.sort((a, b) => a.name.localeCompare(b.name));
  else list.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return list;
}

function isSuper(ctx) {
  return Boolean(ctx.session && ctx.session.isSuper);
}

function denied(ctx) {
  return redirectTo('/admin/dashboard?error=' + encodeURIComponent('该页面仅超级管理员可访问'));
}

async function thumbUsage(env) {
  let count = 0;
  let bytes = 0;
  // 缩略图目录随原图走, 新目录与历史目录都要统计; 某个目录列举失败只少算那部分, 不让整页失败
  for (const prefix of MEDIA_PREFIXES) {
    try {
      const listed = await settings(env).storage.list({ prefix: `${prefix}_thumb/`, limit: 1000 });
      const objects = (listed && listed.objects) || [];
      count += objects.length;
      for (const object of objects) bytes += Number(object.size) || 0;
    } catch (error) {
      // 忽略: 上面已说明口径
    }
  }
  return { count, bytes };
}

async function listPage(ctx) {
  if (!isSuper(ctx)) return denied(ctx);
  const kind = strOf(ctx.query.kind) === 'video' ? 'video' : strOf(ctx.query.kind) === 'image' ? 'image' : 'all';
  const q = strOf(ctx.query.q).toLowerCase();
  const sort = SORT_CHOICES.some(([value]) => value === strOf(ctx.query.sort)) ? strOf(ctx.query.sort) : 'time_desc';
  const wantsPage = Math.max(1, Number(strOf(ctx.query.page)) || 1);

  const kinds = kind === 'all' ? ['image', 'video'] : [kind];
  const collected = [];
  let truncated = false;
  let failed = false;
  for (const item of kinds) {
    const listed = await listNewsMedia(ctx.env, item);
    if (listed.failed) failed = true;
    truncated = truncated || listed.truncated;
    collected.push(...listed.items);
  }
  const searched = q ? collected.filter((item) => item.name.toLowerCase().includes(q)) : collected;
  const sorted = sortItems(searched, sort);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const page = Math.min(wantsPage, totalPages);
  const pageItems = sorted.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  // 引用情况: 只查本页这 10 个(与旧站"列表列用 only 过滤"同一优化)
  const refs = await scanReferences(ctx.env, pageItems.map((item) => item.path));
  const usage = await mediaUsage(ctx.env);
  const thumbs = await thumbUsage(ctx.env);
  const base = settings(ctx.env).mediaBase;

  const filterLink = (value, label) => {
    const url = buildListUrl(LIST_URL, { filters: { kind: value === 'all' ? '' : value, q: strOf(ctx.query.q), sort } });
    const active = kind === value ? 'active' : '';
    return `<a class="btn btn-sm btn-outline-primary ${active}" href="${url}">${label}</a>`;
  };

  const rows = pageItems.map((item) => {
    const itemRefs = refs[item.path] || [];
    const recycle = itemRefs.some((ref) => ref.recycle);
    const refCell = itemRefs.length
      ? `<a href="${REFS_URL}?path=${urlenc(item.path)}" target="_blank" rel="noopener">${itemRefs.length} 处</a>${recycle ? ' <span class="badge text-bg-warning">含回收站</span>' : ''}`
      : '<span class="text-muted">未引用</span>';
    const open = base ? `<a href="${escapeHtml(`${base.replace(/\/+$/, '')}/${item.path}`)}" target="_blank" rel="noopener">${escapeHtml(item.name)}</a>` : escapeHtml(item.name);
    return `<tr>
      <td>${open}</td>
      <td>${item.name.match(/\.(mp4|mov|m4v|webm|mkv)$/i) ? '视频' : '图片'}</td>
      <td>${fmtBytes(item.size)}</td>
      <td>${escapeHtml(fmtDatetime(item.uploaded ? new Date(item.mtime) : ''))}</td>
      <td>${refCell}</td>
      <td class="text-end"><a class="btn btn-sm btn-outline-danger" href="${DELETE_URL}?path=${urlenc(item.path)}&back=${urlenc(ctx.url.pathname + ctx.url.search)}">删除</a></td>
    </tr>`;
  }).join('');

  const pageLink = (target, label, disabled) => (disabled
    ? `<span class="btn btn-sm btn-outline-secondary disabled">${label}</span>`
    : `<a class="btn btn-sm btn-outline-secondary" href="${buildListUrl(LIST_URL, { filters: { kind: kind === 'all' ? '' : kind, q: strOf(ctx.query.q), sort, page: target } })}">${label}</a>`);

  const content = `${pageHeader({ icon: 'bi-collection-play', title: '素材库管理', actions: backButton('/admin/dashboard') })}
  <div class="card mb-3"><div class="card-body">
    <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
      ${filterLink('all', '全部')}${filterLink('video', '视频')}${filterLink('image', '图片')}
      <form class="d-flex gap-2 ms-2" method="get" action="${LIST_URL}">
        <input type="hidden" name="kind" value="${kind === 'all' ? '' : kind}">
        <input type="hidden" name="sort" value="${sort}">
        <input class="form-control form-control-sm" style="width:12rem" type="search" name="q" value="${escapeHtml(strOf(ctx.query.q))}" placeholder="按文件名搜索">
        <select class="form-select form-select-sm" name="sort" onchange="this.form.submit()">
          ${SORT_CHOICES.map(([value, label]) => `<option value="${value}"${value === sort ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-outline-secondary" type="submit">筛选</button>
      </form>
    </div>
    <div class="small text-muted">
      共 ${sorted.length} 个文件 · 单页 ${PER_PAGE} · 第 ${page}/${totalPages} 页 ·
      占用 ${fmtBytes(usage.bytes)}（${usage.count} 个原文件${truncated ? '，已达扫描上限，实际可能更多' : ''}）·
      派生缩略图 ${thumbs.count} 个 / ${fmtBytes(thumbs.bytes)}${failed ? ' · <span class="text-danger">部分读取失败</span>' : ''}
    </div>
  </div></div>
  <div class="card"><div class="card-body">
    <div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0">
      <thead><tr><th>文件</th><th>类型</th><th>体积</th><th>修改时间</th><th>引用</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="text-muted">没有匹配的素材</td></tr>`}</tbody>
    </table></div>
    <div class="d-flex gap-2 mt-3">${pageLink(page - 1, '上一页', page <= 1)}${pageLink(page + 1, '下一页', page >= totalPages)}</div>
  </div></div>`;

  return adminLayout(Object.assign({}, ctx, { title: '素材库管理', currentPage: 'media_manage', content }));
}

async function refsJson(ctx) {
  if (!isSuper(ctx)) return json({ success: false, message: '该页面仅超级管理员可访问' });
  const path = normRel(strOf(ctx.query.path));
  if (!path) return json({ success: false, message: '参数错误' });
  const refs = await scanReferences(ctx.env, [path]);
  const items = refs[path] || [];
  return json({ success: true, path, total: items.length, items });
}

async function deleteGet(ctx) {
  if (!isSuper(ctx)) return denied(ctx);
  const path = normRel(strOf(ctx.query.path));
  if (!path) return redirectTo(backWith(LIST_URL, { error: '参数错误' }));
  const back = safeBack(ctx.query.back);
  const refs = (await scanReferences(ctx.env, [path]))[path] || [];

  // 有引用一律拒绝(含回收站) —— 删了不可恢复
  const blocked = refs.length > 0;
  const impact = OTHER_REF_SOURCES.map(([, , label]) => [label, refs.filter((ref) => ref.source === label).length])
    .concat([['笔记（含回收站）', refs.filter((ref) => ref.source.startsWith('笔记')).length]])
    .filter(([, count]) => count > 0);

  const impactRows = impact.map(([label, count]) => `<li>${escapeHtml(label)}：<b>${count}</b> 处</li>`).join('');
  const body = blocked
    ? `<div class="alert alert-warning mb-3">这个素材还被 ${refs.length} 处引用，<b>不能删除</b>。请先改掉引用（或清理回收站）再来。</div>
       <ul class="mb-3">${impactRows}</ul>
       <div class="d-flex gap-2">${backButton(back, '返回素材列表')}<a class="btn btn-sm btn-outline-secondary" href="${REFS_URL}?path=${urlenc(path)}" target="_blank" rel="noopener">查看引用明细</a></div>`
    : `<div class="alert alert-secondary">即将删除：<code>${escapeHtml(path)}</code></div>
       ${deleteConfirmCard({
      title: '删除素材',
      impact: [['待删除文件', 1]],
      totalImpact: 1,
      submitAction: DELETE_URL,
      hiddenFields: [['path', path], ['back', back], ['confirm', '1']],
      backUrl: back,
      recoverable: false,
      tip: 'R2 上的对象删除后不可恢复（没有回收站），提交前会再复查一次引用。'
    })}`;

  const content = `${pageHeader({ icon: 'bi-trash3', title: '删除素材', actions: backButton(back) })}
  <div class="card"><div class="card-body">${body}</div></div>`;
  return adminLayout(Object.assign({}, ctx, { title: '删除素材', currentPage: 'media_manage', content }));
}

async function deletePost(ctx) {
  if (!isSuper(ctx)) return json({ success: false, message: '该操作仅超级管理员可执行' }, 403);
  const body = ctx.form && Object.keys(ctx.form).length ? ctx.form : ctx.body || {};
  const path = normRel(strOf(body.path));
  const back = safeBack(body.back);
  if (!path) return redirectTo(backWith(back, { error: '参数错误' }));

  // 删除前**复查**引用: 从打开确认页到点提交之间, 可能刚好有人加了一条引用
  const refs = (await scanReferences(ctx.env, [path]))[path] || [];
  if (refs.length) {
    auditLog('admin.media_manage_delete', { username: ctx.session.username, path, ok: false, refs: refs.length });
    return redirectTo(backWith(back, { error: `该素材仍有 ${refs.length} 处引用，已拒绝删除` }));
  }
  try {
    await removeMediaFile(ctx.env, path);
  } catch (error) {
    auditLog('admin.media_manage_delete', { username: ctx.session.username, path, ok: false, reason: error && error.message });
    return redirectTo(backWith(back, { error: '删除失败，请稍后重试' }));
  }
  auditLog('admin.media_manage_delete', { username: ctx.session.username, path, ok: true });
  return redirectTo(backWith(back, { message: `已删除 ${path}` }));
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: LIST_URL, handler: listPage },
  { methods: ['GET', 'HEAD'], path: REFS_URL, handler: refsJson },
  { methods: ['GET', 'HEAD'], path: DELETE_URL, handler: deleteGet },
  { methods: ['POST'], path: DELETE_URL, handler: deletePost }
];
