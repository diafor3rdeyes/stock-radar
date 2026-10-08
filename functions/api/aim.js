// 매수 에임가 저장·조회·삭제 + 5분마다(cron) 현재가를 확인해 도달하면 슬랙으로 알림
//   GET    /api/aim            → 저장된 에임가 목록
//   POST   /api/aim            → { symbol, name, currency, aim, price } 저장(같은 종목은 덮어쓰기, 알림 상태 초기화)
//   DELETE /api/aim?symbol=XXX → 삭제
//   POST   /api/aim-test       → 슬랙 테스트 메시지
// 저장소: Workers KV (바인딩 이름 ALERTS)  · 알림: 슬랙 봇(SLACK_BOT_TOKEN)  · 로그인한 사용자별로 저장
import { json, yahooChart } from '../_lib/util.js';
import { getUser } from '../_lib/auth.js';
import { sendSlack, slackConfigured } from '../_lib/slack.js';

const KEY = (u, s) => `t:${u}:${s}`;
const SYM = /^[A-Z0-9.\-^=]{1,16}$/;

const fmt = (v, cur) => {
  if (!Number.isFinite(v)) return '–';
  if (cur === 'KRW') return Math.round(v).toLocaleString('ko-KR') + '원';
  if (cur === 'USD') return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 }) + (cur ? ' ' + cur : '');
};

async function listAll(env, prefix = 't:') {
  const out = [];
  let cursor;
  do {
    const page = await env.ALERTS.list({ prefix, cursor });
    for (const k of page.keys) {
      const v = await env.ALERTS.get(k.name, 'json');
      if (v && v.symbol) out.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (!env.ALERTS) {
    return json({ ok: false, error: '알림 저장소(KV)가 아직 연결되지 않았습니다. 설정 방법은 안내를 확인해 주세요.', noKv: true }, 503);
  }

  const user = await getUser(request, env);
  if (!user) return json({ ok: false, error: '로그인이 필요합니다.', needLogin: true }, 401);

  if (url.pathname === '/api/aim-test') {
    if (request.method !== 'POST') return json({ ok: false, error: 'POST만 가능합니다.' }, 405);
    const r = await sendSlack(env, '✅ [종목 분석 데스크] 슬랙 알림 테스트입니다. 이 메시지가 보이면 #매수에임알람 연결이 정상입니다. (모바일 푸시가 안 오면 채널 알림을 "모든 새 메시지"로 바꿔 주세요.)');
    return json(r, r.ok ? 200 : 502);
  }

  if (request.method === 'GET') return json({ ok: true, items: await listAll(env, `t:${user}:`), slack: slackConfigured(env) });

  if (request.method === 'DELETE') {
    const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
    if (!SYM.test(symbol)) return json({ ok: false, error: '종목 코드가 올바르지 않습니다.' }, 400);
    await env.ALERTS.delete(KEY(user, symbol));
    return json({ ok: true });
  }

  if (request.method === 'POST') {
    let b;
    try {
      b = await request.json();
    } catch {
      return json({ ok: false, error: '잘못된 요청입니다.' }, 400);
    }
    const symbol = String(b.symbol || '').trim().toUpperCase();
    const aim = Number(b.aim);
    const base = Number(b.price);
    if (!SYM.test(symbol)) return json({ ok: false, error: '종목 코드가 올바르지 않습니다.' }, 400);
    if (!(aim > 0) || !Number.isFinite(aim)) return json({ ok: false, error: '에임가를 0보다 큰 숫자로 입력해 주세요.' }, 400);
    if (!(base > 0)) return json({ ok: false, error: '현재가를 확인하지 못했습니다.' }, 400);
    const item = {
      user,
      symbol,
      name: String(b.name || symbol).slice(0, 80),
      currency: String(b.currency || '').slice(0, 8),
      aim,
      dir: aim <= base ? 'down' : 'up', // 현재가보다 낮게 잡으면 "내려오면" 알림, 높게 잡으면 "올라오면" 알림
      createdAt: Date.now(),
      alertedAt: null,
    };
    await env.ALERTS.put(KEY(user, symbol), JSON.stringify(item));
    return json({ ok: true, item });
  }
  return json({ ok: false, error: '지원하지 않는 요청입니다.' }, 405);
}

// cron(5분마다): 저장된 에임가의 현재가를 확인하고, 도달했고 아직 알리지 않았다면 슬랙으로 보낸다.
export async function checkAll(env) {
  if (!env.ALERTS) return;
  const items = (await listAll(env)).filter((x) => !x.alertedAt);
  if (!items.length) return;
  const prices = {};
  await Promise.allSettled(
    [...new Set(items.map((x) => x.symbol))].map(async (s) => {
      const { meta, rows } = await yahooChart(s, '5d', '1d');
      const p = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : rows[rows.length - 1].c;
      prices[s] = p;
    })
  );
  for (const it of items) {
    const p = prices[it.symbol];
    if (!Number.isFinite(p)) continue;
    const hit = it.dir === 'down' ? p <= it.aim : p >= it.aim;
    if (!hit) continue;
    const code = it.symbol.replace(/\.(KS|KQ)$/, '');
    const text =
      `🎯 *매수 에임가 도달!* ${it.name} (${code})\n` +
      `현재가 ${fmt(p, it.currency)} ${it.dir === 'down' ? '≤' : '≥'} 에임가 ${fmt(it.aim, it.currency)}\n` +
      `차트: https://www.tradingview.com/chart/?symbol=${encodeURIComponent(/^\d{6}\.(KS|KQ)$/.test(it.symbol) ? 'KRX:' + code : it.symbol.replace(/-/g, '.'))}`;
    const r = await sendSlack(env, text);
    if (r.ok) await env.ALERTS.put(KEY(it.user || '_', it.symbol), JSON.stringify({ ...it, alertedAt: Date.now(), alertedPrice: p }));
  }
}
