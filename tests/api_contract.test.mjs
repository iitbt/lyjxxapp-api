// 契约级回归: 框架层状态码 / 关闭开关 / 请求体上限 / CORS 白名单 / 参数语义
//
// 为什么单独一个文件: 这些是"与旧站逐字一致"的硬门槛, 且都在 core/ 层(不在某个路由里),
// 改动容易漏测 —— 例如"未知路由到底是 HTTP 404 还是 200+code"就是本轮修正的行为。
import assert from 'node:assert/strict';
import test from 'node:test';

import { bodyTooLarge, tooLargeResponse } from '../app/core/middleware.js';
import { fail } from '../app/core/response.js';
import { intOf, str } from '../app/core/db.js';
import { PAGE_MAX, clampPage, pageSize } from '../app/api/schemas.js';
import { API_VERSION } from '../main.js';
import { get, getJson, makeEnv, request } from './stub.mjs';

test('未知路由: 真 HTTP 404 + {code:404,msg:"接口不存在"}', async () => {
  const { env } = makeEnv({ db: () => null });
  const res = await get('/no-such-endpoint', env);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, 404);
  assert.equal(body.msg, '接口不存在');
});

test('框架层错误用真 HTTP 状态码, 业务失败仍是 HTTP 200 + body.code', async () => {
  // fail() 默认 200(业务口径), 只有显式 httpStatus 才改状态码
  assert.equal(fail(400, '参数错误').status, 200);
  assert.equal(fail(404, '参数错误').status, 200);
  assert.equal(fail(404, '接口不存在', { httpStatus: 404 }).status, 404);
  assert.equal(fail(500, '服务器错误，请稍后重试', { httpStatus: 500 }).status, 500);
  assert.equal(fail(413, '请求体过大', { httpStatus: 413 }).status, 413);
});

test('/apitest 关闭: HTTP 404 + code 404 + 文案"接口已关闭"(旧站口径, 不是 403)', async () => {
  const { env } = makeEnv({ db: () => ({ c: 1 }), vars: { ENABLE_PUBLIC_PROBE: '0' } });
  const res = await get('/apitest', env);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, 404);
  assert.equal(body.msg, '接口已关闭');
});

test('请求体上限 5MB(旧站 BODY_LIMIT_BYTES): 超限 413, multipart 豁免', async () => {
  const headers = (values) => ({ get: (name) => values[String(name).toLowerCase()] });
  const tooBig = { method: 'POST', headers: headers({ 'content-length': String(6 * 1024 * 1024), 'content-type': 'application/json' }) };
  assert.equal(bodyTooLarge(tooBig), true);

  const multipart = { method: 'POST', headers: headers({ 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(60 * 1024 * 1024) }) };
  assert.equal(bodyTooLarge(multipart), false);

  const small = { method: 'POST', headers: headers({ 'content-length': '1024', 'content-type': 'application/json' }) };
  assert.equal(bodyTooLarge(small), false);

  const readOnly = { method: 'GET', headers: headers({ 'content-length': String(6 * 1024 * 1024) }) };
  assert.equal(bodyTooLarge(readOnly), false);

  const res = tooLargeResponse('rid');
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 413);
});

test('CORS: 默认放开(*); 配了 ALLOWED_ORIGINS 后只回白名单内的 Origin', async () => {
  const { env } = makeEnv({ db: () => ({ c: 1 }) });
  assert.equal((await get('/', env)).headers.get('access-control-allow-origin'), '*');

  const { env: strict } = makeEnv({ db: () => ({ c: 1 }), vars: { ALLOWED_ORIGINS: 'https://ok.example, https://app.example' } });
  const hit = await request('/', { env: strict, headers: { origin: 'https://ok.example' } });
  assert.equal(hit.headers.get('access-control-allow-origin'), 'https://ok.example');
  const miss = await request('/', { env: strict, headers: { origin: 'https://evil.example' } });
  assert.equal(miss.headers.get('access-control-allow-origin'), null);
  // 不带 Origin(小程序/服务端调用)不受影响: 不回该头, 请求照常
  const plain = await request('/', { env: strict });
  assert.equal(plain.headers.get('access-control-allow-origin'), null);
  assert.equal(plain.status, 200);
});

test('版本号只有一个来源: main.js 的 API_VERSION(env 里配了也不算数)', async () => {
  // 两个接口都必须报 main.js 里那个值 —— 证明版本号不来自 env、也不来自 wrangler.toml
  const { env } = makeEnv({ db: () => ({ c: 1 }), vars: { API_VERSION: '9.9.9' } });
  assert.equal((await getJson('/apitest', env)).data.version, API_VERSION);
  assert.equal((await getJson('/health/ready', env)).version, API_VERSION);
  assert.notEqual(API_VERSION, '9.9.9');   // 桩里给的值不该影响结果, 否则又成了"两处各写一份"
});

test('参数语义: intOf 对齐旧站 intval; clampPage/pageSize 夹取', () => {
  // 旧站 intval = int(float(v)), 认 "3.7"/"1e3", 非法回退, 溢出夹 ±2^31-1
  assert.equal(intOf('3.7'), 3);
  assert.equal(intOf('1e3'), 1000);
  assert.equal(intOf(' 12 '), 12);
  assert.equal(intOf('abc', 5), 5);
  assert.equal(intOf('', 7), 7);
  assert.equal(intOf(null, 7), 7);
  assert.equal(intOf(true, 9), 9);
  assert.equal(intOf(1e12), 2147483647);
  assert.equal(intOf(-1e12), -2147483647);

  assert.equal(clampPage('0'), 1);
  assert.equal(clampPage('99999'), PAGE_MAX);
  assert.equal(clampPage('abc', 3), 3);
  assert.equal(pageSize('0', 10, 50), 10);
  assert.equal(pageSize('999', 10, 50), 50);
  assert.equal(pageSize('5', 10, 50), 5);
  assert.equal(str(null, 'x'), 'x');
});
