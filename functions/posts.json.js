// /posts.json 요청에 KV의 최근 24시간 글 목록을 그대로 돌려줍니다. ('실시간 검색' 탭이 탭을 열 때만 읽습니다)
export async function onRequest({ env }) {
  const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (!env.RADAR) return new Response("KV 연결(RADAR)이 없습니다", { status: 503 });
  let body;
  try { body = await env.RADAR.get("posts"); }
  catch (e) { return new Response("KV 오류: " + e.message, { status: 500 }); }
  if (!body) return new Response("not ready", { status: 404 });
  return new Response(body, { headers: H });
}
