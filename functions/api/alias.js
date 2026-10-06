// 줄임말 → 풀네임 연결을 저장하는 중계 장치. 클라우드플레어 KV의 "aliases" 칸에 보관하고,
// 다음 수집 때 stock_radar.py가 읽어 갑니다.
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function onRequestGet({ env }) {
  if (!env.RADAR) return json({ ok: false, error: "not_configured" }, 503);
  let map = {}, stop = [];
  try { map = JSON.parse((await env.RADAR.get("aliases")) || "{}"); } catch { map = {}; }
  try { stop = JSON.parse((await env.RADAR.get("stopwords")) || "[]"); } catch { stop = []; }
  return json({ ok: true, map, stop });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  if (!env.RADAR) return json({ ok: false, error: "not_configured" }, 503);

  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  // AI 잔액 입력: 입력한 시점의 잔액과 그때까지 쓴 누적 금액을 같이 저장해 두면, 이후 쓴 만큼 빼서 남은 금액을 계산한다
  if (b.budget !== undefined) {
    let cur = {};
    try { cur = JSON.parse((await env.RADAR.get("aibudget")) || "{}"); } catch { cur = {}; }
    const rec = { amount: Number(cur.amount || 0), usdAtSet: Number(cur.usdAtSet || 0), adj: Number(cur.adj || 0), setAt: cur.setAt || null };
    const ok = (v) => isFinite(v) && v >= 0 && v <= 100000;
    if (b.budget.amount !== undefined) {
      const amount = Number(b.budget.amount), usdAtSet = Number(b.budget.usdAtSet || 0);
      if (!ok(amount) || !ok(usdAtSet)) return json({ ok: false, error: "금액이 올바르지 않습니다" }, 400);
      rec.amount = amount; rec.usdAtSet = usdAtSet; rec.setAt = new Date().toISOString();
    }
    if (b.budget.adj !== undefined) {
      // 실제로 쓴 돈과 화면 추정치의 차이(기능을 켜기 전에 쓴 돈 등). 마이너스도 허용.
      const adj = Number(b.budget.adj);
      if (!isFinite(adj) || Math.abs(adj) > 100000) return json({ ok: false, error: "금액이 올바르지 않습니다" }, 400);
      rec.adj = adj;
    }
    await env.RADAR.put("aibudget", JSON.stringify(rec));
    return json({ ok: true, budget: rec });
  }

  // 제거할 단어(후보에서 빼기) 추가/복원
  if (b.stop || b.unstop) {
    const w = String(b.stop || b.unstop).trim();
    if (!w || w.length > 20) return json({ ok: false, error: "단어가 비었거나 너무 깁니다" }, 400);
    let list = [];
    try { list = JSON.parse((await env.RADAR.get("stopwords")) || "[]"); } catch { list = []; }
    if (b.stop) {
      if (!list.includes(w)) {
        if (list.length >= 500) return json({ ok: false, error: "제거 단어는 최대 500개입니다" }, 400);
        list.push(w);
      }
    } else {
      list = list.filter((x) => x !== w);
    }
    await env.RADAR.put("stopwords", JSON.stringify(list));
    return json({ ok: true, stop: list });
  }

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
