// 管理员账号读写(表 admin_users, 与旧库同构): 只覆盖后台登录用得到的几条
import { one, run } from '../../core/db.js';
import { beijingNow } from '../../core/timeutil.js';

export async function adminCount(env) {
  const row = await one(env, 'SELECT COUNT(*) AS c FROM admin_users');
  return Number((row && row.c) || 0);
}

export async function findAdmin(env, username) {
  return await one(env, 'SELECT * FROM admin_users WHERE username=? LIMIT 1', username);
}

export async function touchLogin(env, id) {
  return await run(env, 'UPDATE admin_users SET last_login_time=? WHERE id=?', beijingNow(), id);
}

export async function createAdmin(env, fields) {
  return await run(
    env,
    'INSERT INTO admin_users (username,nickname,password,login_type,role,create_time) VALUES (?,?,?,?,?,?)',
    fields.username, fields.nickname || fields.username, fields.password, 'account', fields.role || 'super', beijingNow()
  );
}

// 与旧站 is_super_admin() 同口径: role 为 super/admin 才算超管
export function isSuperRole(role) {
  const value = String(role || '').toLowerCase();
  return value === 'super' || value === 'admin';
}
