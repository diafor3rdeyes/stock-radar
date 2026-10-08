// 계정(아이디·비밀번호) 인증 도우미 — 저장소는 Workers KV(ALERTS 바인딩)
//   user:<아이디>  → { salt, hash, createdAt }       (비밀번호는 PBKDF2-SHA256으로 해시, 원문 저장 안 함)
//   sess:<토큰해시> → { u: 아이디 }                    (로그인 토큰은 해시로만 저장, 180일 유효)
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const SESSION_TTL = 60 * 60 * 24 * 180;

export async function sha256Hex(s) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function hashPassword(pw, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromHex(saltHex), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return toHex(bits);
}

export function randomHex(n) {
  return toHex(crypto.getRandomValues(new Uint8Array(n)));
}

export function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function createSession(env, username) {
  const token = randomHex(32);
  await env.ALERTS.put('sess:' + (await sha256Hex(token)), JSON.stringify({ u: username, at: Date.now() }), { expirationTtl: SESSION_TTL });
  return token;
}

export function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+([0-9a-f]{64})$/i);
  return m ? m[1].toLowerCase() : null;
}

// 요청의 로그인 토큰으로 아이디를 찾는다. 없거나 만료면 null.
export async function getUser(request, env) {
  if (!env.ALERTS) return null;
  const token = bearer(request);
  if (!token) return null;
  const s = await env.ALERTS.get('sess:' + (await sha256Hex(token)), 'json');
  return s && s.u ? s.u : null;
}
