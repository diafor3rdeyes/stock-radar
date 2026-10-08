// POST /api/analyze — Claude(웹 검색 포함)로 종목 분석
// body: { part: 'company'|'news'|'outlook'|'conclusion', symbol, name, currency, ... }
//
// 환경변수
//   ANTHROPIC_API_KEY  (필수)
//   ACCESS_CODE        (권장) 설정하면 같은 코드를 보낸 요청만 허용 → API 비용 보호
//   ANTHROPIC_MODEL    (선택) 기본 claude-haiku-4-5 (절약 모드: 웹 검색 없음)
//   WEB_SEARCH_TOOL    (선택) 기본 web_search_20250305
import { json, checkAccess, UA } from '../_lib/util.js';

const TTL = { company: 43200, news: 1800, outlook: 1800, conclusion: 0 };

const SYSTEM = (today) =>
  `당신은 개인 투자자를 돕는 리서치 애널리스트입니다. 오늘 날짜는 ${today}(KST)입니다.
- 반드시 초등학생도 이해할 수 있는 쉬운 우리말로 씁니다. 결과는 submit_report 도구의 입력으로만 제출하며, 입력의 최상위 키는 요청에 적힌 JSON 형식의 키와 같아야 합니다.
- 비용 절약을 위해 아주 간결하게 씁니다. 군더더기 없이 JSON 값만 짧게 채웁니다.
- 웹 검색은 쓸 수 없습니다. 제공된 자료와 확실히 아는 사실만 쓰고, 확실하지 않은 수치는 지어내지 말고 null로 둡니다.
- 투자 권유가 아니라 참고용 분석입니다.`;

// 뉴스 제목 수집(무료): 해외 종목은 Yahoo 검색 API, 국내 종목(.KS/.KQ)은 한글 이름으로 구글 뉴스 RSS를 쓴다 — 웹 검색 비용을 아끼기 위함
const decodeXml = (t) =>
  String(t || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();

async function koreanName(code) {
  try {
    const r = await fetch(`https://ac.stock.naver.com/ac?q=${code}&target=stock`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const it = j && j.items && j.items[0];
    if (!it) return null;
    if (typeof it.name === 'string') return it.name;
    if (Array.isArray(it) && Array.isArray(it[0]) && typeof it[0][0] === 'string') return it[0][0];
    if (Array.isArray(it) && typeof it[0] === 'string') return it[0];
  } catch (e) {
    /* 이름을 못 구하면 영문 이름으로 대체 */
  }
  return null;
}

async function googleNewsKr(query) {
  try {
    const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
    });
    if (!r.ok) return [];
    const xml = await r.text();
    const out = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && out.length < 6) {
      const it = m[1];
      const pick = (tag) => {
        const x = it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
        return x ? decodeXml(x[1]) : '';
      };
      let title = pick('title');
      let source = pick('source');
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
      const d = Date.parse(pick('pubDate'));
      out.push({ title: title.slice(0, 160), source, date: Number.isFinite(d) ? new Date(d).toISOString().slice(0, 10) : '', url: pick('link') });
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function yahooNews(symbol, name) {
  const kr = symbol.match(/^(\d{6})\.(KS|KQ)$/);
  if (kr) {
    const kname = (await koreanName(kr[1])) || String(name || '').replace(/,?\s*(Co\.?,?\s*)?(Ltd|Inc|Corp)\.?$/i, '').trim();
    const list = await googleNewsKr(`${kname || kr[1]} 주가`);
    if (list.length) return list;
  }
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`https://${host}/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=8`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!r.ok) continue;
      const j = await r.json();
      const list = (j.news || []).slice(0, 6).map((n) => ({
        title: String(n.title || '').slice(0, 160),
        source: n.publisher || '',
        date: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().slice(0, 10) : '',
        url: n.link || '',
      }));
      if (list.length) return list;
    } catch (e) {
      /* 다음 호스트 */
    }
  }
  return [];
}

