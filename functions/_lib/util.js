// 공용 헬퍼: 응답, 접근 코드 확인, Yahoo 차트 조회, 기술적 지표 계산

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

// ACCESS_CODE 환경변수가 설정돼 있으면 AI 분석 호출에 같은 코드를 요구한다.
export function checkAccess(request, env) {
  const need = (env.ACCESS_CODE || '').trim();
  if (!need) return true;
  const got = (request.headers.get('x-access-code') || '').trim();
  if (got.length !== need.length) return false;
  let diff = 0;
  for (let i = 0; i < need.length; i++) diff |= need.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// 입력 종목코드 → Yahoo Finance 심볼 후보 목록
export function symbolCandidates(input) {
  let s = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return [];
  if (/^\d{6}$/.test(s)) return [`${s}.KS`, `${s}.KQ`]; // 코스피 → 코스닥 순서로 시도
  if (/^[A-Z]{1,5}\.[A-Z]$/.test(s)) s = s.replace('.', '-'); // BRK.B → BRK-B
  return [s];
}

export async function yahooChart(symbol, range = '1y', interval = '1d', period = null) {
  const span = period ? `period1=${period.p1}&period2=${period.p2}` : `range=${range}`;
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?${span}&interval=${interval}&includePrePost=false`;
  let lastErr;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`https://${host}${path}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (!r.ok) throw new Error(`Yahoo ${r.status}`);
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) throw new Error((j.chart && j.chart.error && j.chart.error.description) || 'no data');
      const q = res.indicators.quote[0];
      const ts = res.timestamp || [];
      const rows = [];
      for (let i = 0; i < ts.length; i++) {
        if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) continue;
        rows.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
      }
      return { meta: res.meta, rows };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo 조회 실패');
}

