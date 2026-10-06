export async function onRequest({ env }) {
  if (!env.RADAR) {
    return new Response("RADAR 연결이 없습니다", { status: 503 });
  }
  try {
    const body = await env.RADAR.get("trend");
    if (!body) return new Response("not ready", { status: 404 });
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return new Response("KV 오류: " + e.message, { status: 500 });
  }
}
