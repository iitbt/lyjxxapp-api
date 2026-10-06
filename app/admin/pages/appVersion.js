// 版本更新配置: 全站只有一行(app_version_config, id=1), 所以没有列表页
// 逐条对齐旧站 fastapi/app/admin/config_center.py 的版本那部分
import { one, run } from '../../core/db.js';
import { adminLayout } from '../lib/layout.js';
import { editShell, textField, textareaField } from '../lib/partials.js';
import { auditLog, buildListUrl, invalidateEntityCache, strOf } from '../lib/utils.js';

const PAGE_URL = '/admin/app_version_edit';
// 默认值: 表里还没有这一行时用它渲染(不到保存那一刻不写库)
const DEFAULT_INFO = {
  latest_version: '', min_version: '',
  update_tip: '发现新版本，更新后体验更好', update_content: ''
};
// 版本号: 1~3 段纯数字, 留空允许(表示不做该项限制)
const VERSION_PATTERN = /^\d{1,4}(\.\d{1,4}){0,2}$/;

// 比较用: 按 "." 分段补 0 到 3 段
function versionTuple(value) {
  const parts = strOf(value).split('.').map((item) => parseInt(item, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

function isNewer(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

// 读这一行: 没有就返回默认值 + persisted=false(靠它区分 INSERT 还是 UPDATE)
async function loadRow(env) {
  const row = await one(env, 'SELECT * FROM app_version_config WHERE id = 1').catch(() => null);
  if (!row) return Object.assign({ id: 0 }, DEFAULT_INFO, { persisted: false });
  return Object.assign({}, row, { persisted: true });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

async function editPage(ctx) {
  let row = await loadRow(ctx.env);
  let error = ctx.error || '';
  let errorField = '';

  if (ctx.method === 'POST') {
    const latest = strOf(ctx.form.latest_version);
    const minVersion = strOf(ctx.form.min_version);
    const tip = strOf(ctx.form.update_tip);
    const content = String(ctx.form.update_content === undefined ? '' : ctx.form.update_content);
    row = {
      id: 1, persisted: row.persisted, latest_version: latest, min_version: minVersion,
      update_tip: tip, update_content: content
    };

    if (latest && !VERSION_PATTERN.test(latest)) {
      error = '最新版本格式不正确: 应为数字版本号(如 3.4 或 3.4.0)';
      errorField = 'latest_version';
    } else if (minVersion && !VERSION_PATTERN.test(minVersion)) {
      error = '最低可用版本格式不正确: 应为数字版本号(如 3.0 或 3.0.0)';
      errorField = 'min_version';
    } else if (latest && minVersion && isNewer(minVersion, latest)) {
      error = '最低可用版本不能高于最新版本(那样所有用户都会被强制更新)';
      errorField = 'min_version';
    }

    if (!error) {
      try {
        if (row.persisted) {
          await run(ctx.env,
            'UPDATE app_version_config SET latest_version=?, min_version=?, update_tip=?, update_content=? WHERE id = 1',
            latest, minVersion, tip, content);
        } else {
          await run(ctx.env,
            'INSERT INTO app_version_config (id, latest_version, min_version, update_tip, update_content) VALUES (1,?,?,?,?)',
            latest, minVersion, tip, content);
        }
        invalidateEntityCache('config');
        auditLog('admin.app_version.update', { user: ctx.session.username, latest_version: latest, min_version: minVersion });
        return redirect(buildListUrl(PAGE_URL, { message: '版本更新配置已保存' }));
      } catch (err) {
        console.error('保存版本配置失败', err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }

  const main = textField({
    name: 'latest_version', label: '最新版本号', value: row.latest_version, maxlength: 20, errorField,
    placeholder: '留空表示不提示更新', hint: '小程序拿它和本地版本比对，高于本地就提示更新。'
  }) + textField({
    name: 'min_version', label: '最低可用版本号', value: row.min_version, maxlength: 20, errorField,
    placeholder: '留空表示不强制更新', hint: '低于它的版本会被要求必须更新。'
  }) + textField({
    name: 'update_tip', label: '更新提示语', value: row.update_tip, errorField,
    placeholder: '如 发现新版本，更新后体验更好'
  }) + textareaField({
    name: 'update_content', label: '更新说明', value: row.update_content, rows: 6, errorField,
    placeholder: '一行一条，展示在更新弹窗里'
  });
  const tips = `<div class="card"><div class="card-body small text-muted">
    · 版本号格式：数字版本号，1~3 段均可（3.4 / 3.4.0）；留空表示不做该项限制。<br>
    · 最低可用版本不能高于最新版本 —— 否则所有用户都会被强制更新。<br>
    · 改动经 <code>GET /config/get_app_config</code> 的 <code>data.version</code> 下发；小程序有本地缓存，下次启动会静默刷新，因此通常再下一次启动才会看到新提示。
  </div></div>`;
  const content = editShell({
    action: PAGE_URL, main, side: '', backUrl: '/admin/dashboard', backLabel: '返回控制面板',
    sideTitle: '保存', primaryLabel: '保存配置'
  }) + tips;
  return adminLayout({
    title: '版本更新配置', currentPage: 'app_version_edit', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, message: ctx.message, error, content
  });
}

export const routes = [
  { methods: ['GET', 'POST'], path: PAGE_URL, handler: editPage }
];
