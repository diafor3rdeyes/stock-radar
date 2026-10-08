// GET /api/stock?symbol=005930  또는  ?symbol=NVDA — 시세·차트·기술적 지표
import { json, symbolCandidates, yahooChart, computeTech } from '../_lib/util.js';

export async function onRequestGet({ request }) {
  const input = new URL(request.url).searchParams.get('symbol') || '';
  const candidates = symbolCandidates(input);
  if (!candidates.length) return json({ error: '종목 코드를 입력해 주세요.' }, 400);

  let found = null;
  let lastErr = null;
  for (const sym of candidates) {
    try {
      const d = await yahooChart(sym, '1y', '1d');
      if (d.rows.length >= 30) {
        found = { symbol: sym, ...d };
        break;
      }
      lastErr = new Error('시세 데이터가 부족합니다');
    } catch (e) {
      lastErr = e;
    }
  }
  if (!found) {
    return json({ error: `'${input}' 종목을 찾지 못했습니다. (${lastErr ? lastErr.message : '조회 실패'})` }, 404);
  }

  const { meta, rows, symbol } = found;
  const tech = computeTech(rows);
  const n = rows.length;
  const prev = n > 1 ? rows[n - 2].c : meta.chartPreviousClose;
  const chartRows = rows.slice(-130);

  return json(
    {
      symbol,
      inputSymbol: input.trim().toUpperCase(),
      name: meta.longName || meta.shortName || symbol,
      currency: meta.currency,
      exchange: meta.fullExchangeName || meta.exchangeName,
      price: rows[n - 1].c,
      prevClose: prev,
      change: rows[n - 1].c - prev,
      changePct: (rows[n - 1].c / prev - 1) * 100,
      asOf: rows[n - 1].t,
      rows: chartRows,
      tech,
    },
    200,
    { 'cache-control': 'public, max-age=60, s-maxage=300' }
  );
}