function prompts(part, b) {
  const who = `${b.name || b.symbol} (종목코드 ${b.symbol}${b.currency ? ', 통화 ' + b.currency : ''})`;
  if (part === 'company') {
    return {
      maxTokens: 1100,
      user: `${who}의 기업 요약을 알고 있는 지식으로 짧게 JSON으로 답하세요. 수치는 확실한 것만 쓰고 모르면 null.
{
 "name": "회사명",
 "oneLine": "한 줄 정의(25자 안팎)",
 "summary": "어떤 일을 하고 어떻게 돈을 버는 회사인지 쉬운 말로 최대 3문장",
 "segments": [{"name":"부문명","revenue":"최근 연 매출(통화·기간)","revenueShare":"매출 비중(%)","operatingIncome":"부문 영업이익 또는 null","profitShare":"이익 비중(%) 또는 null"}],
 "topRevenueSegment": "매출이 가장 큰 부문",
 "topProfitSegment": "이익이 가장 큰 부문",
 "segmentComment": "어느 사업이 매출·이익을 제일 많이 내는지 쉬운 말로 최대 3문장",
 "financial": {"period":"기준 기간","revenue":"매출","operatingIncome":"영업이익","operatingMargin":"영업이익률","note":"쉬운 말 한 줄"},
 "note": "최신 공시가 아닌 AI가 아는 정보라 오래됐을 수 있다는 한 줄"
}
부문은 최대 3개. 전문 용어는 쉽게 풀어 쓰세요.`,
    };
  }
  if (part === 'news') {
    const h = JSON.stringify(b.headlines || []);
    return {
      maxTokens: 1300,
      user: `${who}의 최근 뉴스 제목 목록입니다. 주가와 관련 있는 것만 최대 5건 골라 아래 JSON으로 정리하세요. 목록이 비었으면 items는 빈 배열로 두고 note에 "뉴스를 가져오지 못했습니다"라고 쓰세요.
뉴스 목록: ${h}
{
 "items": [{"title":"목록의 제목 그대로","source":"목록의 source","date":"목록의 date","url":"목록의 url 그대로","summary":"무슨 일인지 쉬운 말로 1문장(한국어)","impact":"호재|악재|중립","horizon":"단기(2주 이내)|중기(1~3개월)|장기","magnitude":1~5 정수,"reasoning":"주가에 왜 좋거나 나쁜지 쉬운 말로 1문장"}],
 "overall": {"sentiment":"긍정|부정|혼조|중립","netImpact2w":"앞으로 2주 주가에 미칠 영향 한 줄","summary":"뉴스 흐름 종합 최대 3문장","keyThemes":["핵심 테마 2~3개"]},
 "note": null
}
기사 내용을 지어내지 말고 제목에서 알 수 있는 범위에서만 판단하세요.`,
    };
  }
  if (part === 'outlook') {
    const t = JSON.stringify(b.tech || {});
    return {
      maxTokens: 1700,
      user: `${who}의 향후 2주(영업일 10일) 주가를 아래 차트 지표만 근거로 전망하세요. 현재가는 ${b.price}입니다. 가격은 지표(이동평균, 지지·저항 후보, 변동성 범위)에서 크게 벗어나지 않게 정하세요.
차트 지표: ${t}
{
 "forecast": {"direction":"상승|횡보|하락","confidence":"낮음|중간|높음","expectedRange":{"low":숫자,"high":숫자},
   "scenarios":{"bull":{"price":숫자,"probabilityPct":숫자,"narrative":"쉬운 말 1문장"},"base":{"price":숫자,"probabilityPct":숫자,"narrative":"1문장"},"bear":{"price":숫자,"probabilityPct":숫자,"narrative":"1문장"}},
   "rationale":"차트 흐름 근거 최대 3문장"},
 "levels": {"resistances":[{"price":숫자,"reason":"짧게"}],"supports":[{"price":숫자,"reason":"짧게"}],
   "sellPlan":{"target1":{"price":숫자,"action":"예: 1/3 매도"},"target2":{"price":숫자,"action":"..."},"stopLoss":{"price":숫자,"action":"..."},"timing":"언제·어떤 신호에 팔지 최대 2문장"}},
 "analysts": {"consensus":"절약 모드라 실시간 애널리스트 의견은 제공하지 않습니다","targetAvg":null,"targetHigh":null,"targetLow":null,"analystCount":null,"upsidePct":null,"recent":[],"comment":""},
 "events": [],
 "note": null
}
확률 합계는 100. 저항선·지지선은 각 2개, 가까운 순서. analysts와 events는 위 형식 그대로 두세요.`,
    };
  }
  if (part === 'conclusion') {
    return {
      searches: 0,
      maxTokens: 2500,
      user: `${who}에 대해 아래 조사 결과를 종합해 최종 결론을 쓰세요. 검색은 하지 말고, 주어진 자료 안에서 서로 충돌하는 점이 있으면 그대로 드러내세요.
자료: ${JSON.stringify(b.digest || {})}

{
 "stance": "매수 우위|분할 매수 관심|관망|비중 축소 고려|매도 우위 중 하나",
 "score": -5~5 정수(양수일수록 우호적),
 "oneLine": "결론 한 문장",
 "summary": "기업·뉴스·차트·애널리스트를 묶은 종합 의견 5~7문장",
 "bullets": ["핵심 판단 근거 3~5개"],
 "risks": ["주요 위험 요인 2~4개"],
 "catalysts": ["향후 2주 주가를 움직일 변수 2~4개"],
 "actionPlan": "신규 진입자와 보유자 각각이 2주 동안 확인할 가격·신호 3~4문장"
}`,
    };
  }
  return null;
}

