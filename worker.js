// Cloudflare Workers 진입점: /api/* 는 아래 함수로, 나머지는 public 폴더의 화면 파일로 보낸다.
import * as market from './functions/api/market.js';
import * as stock from './functions/api/stock.js';
import * as analyze from './functions/api/analyze.js';
import * as price from './functions/api/price.js';
import * as aim from './functions/api/aim.js';
import * as account from './functions/api/account.js';

const notFound = () =>
  new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const context = { request, env, waitUntil: (p) => ctx.waitUntil(p) };

    // 설정 점검용: 비밀값 자체는 내보내지 않고 존재 여부만 알려준다
    if (url.pathname === '/api/health') {
      const meta = env.CF_VERSION_METADATA || {};
      return new Response(
        JSON.stringify({
          ok: true,
          hasApiKey: !!(env.ANTHROPIC_API_KEY && String(env.ANTHROPIC_API_KEY).trim()),
          hasAccessCode: !!(env.ACCESS_CODE && String(env.ACCESS_CODE).trim()),
          hasSlack: !!((env.SLACK_BOT_TOKEN && String(env.SLACK_BOT_TOKEN).trim()) || (env.SLACK_WEBHOOK_URL && String(env.SLACK_WEBHOOK_URL).trim())),
          slackMode: env.SLACK_BOT_TOKEN && String(env.SLACK_BOT_TOKEN).trim() ? 'bot' : env.SLACK_WEBHOOK_URL ? 'webhook' : null,
          hasKv: !!env.ALERTS,
          hasGoogle: !!(env.GOOGLE_CLIENT_ID && String(env.GOOGLE_CLIENT_ID).trim()),
          envNames: Object.keys(env).filter((k) => k !== 'ASSETS' && k !== 'CF_VERSION_METADATA'),
          version: meta.id || null,
          versionTime: meta.timestamp || null,
        }),
        { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
      );
    }

    try {
      if (url.pathname === '/api/market' && request.method === 'GET') return await market.onRequestGet(context);
      if (url.pathname === '/api/stock' && request.method === 'GET') return await stock.onRequestGet(context);
      if (url.pathname === '/api/price' && request.method === 'GET') return await price.onRequestGet(context);
      if (url.pathname === '/api/auth' || url.pathname === '/api/data') return await account.onRequest(context);
      if (url.pathname === '/api/aim' || url.pathname === '/api/aim-test') return await aim.onRequest(context);
      if (url.pathname === '/api/analyze' && request.method === 'POST') return await analyze.onRequestPost(context);
    } catch (e) {
      return new Response(JSON.stringify({ error: String((e && e.message) || e) }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    if (url.pathname.startsWith('/api/')) return notFound();
    return env.ASSETS.fetch(request);
  },

  // 5분마다 실행: 매수 에임가 도달 여부를 확인해 슬랙으로 알린다
  async scheduled(event, env, ctx) {
    ctx.waitUntil(aim.checkAll(env).catch(() => {}));
  },
};
