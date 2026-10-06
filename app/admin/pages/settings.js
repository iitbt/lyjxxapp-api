// 管理员设置: 改自己的资料(昵称/邮箱) / 改自己的口令
// 两处与旧站的有意差异(都在旧站注释里被标为缺陷):
//   ① 本页**没有头像功能** —— 旧站也没做过(字段查出来但无编辑入口), 保持一致;
//   ② 口令下限统一按后端真值 10 位 —— 旧站模板写 6、后端判 10, 前端放行后端报错。
import { escapeHtml } from '../../core/html.js';
import { one, run } from '../../core/db.js';
import { adminLayout } from '../lib/layout.js';
import { backButton } from '../lib/partials.js';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../lib/password.js';
import { clearSessionCookie } from '../lib/session.js';
import { auditLog, fmtDatetime, strOf } from '../lib/utils.js';

const PAGE_URL = '/admin/settings';

function redirect(location, cookie) {
  const headers = { location };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

function field(name, label, options = {}) {
  const invalid = options.errorField === name;
  return `<div class="mb-3">
  <label class="form-label" for="${escapeHtml(name)}Input">${escapeHtml(label)}${options.required ? ' <span class="text-danger">*</span>' : ''}</label>
  <input type="${options.type || 'text'}" class="form-control${invalid ? ' is-invalid' : ''}"
         name="${escapeHtml(name)}" id="${escapeHtml(name)}Input" value="${escapeHtml(options.value || '')}"`
    + `${options.autocomplete ? ` autocomplete="${escapeHtml(options.autocomplete)}"` : ''}`
    + `${options.required ? ' required' : ''}`
    + `${options.minlength ? ` minlength="${Number(options.minlength)}"` : ''}`
    + `${options.readonly ? ' readonly aria-readonly="true"' : ''}${invalid ? ' aria-invalid="true"' : ''}>`
    + `${options.hint ? `<div class="form-text">${escapeHtml(options.hint)}</div>` : ''}
</div>`;
}

function renderPage(ctx, options = {}) {
  const row = options.admin || {};
  const profileForm = `<div class="card mb-3"><div class="card-body">
  <div class="form-label">账号资料</div>
  <form method="post" action="${PAGE_URL}">
    <input type="hidden" name="update_profile" value="1">
    ${field('username', '用户名', { value: strOf(row.username), readonly: true, hint: '用户名不可修改。' })}
    ${field('nickname', '昵称', { value: strOf(row.nickname), errorField: options.profileErrorField })}
    ${field('email', '邮箱', { type: 'email', value: strOf(row.email), errorField: options.profileErrorField })}
    <div class="text-muted small mb-2">最近登录：${escapeHtml(fmtDatetime(row.last_login_time, '') || '从未登录')}</div>
    <div class="text-muted small mb-3">注册时间：${escapeHtml(fmtDatetime(row.create_time, '') || '未知')}</div>
    <button class="btn btn-outline-primary" type="submit"><i class="bi bi-save" aria-hidden="true"></i> 保存资料</button>
  </form>
</div></div>`;
  const passwordForm = `<div class="card mb-3"><div class="card-body">
  <div class="form-label">修改密码</div>
  <form method="post" action="${PAGE_URL}">
    <input type="hidden" name="change_password" value="1">
    ${field('current_password', '当前密码', {
    type: 'password', required: true, autocomplete: 'current-password', errorField: options.pwdErrorField
  })}
    ${field('new_password', `新密码（至少 ${MIN_PASSWORD_LENGTH} 位）`, {
    type: 'password', required: true, minlength: MIN_PASSWORD_LENGTH, autocomplete: 'new-password', errorField: options.pwdErrorField
  })}
    ${field('confirm_password', '确认新密码', {
    type: 'password', required: true, minlength: MIN_PASSWORD_LENGTH, autocomplete: 'new-password', errorField: options.pwdErrorField
  })}
    <button class="btn btn-primary" type="submit"><i class="bi bi-key" aria-hidden="true"></i> 修改密码</button>
    <div class="form-text mt-2">提示：修改密码后立即生效，所有已登录会话都会失效，需要用新密码重新登录。</div>
  </form>
</div></div>`;
  const content = profileForm + passwordForm
    + `<div class="card"><div class="card-body">${backButton('/admin/dashboard', '返回控制面板')}</div></div>`;
  return adminLayout({
    title: '管理员设置', currentPage: 'settings', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: options.message || '', error: options.error || '', content
  });
}

async function settingsPage(ctx) {
  const load = async () => one(ctx.env, 'SELECT * FROM admin_users WHERE id = ?', Number(ctx.session.id) || 0).catch(() => null);
  let row = await load();
  if (!row) {
    // 账号在登录后被人删掉了: 明确说清而不是渲染空表单
    return renderPage(ctx, { admin: {}, error: '找不到当前登录的管理员账户，可能已被删除，请重新登录' });
  }

  if (ctx.method === 'POST') {
    const form = ctx.form;
    // 动作判定: 隐藏域优先, 字段特征兜底(部分 WebView 不提交按钮 name; 旧站踩过"点了没反应")
    const isPasswordChange = Boolean(form.change_password)
      || Boolean(form.current_password || form.new_password || form.confirm_password);
    const isProfile = Boolean(form.update_profile) || form.nickname !== undefined || form.email !== undefined;

    if (isPasswordChange) {
      const current = strOf(form.current_password);
      const next = strOf(form.new_password);
      const confirm = strOf(form.confirm_password);
      let error = '';
      if (!current || !next || !confirm) error = '所有密码字段都不能为空';
      else if (next !== confirm) error = '新密码和确认密码不匹配';
      else if (next.length < MIN_PASSWORD_LENGTH) error = `新密码长度不能少于 ${MIN_PASSWORD_LENGTH} 个字符`;

      if (!error) {
        const ok = await verifyPassword(current, row.password);
        if (!ok) {
          error = '当前密码不正确';
          // 失败的改密尝试同样留痕(安全审计关心的是"谁在试")
          auditLog('admin.password.change.rejected', { user: ctx.session.username, admin_id: row.id });
        }
      }
      if (!error) {
        try {
          // 只生成**一次**哈希: 重算会因加盐不同与库内值不一致(旧站曾被误判成"口令已变更")
          await run(ctx.env, 'UPDATE admin_users SET password = ? WHERE id = ?', await hashPassword(next), row.id);
          auditLog('admin.password.change', { user: ctx.session.username, admin_id: row.id });
          // 改密后强制重新登录: 清会话 Cookie, 顺手让其它会话里的旧口令彻底失效
          return redirect('/admin/login?message=' + encodeURIComponent('密码已更新，请使用新密码重新登录'),
            clearSessionCookie());
        } catch (err) {
          console.error('更新密码失败', err && err.message);
          error = '更新密码失败，请稍后重试';
        }
      }
      row = await load() || row;
      return renderPage(ctx, { admin: row, error, pwdErrorField: error ? 'new_password' : '' });
    }

    if (isProfile) {
      const nickname = strOf(form.nickname);
      const email = strOf(form.email);
      try {
        const result = await run(ctx.env, 'UPDATE admin_users SET nickname = ?, email = ? WHERE id = ?', nickname, email, row.id);
        const affected = Number((result && result.meta && result.meta.changes) || 0);
        if (!affected) {
          return renderPage(ctx, { admin: row, error: '找不到当前登录的管理员账户，无法更新资料，请重新登录' });
        }
        auditLog('admin.profile.update', { user: ctx.session.username, admin_id: row.id });
        const fresh = await load() || row;
        // 与旧站一致: 资料保存成功**就地渲染**(不 302), 否则刚填的昵称看起来像没生效
        return renderPage(ctx, { admin: fresh, message: '个人资料更新成功' });
      } catch (err) {
        console.error('更新资料失败', err && err.message);
        return renderPage(ctx, { admin: row, error: '更新资料失败，请稍后重试' });
      }
    }

    // 静默重渲染会让人以为"点了没反应", 所以明确报错并留痕
    console.warn('设置页收到无法识别的提交', Object.keys(form).sort().join(','));
    auditLog('admin.settings.unknown_submit', { user: ctx.session.username, form_fields: Object.keys(form).sort().join(',') });
    return renderPage(ctx, { admin: row, error: '未识别到提交类型（可能是页面缓存版本过旧），请刷新页面后重试' });
  }

  return renderPage(ctx, { admin: row, message: ctx.message, error: ctx.error });
}

export const routes = [
  { methods: ['GET', 'POST'], path: PAGE_URL, handler: settingsPage }
];
