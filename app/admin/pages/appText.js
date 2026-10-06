// 运营文案: 列表(按分组筛选) / 新增编辑 / 删除
// 逐条对齐旧站 fastapi/app/admin/config_center.py 的文案那部分
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { adminLayout } from '../lib/layout.js';
import { BUILTIN_TEXT_KEYS, TEXT_GROUPS } from '../lib/catalog.js';
import { editShell, emptyRow, listMeta, numberField, selectField, switchField, textareaField, textField } from '../lib/partials.js';
import { statusActions, statusBadgeClass, statusKind, statusLabel } from '../lib/status.js';
import {
  CONTROLLED_LIST_LIMIT, auditLog, buildListUrl, intOr, invalidateEntityCache, strOf, textOf
} from '../lib/utils.js';

const MANAGE_URL = '/admin/app_text_manage';
const COLUMNS = ['文案标识', '说明', '分组', '排序', '状态', '操作'];
// 文案标识格式: 小写字母开头 + 小写字母/数字/下划线, 可用点分(如 login.prompt)
const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,4}$/;

function statusCell(row) {
  const kind = statusKind('app_text');
  return `<span class="badge text-bg-${statusBadgeClass(kind, row.status)}" data-status-badge>${escapeHtml(statusLabel(kind, row.status))}</span>`;
}

