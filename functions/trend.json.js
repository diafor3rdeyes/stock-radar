// /trend.json 요청에 KV의 최신 집계를 돌려줍니다.
// 제거 단어·줄임말 연결 목록은 집계 파일에 들어 있는 옛 값 대신 저장소의 최신 값으로 바꿔서 내보냅니다.
export async function onRequest({ env }) {
  const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (!env.RADAR) return new Response("KV 연결(RADAR)이 없습니다", { status: 503 });
  let body;
  try { body = await env.RADAR.get("trend"); }
  catch (e) { return new Response("KV 오류: " + e.message, { status: 500 }); }
  if (!body) return new Response("not ready", { status: 404 });
  try {
    const j = JSON.parse(body);
    const [a, s] = await Promise.all([env.RADAR.get("aliases"), env.RADAR.get("stopwords")]);
    j.aliasMap = a ? JSON.parse(a) : {};
    j.stopWords = s ? JSON.parse(s) : [];
    j.listsLive = true;
    return new Response(JSON.stringify(j), { headers: H });
  } catch (e) {
    return new Response(body, { headers: H });
  }
}