// ---------- 지표 ----------
export function sma(arr, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

export function ema(arr, n) {
  const k = 2 / (n + 1);
  const out = [];
  let prev = null;
  for (const v of arr) {
    if (v == null) {
      out.push(null);
      continue;
    }
    prev = prev == null ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// Wilder RSI
export function rsi(closes, n = 14) {
  if (closes.length <= n) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let ag = gain / n;
  let al = loss / n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + (d > 0 ? d : 0)) / n;
    al = (al * (n - 1) + (d < 0 ? -d : 0)) / n;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function stdev(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

function pivots(rows, win = 5, lookback = 160) {
  const r = rows.slice(-lookback);
  const hi = [];
  const lo = [];
  for (let i = win; i < r.length - win; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - win; j <= i + win; j++) {
      if (r[j].h > r[i].h) isH = false;
      if (r[j].l < r[i].l) isL = false;
    }
    if (isH) hi.push(r[i].h);
    if (isL) lo.push(r[i].l);
  }
  return { hi, lo };
}

function cluster(levels, tol = 0.015) {
  const s = [...levels].sort((a, b) => a - b);
  const out = [];
  for (const v of s) {
    const last = out[out.length - 1];
    if (last && Math.abs(v - last.avg) / last.avg <= tol) {
      last.sum += v;
      last.n++;
      last.avg = last.sum / last.n;
    } else out.push({ sum: v, n: 1, avg: v });
  }
  return out.map((o) => ({ price: o.avg, touches: o.n }));
}

export function computeTech(rows) {
  const closes = rows.map((r) => r.c);
  const n = closes.length;
  const last = closes[n - 1];
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);

  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
  const sig = ema(macdLine, 9);
  const macd = macdLine[n - 1];
  const macdSignal = sig[n - 1];
  const macdHist = macd != null && macdSignal != null ? macd - macdSignal : null;

  const win20 = closes.slice(-20);
  const bbMid = win20.reduce((s, v) => s + v, 0) / win20.length;
  const bbSd = stdev(win20);

  let atr = null;
  if (n > 15) {
    const trs = [];
    for (let i = 1; i < n; i++) {
      const r = rows[i];
      trs.push(Math.max(r.h - r.l, Math.abs(r.h - rows[i - 1].c), Math.abs(r.l - rows[i - 1].c)));
    }
    atr = trs.slice(-14).reduce((s, v) => s + v, 0) / 14;
  }

  const logRet = [];
  for (let i = Math.max(1, n - 60); i < n; i++) logRet.push(Math.log(closes[i] / closes[i - 1]));
  const dailyVol = stdev(logRet);

  const yr = rows.slice(-252);
  const high52 = Math.max(...yr.map((r) => r.h));
  const low52 = Math.min(...yr.map((r) => r.l));
  const vol20 = rows.slice(-20).reduce((s, r) => s + r.v, 0) / Math.min(20, n);
  const vol5 = rows.slice(-5).reduce((s, r) => s + r.v, 0) / Math.min(5, n);

  const pct = (k) => (n > k ? (last / closes[n - 1 - k] - 1) * 100 : null);

  // 지지·저항: 최근 스윙 고점/저점 군집
  const pv = pivots(rows);
  const resAll = cluster(pv.hi).filter((c) => c.price > last * 1.002);
  const supAll = cluster(pv.lo).filter((c) => c.price < last * 0.998);
  const resistances = resAll.sort((a, b) => a.price - b.price).slice(0, 3);
  if (high52 > last * 1.002 && !resistances.some((c) => Math.abs(c.price - high52) / high52 < 0.015)) {
    resistances.push({ price: high52, touches: 1, note: '52주 고점' });
    resistances.sort((a, b) => a.price - b.price);
  }
  const supports = supAll.sort((a, b) => b.price - a.price).slice(0, 3);

  // 2주(영업일 10일) 통계적 변동 범위 (추세 가정 없음, 로그수익률 정규분포)
  const cone = [];
  for (let k = 0; k <= 10; k++) {
    const s = dailyVol * Math.sqrt(k);
    cone.push({
      k,
      mid: last,
      lo1: last * Math.exp(-s),
      hi1: last * Math.exp(s),
      lo2: last * Math.exp(-2 * s),
      hi2: last * Math.exp(2 * s),
    });
  }

  // 단순 점수형 추세 판단
  let score = 0;
  const reasons = [];
  const add = (cond, plus, minus) => {
    if (cond == null) return;
    score += cond ? 1 : -1;
    reasons.push(cond ? plus : minus);
  };
  add(s20[n - 1] != null ? last > s20[n - 1] : null, '20일선 위', '20일선 아래');
  add(s50[n - 1] != null ? last > s50[n - 1] : null, '50일선 위', '50일선 아래');
  add(s200[n - 1] != null ? last > s200[n - 1] : null, '200일선 위', '200일선 아래');
  add(s50[n - 1] != null && s200[n - 1] != null ? s50[n - 1] > s200[n - 1] : null, '50일선이 200일선 위(정배열)', '50일선이 200일선 아래(역배열)');
  add(macdHist != null ? macdHist > 0 : null, 'MACD 히스토그램 양(+)', 'MACD 히스토그램 음(−)');
  const r14 = rsi(closes, 14);
  if (r14 != null && r14 >= 70) reasons.push('RSI 과매수 구간');
  if (r14 != null && r14 <= 30) reasons.push('RSI 과매도 구간');
  const bias = score >= 3 ? '강세' : score <= -3 ? '약세' : '중립';

  const seriesLen = Math.min(130, n);
  return {
    price: last,
    rsi14: r14,
    sma20: s20[n - 1],
    sma50: s50[n - 1],
    sma200: s200[n - 1],
    macd,
    macdSignal,
    macdHist,
    bollinger: { mid: bbMid, upper: bbMid + 2 * bbSd, lower: bbMid - 2 * bbSd },
    atr14: atr,
    dailyVolPct: dailyVol * 100,
    high52,
    low52,
    volRatio5v20: vol20 ? vol5 / vol20 : null,
    ret1w: pct(5),
    ret1m: pct(21),
    ret3m: pct(63),
    resistances,
    supports,
    cone,
    bias,
    biasScore: score,
    biasReasons: reasons,
    series: { sma20: s20.slice(-seriesLen), sma50: s50.slice(-seriesLen) },
  };
}
