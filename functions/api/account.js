// 계정과 내 데이터(종목 목록·매수 기록) 서버 저장
//   POST /api/auth { action:'google', credential, code? } → { ok, token, username, label }  (구글 로그인)
//   POST /api/auth { action:'logout' }
//   GET  /api/auth           → 현재 로그인한 사용자
//   GET  /api/auth?config=1  → { googleClientId }  (화면이 구글 로그인 버튼을 그릴 때 사용)
//   GET  /api/data  → { ok, data: {watch, active, pos, updatedAt} | null }
//   PUT  /api/data  → 같은 모양을 저장
// 환경변수: GOOGLE_CLIENT_ID(필수), ALLOWED_EMAILS(선택, 쉼표로 구분 — 설정하면 이 구글 계정만 로그인 가능),
//           ACCESS_CODE(설정돼 있고 ALLOWED_EMAILS가 없으면, 처음 로그인하는 계정은 이 코드가 필요)
import { json } from '../_lib/util.js';
import { randomHex, safeEqual, createSession, bearer, getUser, sha256Hex } from '../_lib/auth.js';

const SYM = /^[A-Z0-9.\-^=]{1,16}$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function sanitize(b) {
  const watch = (Array.isArray(b.watch) ? b.watch : []).filter((x) => typeof x === 'string' && SYM.test(x)).slice(0, 30);
  const active = typeof b.active === 'string' && SYM.test(b.active) ? b.active : '';
  const pos = {};
  if (b.pos && typeof b.pos === 'object' && !Array.isArray(b.pos)) {
    for (const sym of Object.keys(b.pos).slice(0, 30)) {
      if (!SYM.test(sym) || !Array.isArray(b.pos[sym])) continue;
      const lots = [];
      for (const l of b.pos[sym].slice(0, 50)) {
        if (!l || typeof l !== 'object') continue;
        const price = num(l.price);
        const qty = num(l.qty);
        if (!(price > 0) || !(qty > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(l.date || ''))) continue;
        lots.push({ id: String(l.id || randomHex(4)).slice(0, 24), k: 3, date: l.date, price, qty });
      }
      if (lots.length) pos[sym] = lots;
    }
  }
  return { watch, active, pos, updatedAt: Date.now() };
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (url.pathname === '/api/auth' && request.method === 'GET' && url.searchParams.get('config')) {
    return json({ ok: true, googleClientId: (env.GOOGLE_CLIENT_ID || '').trim() || null, kv: !!env.ALERTS });
  }
  if (!env.ALERTS) return json({ ok: false, error: '저장소(KV)가 아직 연결되지 않았습니다.', noKv: true }, 503);

  if (url.pathname === '/api/auth') {
    if (request.method === 'GET') {
      const u = await getUser(request, env);
      if (!u) return json({ ok: false, error: '로그인이 필요합니다.' }, 401);
      const p = await env.ALERTS.get('prof:' + u, 'json');
      return json({ ok: true, username: u, label: (p && p.email) || u });
    }
    if (request.method !== 'POST') return json({ ok: false, error: '지원하지 않는 요청입니다.' }, 405);
    let b;
    try {
      b = await request.json();
    } catch {
      return json({ ok: false, error: '잘못된 요청입니다.' }, 400);
    }
    if (b.action === 'logout') {
      const t = bearer(request);
      if (t) await env.ALERTS.delete('sess:' + (await sha256Hex(t)));
      return json({ ok: true });
    }
    if (b.action === 'google') {
      const clientId = (env.GOOGLE_CLIENT_ID || '').trim();
      if (!clientId) return json({ ok: false, error: '서버에 GOOGLE_CLIENT_ID가 설정되지 않았습니다.' }, 500);
      const cred = String(b.credential || '');
      if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(cred) || cred.length > 4000) return json({ ok: false, error: '구글 로그인 정보가 올바르지 않습니다.' }, 400);
      let info;
      try {
        const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
        info = await r.json();
        if (!r.ok || info.error) throw new Error('invalid');
      } catch {
        return json({ ok: false, error: '구글 로그인을 확인하지 못했습니다. 다시 시도해 주세요.' }, 401);
      }
      if (info.aud !== clientId || !/^(https:\/\/)?accounts\.google\.com$/.test(info.iss || '') || !(Number(info.exp) * 1000 > Date.now()) || String(info.email_verified) !== 'true' || !info.sub) {
        return json({ ok: false, error: '이 사이트용 구글 로그인이 아닙니다.' }, 401);
      }
      const email = String(info.email || '').toLowerCase();
      const allowed = (env.ALLOWED_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      const id = 'g' + String(info.sub).replace(/[^0-9a-z]/gi, '').slice(0, 30);
      if (allowed.length) {
        if (!allowed.includes(email)) return json({ ok: false, error: '허용되지 않은 구글 계정입니다. (' + email + ')' }, 403);
      } else {
        const need = (env.ACCESS_CODE || '').trim();
        const known = await env.ALERTS.get('prof:' + id);
        if (need && !known && !safeEqual(need, String(b.code || '').trim())) {
          return json({ ok: false, error: '처음 로그인하려면 접근 코드가 필요합니다. 오른쪽 위 "접근 코드"에 먼저 입력해 주세요.' }, 403);
        }
      }
      await env.ALERTS.put('prof:' + id, JSON.stringify({ email, name: String(info.name || '').slice(0, 60), lastLogin: Date.now() }));
      return json({ ok: true, username: id, label: email, token: await createSession(env, id) });
    }
    return json({ ok: false, error: '알 수 없는 요청입니다.' }, 400);
  }

  if (url.pathname === '/api/data') {
    const user = await getUser(request, env);
    if (!user) return json({ ok: false, error: '로그인이 필요합니다.' }, 401);
    if (request.method === 'GET') return json({ ok: true, data: (await env.ALERTS.get('data:' + user, 'json')) || null });
    if (request.method === 'PUT') {
      const text = await request.text();
      if (text.length > 150000) return json({ ok: false, error: '데이터가 너무 큽니다.' }, 413);
      let b;
      try {
        b = JSON.parse(text);
      } catch {
        return json({ ok: false, error: '잘못된 요청입니다.' }, 400);
      }
      const data = sanitize(b || {});
      await env.ALERTS.put('data:' + user, JSON.stringify(data));
      return json({ ok: true, updatedAt: data.updatedAt });
    }
  }
  return json({ ok: false, error: '지원하지 않는 요청입니다.' }, 405);
}
