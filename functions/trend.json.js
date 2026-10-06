// Cloudflare Pages Function: /trend.json 요청에 KV에 저장된 최신 집계를 돌려줍니다.
// 시세가 몇 분마다 바뀌어도 사이트를 다시 배포할 필요가 없도록 KV에 둡니다.
export async function onRequest({ env }) {
  const body = await env.RADAR.get("trend");
  if (!body) return new Response("not ready", { status: 404 });
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
