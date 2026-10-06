// "지금 반영하기" 버튼이 부르는 중계 장치.
// 깃허브에 "수집을 지금 돌려라"는 신호를 보냅니다. 열쇠(GH_TOKEN)는 클라우드플레어에만 있고 화면에는 나오지 않습니다.
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function onRequestPost({ request, env }) {
  // 다른 사이트에서 몰래 누르는 요청을 막는다
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  if (!env.GH_TOKEN) return json({ ok: false, error: "not_configured" }, 503);

  // 연타 방지: 90초에 한 번만
  const now = Date.now();
  const last = Number((await env.RADAR.get("refresh_last")) || 0);
  if (now - last < 90000) {
    return json({ ok: false, error: "too_soon", wait: Math.ceil((90000 - (now - last)) / 1000) }, 429);
  }
  await env.RADAR.put("refresh_last", String(now), { expirationTtl: 600 });

  const repo = env.GH_REPO || "diafor3rdeyes/stock-radar";
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/radar.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "stockradar-refresh",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { mode: "trend" } }),
  });
  if (r.status !== 204) return json({ ok: false, error: "github", status: r.status }, 502);
  return json({ ok: true });
}
