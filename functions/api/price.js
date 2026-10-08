// GET /api/price?symbol=005930.KS&date=2026-03-12 — 매수일 종가 조회
// 매수일이 휴장일이면 그다음 거래일 종가, 아직 거래일이 없는 날짜(미래·오늘 장 시작 전)면 최근 종가를 돌려준다.
import { json, yahooChart } from '../_lib/util.js';

const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const symbol = (u.searchParams.get('symbol') || '').trim().toUpperCase();
  const date = u.searchParams.get('date') || '';
  if (!/^[A-Z0-9.\-^=]{1,16}$/.test(symbol)) return json({ error: '종목 코드가 올바르지 않습니다.' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: '날짜가 올바르지 않습니다.' }, 400);
  const t = Math.floor(Date.parse(date + 'T00:00:00Z') / 1000);
  if (!Number.isFinite(t)) return json({ error: '날짜가 올바르지 않습니다.' }, 400);

  try {
    const { meta, rows } = await yahooChart(symbol, null, '1d', { p1: t - 86400 * 3, p2: t + 86400 * 14 });
    let hit = rows.find((r) => iso(r.t) >= date);
    let future = false;
    if (!hit) {
      hit = rows[rows.length - 1];
      future = true;
    } else if (Date.parse(iso(hit.t) + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z') > 7 * 86400000) {
      return json({ error: '그 날짜 근처에는 거래 기록이 없습니다. (상장 전이거나 거래정지 기간일 수 있어요)' }, 404);
    }
    if (!hit) return json({ error: '해당 날짜 전후의 시세가 없습니다.' }, 404);
    return json(
      { symbol, requested: date, date: iso(hit.t), close: hit.c, future, currency: meta.currency },
      200,
      { 'cache-control': 'public, max-age=3600, s-maxage=86400' }
    );
  } catch (e) {
    return json({ error: `시세 조회 실패 (${(e && e.message) || e})` }, 502);
  }
}