const SUBMIT_TOOL = {
  name: 'submit_report',
  description:
    '조사를 마친 뒤 최종 결과를 이 도구의 입력으로 제출합니다. 입력의 최상위 키는 요청에 적힌 JSON 형식의 키와 같아야 합니다.',
  input_schema: { type: 'object', additionalProperties: true },
};

function extractJson(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('분석 결과를 해석하지 못했습니다.');
  const raw = text.slice(a, b + 1);
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 흔한 오류(끝 쉼표, 따옴표 모양)만 고쳐 한 번 더 시도
    const fixed = raw
      .replace(/[“”]/g, '"')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(fixed);
  }
}

// 결과는 submit_report 도구 입력(API가 JSON 문법을 보장)으로 받는다. 안 쓰면 본문에서 JSON을 찾고, 그것도 안 되면 제출을 강제한다.
async function callClaude(env, { user, searches, maxTokens }, today) {
  const messages = [{ role: 'user', content: user }];
  const tools = [];
  if (searches) tools.push({ type: env.WEB_SEARCH_TOOL || 'web_search_20250305', name: 'web_search', max_uses: searches }); // 절약 모드에서는 searches가 없다
  tools.push(SUBMIT_TOOL);
  let force = !searches; // 검색이 없는 결론 단계는 처음부터 제출을 강제
  for (let turn = 0; turn < 5; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
        max_tokens: maxTokens,
        system: SYSTEM(today),
        messages,
        tools,
        ...(force ? { tool_choice: { type: 'tool', name: 'submit_report' } } : {}),
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Claude API ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const blocks = data.content || [];

    const sub = blocks.find((b) => b.type === 'tool_use' && b.name === 'submit_report');
    if (sub && sub.input && typeof sub.input === 'object') return sub.input;

    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return extractJson(text);
    } catch (e) {
      messages.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '(검색 완료)' }] });
      messages.push({ role: 'user', content: '조사한 내용을 요청한 형식 그대로 submit_report 도구로 제출해 주세요.' });
      force = true;
    }
  }
  throw new Error('분석 결과를 받지 못했습니다. 다시 시도해 주세요.');
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: '서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다.' }, 500);
  if (!checkAccess(request, env)) return json({ ok: false, error: '접근 코드가 올바르지 않습니다.' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '잘못된 요청입니다.' }, 400);
  }
  const part = body.part;
  const symbol = String(body.symbol || '').trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9.\-^]{1,16}$/.test(symbol)) return json({ ok: false, error: '종목 코드가 올바르지 않습니다.' }, 400);
  const headlines = part === 'news' ? await yahooNews(symbol, body.name) : null;
  const spec = prompts(part, { ...body, symbol, headlines });
  if (!spec) return json({ ok: false, error: '알 수 없는 분석 항목입니다.' }, 400);

  const ttl = TTL[part];
  const cacheKey = new Request(`https://cache.stock-desk.internal/analyze/${part}/${encodeURIComponent(symbol)}`);
  if (ttl) {
    const hit = await caches.default.match(cacheKey);
    if (hit) return new Response(hit.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'x-cache': 'HIT' } });
  }

  // 검색이 길어질 때 연결이 끊기지 않도록 공백을 주기적으로 흘려보낸 뒤 JSON을 마지막에 보낸다.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  const work = (async () => {
    const beat = setInterval(() => writer.write(enc.encode(' ')).catch(() => {}), 8000);
    let out;
    try {
      const data = await callClaude(env, spec, today);
      out = JSON.stringify({ ok: true, data, generatedAt: Date.now() });
      if (ttl) {
        waitUntil(
          caches.default.put(
            cacheKey,
            new Response(out, {
              headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${ttl}` },
            })
          )
        );
      }
    } catch (e) {
      out = JSON.stringify({ ok: false, error: String((e && e.message) || e) });
    } finally {
      clearInterval(beat);
    }
    await writer.write(enc.encode(out));
    await writer.close();
  })();
  waitUntil(work);

  return new Response(readable, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cache': 'MISS' },
  });
}