function actionsCell(row) {
  const kind = statusKind('app_text');
  const buttons = statusActions(kind, row.status).map((action) => `<button type="button" class="btn btn-sm btn-${action.btnClass}"`
    + ` data-status-kind="${kind.key}" data-status-id="${row.id}" data-status-action="${escapeHtml(action.value)}"`
    + `${action.visible ? '' : ' hidden'}>${escapeHtml(action.label)}</button>`).join('');
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="/admin/app_text_edit?id=${row.id}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=text&amp;id=${row.id}&amp;back=${encodeURIComponent(MANAGE_URL)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

function renderRows(rows) {
  if (!rows || !rows.length) return emptyRow(COLUMNS, '暂无文案');
  return rows.map((row) => {
    // 正文只显示第一行(换行替换成空格), 悬停才看全
    const preview = strOf(row.content).replace(/\n+/g, ' ');
    return `<tr>
  <td class="text-nowrap"><code>${escapeHtml(row.text_key || '-')}</code></td>
  <td>
    <div class="text-truncate clamp-lg" title="${escapeHtml(strOf(row.title))}">${escapeHtml(strOf(row.title) || '-')}</div>
    <div class="small text-muted text-truncate" title="${escapeHtml(preview)}">${escapeHtml(preview)}</div>
  </td>
  <td class="text-nowrap">${escapeHtml(strOf(row.group_name) || '-')}</td>
  <td class="text-nowrap">${row.sort_order}</td>
  <td class="text-nowrap">${statusCell(row)}</td>
  <td class="text-nowrap">${actionsCell(row)}</td>
</tr>`;
  }).join('');
}

async function managePage(ctx) {
  const group = strOf(ctx.query.group);
  const where = group ? ' WHERE group_name = ?' : '';
  const args = group ? [group] : [];
  let rows = [];
  let total = 0;
  let allKeys = [];
  let error = '';
  try {
    total = intOr((await one(ctx.env, `SELECT COUNT(*) AS c FROM app_texts${where}`, ...args)).c, 0);
    rows = await all(ctx.env,
      `SELECT * FROM app_texts${where} ORDER BY sort_order ASC, id ASC LIMIT ?`, ...args, CONTROLLED_LIST_LIMIT);
    // 缺内置文案必须按**全表**判断: 用被 LIMIT 截断的 rows 会把"排在 200 条之后"的误报成缺失
    allKeys = (await all(ctx.env, 'SELECT text_key FROM app_texts')).map((item) => strOf(item.text_key));
  } catch (err) {
    console.error('获取运营文案失败', err && err.message);
    rows = [];
    error = '读取数据失败，请稍后重试';
  }
  const truncated = total > rows.length;
  const missing = BUILTIN_TEXT_KEYS.filter((key) => !allKeys.includes(key));
  const warn = missing.length
    ? `<div class="alert alert-warning" role="alert">
      以下文案在表里没有记录，接口正在使用内置默认值：${missing.map((key) => `<code>${escapeHtml(key)}</code>`).join('、')}
      <div class="small mt-1">（不是错误；如需修改它们的文案，请点「添加文案」按上面的标识新建一条。）</div>
    </div>`
    : '';
  const groupForm = `<form class="d-flex gap-2" method="get" action="${MANAGE_URL}">
    <select class="form-select form-select-sm" name="group" style="max-width:160px">
      <option value="">全部分组</option>
      ${TEXT_GROUPS.map((name) => `<option value="${escapeHtml(name)}"${group === name ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}
    </select>
    <button class="btn btn-sm btn-outline-secondary" type="submit"><i class="bi bi-funnel" aria-hidden="true"></i> 筛选</button>
    ${group ? `<a class="btn btn-sm btn-outline-secondary" href="${MANAGE_URL}">清除</a>` : ''}
  </form>`;
  const content = `<div class="card"><div class="card-body">
  ${warn}
  <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
    <a class="btn btn-primary" href="/admin/app_text_edit?id=0"><i aria-hidden="true" class="bi bi-plus-lg"></i> 添加文案</a>
    ${groupForm}
    <span class="ms-auto text-end">${listMeta({ total, unit: '条', simple: true })}${truncated ? ` <span class="text-danger">（仅显示前 ${CONTROLLED_LIST_LIMIT} 条，请用分组筛选定位）</span>` : ''}</span>
  </div>
  <div class="table-responsive">
    <table aria-label="运营文案列表" class="table table-hover align-middle">
      <thead class="table-light"><tr>${COLUMNS.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${renderRows(rows)}</tbody>
    </table>
  </div>
  <div class="small text-muted mt-3">
    · 表里没有的 key，小程序会用自己的内置兜底文案，不会白屏；<br>
    · 停用某条 = 让小程序回到内置默认文案；不要用它来做「临时下线」；<br>
    · 「停用」和「删除」对小程序的效果一样（都回到内置默认文案）。
  </div>
</div></div>`;
  return adminLayout({
    title: '运营文案配置', currentPage: 'app_text_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

async function keyExists(env, textKey, rowId) {
  try {
    const found = await one(env, 'SELECT id FROM app_texts WHERE text_key=? AND id<>?', textKey, rowId);
    return Boolean(found);
  } catch (error) {
    // 查询失败时按"没被占用"处理: 宁可让唯一索引兜底, 也不因查询抖动让运营保存不了(旧站同口径)
    console.error('检查文案标识唯一性失败', error && error.message);
    return false;
  }
}

async function editPage(ctx) {
  const rowId = intOr(ctx.query.id, 0);
  const isNew = rowId <= 0;
  let error = ctx.error || '';
  let errorField = '';
  let row;
  if (isNew) {
    row = { id: 0, text_key: '', title: '', content: '', group_name: TEXT_GROUPS[0], sort_order: 0, status: 1 };
  } else {
    row = await one(ctx.env, 'SELECT * FROM app_texts WHERE id = ?', rowId).catch(() => null);
    if (!row) return editView(ctx, { isNew: false, row: null, error: '找不到该文案', errorField: '' });
  }

  if (ctx.method === 'POST') {
    const form = ctx.form;
    const textKey = strOf(form.text_key);
    const title = strOf(form.title);
    // 正文不 strip: 首尾换行/空格可能是排版的一部分
    const content = textOf(form.content);
    const group = TEXT_GROUPS.includes(strOf(form.group_name)) ? strOf(form.group_name) : TEXT_GROUPS[0];
    const sortOrder = intOr(form.sort_order, 0);
    const status = form.status ? 1 : 0;
    row = { id: rowId, text_key: textKey, title, content, group_name: group, sort_order: sortOrder, status };

    if (!textKey) {
      error = '请填写必填项: 文案标识';
      errorField = 'text_key';
    } else if (!KEY_PATTERN.test(textKey)) {
      error = '文案标识格式不正确: 小写字母开头, 只允许小写字母/数字/下划线, 可用点分(如 login.prompt)';
      errorField = 'text_key';
    } else if (await keyExists(ctx.env, textKey, rowId)) {
      error = '该文案标识已存在, 请换一个';
      errorField = 'text_key';
    } else if (!title) {
      error = '请填写说明(后台列表里显示的那句话)';
      errorField = 'title';
    }

    if (!error) {
      try {
        if (isNew) {
          await run(ctx.env, 'INSERT INTO app_texts (text_key, title, content, group_name, sort_order, status) VALUES (?,?,?,?,?,?)',
            textKey, title, content, group, sortOrder, status);
        } else {
          await run(ctx.env, 'UPDATE app_texts SET text_key=?, title=?, content=?, group_name=?, sort_order=?, status=? WHERE id=?',
            textKey, title, content, group, sortOrder, status, rowId);
        }
        invalidateEntityCache('text');
        auditLog(`admin.app_text.${isNew ? 'create' : 'update'}`, { user: ctx.session.username, text_id: rowId, text_key: textKey });
        return redirect(buildListUrl(MANAGE_URL, { message: isNew ? '文案已添加' : '文案已更新' }));
      } catch (err) {
        console.error(`保存文案失败 id=${rowId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }
  return editView(ctx, { isNew, row, error, errorField });
}

function editView(ctx, { isNew, row, error, errorField }) {
  if (!row) {
    return adminLayout({
      title: '编辑文案', currentPage: 'app_text_manage', admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: error || '找不到该文案',
      content: '<div class="card"><div class="card-body">找不到该文案，可能已被删除。</div></div>'
    });
  }
  const main = textField({
    name: 'text_key', label: '文案标识', value: row.text_key, required: true, maxlength: 80, errorField,
    placeholder: '如 login.prompt',
    hint: '小写字母开头，只允许小写字母 / 数字 / 下划线，可用点分分组（如 login.prompt）；不可重复。'
  }) + textField({
    name: 'title', label: '说明', value: row.title, required: true, maxlength: 100, errorField,
    placeholder: '如 授权登录提示', hint: '只在后台列表里显示，用来说明这条文案用在哪里；小程序端不显示。'
  }) + textareaField({
    name: 'content', label: '文案正文', value: row.content, rows: 8, errorField,
    placeholder: '支持多行文本', hint: '留空是合法的 —— 比如「默认分享封面」就是要空着，让微信用页面截图自动兜底。'
  });
  const side = selectField({
    name: 'group_name', label: '分组', options: TEXT_GROUPS.map((name) => [name, name]),
    value: row.group_name, errorField, hint: '仅用于后台列表筛选，不影响小程序取用。'
  }) + numberField({ name: 'sort_order', label: '排序 (小在前)', value: row.sort_order, errorField })
    + switchField({ name: 'status', label: '启用', checked: intOr(row.status, 0) === 1 });
  const content = editShell({
    action: `/admin/app_text_edit${isNew ? '' : `?id=${row.id}`}`,
    main, side, backUrl: MANAGE_URL, backLabel: '返回列表',
    primaryLabel: isNew ? '添加' : '保存修改'
  });
  return adminLayout({
    title: '编辑文案', currentPage: 'app_text_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error, content
  });
}

async function deleteSubmit(ctx) {
  const rawId = ctx.form.id;
  if (!rawId || !/^\d+$/.test(String(rawId).replace('-', ''))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '参数错误' }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, 'SELECT text_key FROM app_texts WHERE id = ?', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该文案' }));
    await run(ctx.env, 'DELETE FROM app_texts WHERE id = ?', intOr(rawId, 0));
    auditLog('admin.app_text.delete', { user: ctx.session.username, text_id: intOr(rawId, 0), text_key: row.text_key || '' });
    invalidateEntityCache('text');
    message = '文案已删除（小程序将使用内置默认文案）';
  } catch (err) {
    console.error(`删除文案失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试' }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message }));
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['GET', 'POST'], path: '/admin/app_text_edit', handler: editPage },
  { methods: ['POST'], path: '/admin/app_text_delete', handler: deleteSubmit }
];
