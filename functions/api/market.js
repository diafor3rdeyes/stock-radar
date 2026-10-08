// GET /api/market — 공포탐욕지수 + SPY / 나스닥100 / 다우 / 코스피 (현재가, 등락, RSI14)
import { json, UA, yahooChart, rsi } from '../_lib/util.js';

const INDEXES = [
  { id: 'SPY', symbol: 'SPY', name: 'SPY', sub: 'S&P 500 ETF' },
  { id: 'NDX', symbol: '^NDX', name: '나스닥 100', sub: 'NASDAQ-100' },
  { id: 'DJI', symbol: '^DJI', name: '다우존스', sub: 'DJIA' },
  { id: 'KOSPI', symbol: '^KS11', name: '코스피', sub: 'KOSPI' },
];

async function fearGreed() {
  const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://edition.cnn.com',
      Referer: 'https://edition.cnn.com/',
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`CNN ${r.status}`);
  const j = await r.json();
  const f = j.fear_and_greed;
  if (!f) throw new Error('CNN 응답 형식 오류');
  const hist = (j.fear_and_greed_historical && j.fear_and_greed_historical.data) || [];
  return {
    score: Math.round(f.score * 10) / 10,
    rating: f.rating,
    timestamp: f.timestamp,
    previousClose: f.previous_close,
    previous1Week: f.previous_1_week,
    previous1Month: f.previous_1_month,
    previous1Year: f.previous_1_year,
    history: hist.slice(-90).map((p) => ({ t: p.x, v: Math.round(p.y * 10) / 10 })),
    source: 'https://edition.cnn.com/markets/fear-and-greed',
  };
}

async function indexQuote(item) {
  const { meta, rows } = await yahooChart(item.symbol, '6mo', '1d');
  const closes = rows.map((r) => r.c);
  const last = closes[closes.length - 1];
  const prev = closes.length > 1 ? closes[closes.length - 2] : meta.chartPreviousClose;
  return {
    ...item,
    price: last,
    change: last - prev,
    changePct: (last / prev - 1) * 100,
    rsi14: rsi(closes, 14),
    asOf: rows[rows.length - 1].t,
    currency: meta.currency,
    spark: closes.slice(-60),
  };
}

export async function onRequestGet() {
  const [fg, ...idx] = await Promise.allSettled([fearGreed(), ...INDEXES.map(indexQuote)]);
  return json(
    {
      fetchedAt: Date.now(),
      fearGreed: fg.status === 'fulfilled' ? fg.value : { error: String(fg.reason && fg.reason.message) },
      indexes: idx.map((r, i) =>
        r.status === 'fulfilled' ? r.value : { ...INDEXES[i], error: String(r.reason && r.reason.message) }
      ),
    },
    200,
    { 'cache-control': 'public, max-age=60, s-maxage=300' }
  );
}
