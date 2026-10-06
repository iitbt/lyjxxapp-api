// 静态内容页: /pages/download /pages/terms /pages/privacy
// 协议与隐私正文从 D1 的 app_texts 读取(键与旧站一致), 取不到才用 catalog 的内置兜底文案
import { html } from '../core/response.js';
import { contentPage, pageShell } from '../core/html.js';
import { one } from '../core/db.js';

const FALLBACK = {
  'agreement.content': '一、账号：使用微信登录即完成注册，你可以在「我的 → 注销账号」随时注销账号。\n二、使用：本小程序仅提供内容浏览、点赞、收藏等功能，不提供用户发布内容功能。\n三、隐私：我们仅收集展示身份所需的昵称与头像、以及你的浏览/点赞/收藏记录，不向第三方提供。\n四、免责：本小程序展示的笔记内容仅供参考；户外、摩旅等活动存在风险，请量力而行并做好安全防护。',
  'privacy.fallback': '本小程序仅收集您的微信昵称与头像用于展示身份，收集浏览/点赞/收藏记录用于向您展示个人记录。不会向第三方提供您的个人信息。',
  'download.tip': '在微信中搜索小程序「狼牙极限运动笔记」即可打开；本页仅提供网页版说明。'
};

async function textOf(env, key) {
  try {
    const row = await one(env, 'SELECT content FROM app_texts WHERE text_key=? AND status=1', key);
    const content = row && row.content !== undefined && row.content !== null ? String(row.content) : '';
    return content || FALLBACK[key] || '';
  } catch (error) {
    return FALLBACK[key] || '';
  }
}

const cache = { 'cache-control': 'public, max-age=300' };

export function registerPageRoutes(router) {
  router.get('/pages/terms', async (request, env) => {
    const body = await textOf(env, 'agreement.content');
    return html(contentPage('用户协议', body, '狼牙极限运动笔记'), 200, cache);
  });

  router.get('/pages/agreement', async (request, env) => {
    const body = await textOf(env, 'agreement.content');
    return html(contentPage('用户协议', body, '狼牙极限运动笔记'), 200, cache);
  });

  router.get('/pages/privacy', async (request, env) => {
    const body = await textOf(env, 'privacy.fallback');
    return html(contentPage('隐私政策', body, '狼牙极限运动笔记'), 200, cache);
  });

  router.get('/pages/download', async (request, env) => {
    const tip = await textOf(env, 'download.tip');
    const body = `<header>下载与使用</header>
<main>${tip}</main>
<a class="btn" href="/">查看服务状态</a>
<a class="btn" href="/pages/terms">《用户协议》</a>
<a class="btn" href="/pages/privacy">《隐私政策》</a>`;
    return html(pageShell('下载与使用', body, '狼牙极限运动笔记'), 200, cache);
  });
}
