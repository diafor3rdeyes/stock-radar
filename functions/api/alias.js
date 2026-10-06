// 줄임말 → 풀네임 연결을 저장하는 중계 장치. 클라우드플레어 KV의 "aliases" 칸에 보관하고,
// 다음 수집 때 stock_radar.py가 읽어 갑니다.
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  if (!env.RADAR) return json({ ok: false, error: "not_configured" }, 503);

  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const abbr = String(b.abbr || "").trim();
  if (!abbr || abbr.length > 20) return json({ ok: false, error: "줄임말이 비었거나 너무 깁니다" }, 400);

  let map = {};
  try { map = JSON.parse((await env.RADAR.get("aliases")) || "{}"); } catch { map = {}; }

  if (b.remove) {
    delete map[abbr];
  } else {
    const name = String(b.name || "").trim();
    const code = String(b.code || "").trim().toUpperCase();
    if (!name || name.length > 30) return json({ ok: false, error: "풀네임이 비었거나 너무 깁니다" }, 400);
    if (!/^[A-Z0-9.\-]{0,12}$/.test(code)) return json({ ok: false, error: "종목코드 형식이 올바르지 않습니다" }, 400);
    if (!(abbr in map) && Object.keys(map).length >= 300) return json({ ok: false, error: "연결은 최대 300개입니다" }, 400);
    map[abbr] = { name, code };
  }
  await env.RADAR.put("aliases", JSON.stringify(map));
  return json({ ok: true, map });
}
