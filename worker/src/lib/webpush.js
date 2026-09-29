// Web Push protocol, WebCrypto only (runs in Workers and Node): RFC 8292 VAPID (ES256 JWT) and
// empty "wake-up" messages. We never send a payload: encrypting one costs ~0.5 ms CPU per device
// (RFC 8291 ECDH + HKDF), too much for the free plan's 10 ms cron. The service worker wakes up and
// asks /public/push/sync what to show instead (lib/push-state.js).
// No DB, no settings: callers pass the VAPID keys (lib/push-keys.js).

const enc = new TextEncoder();
const subtle = crypto.subtle;

export const b64u = {
  encode(bytes) {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const t = String(str);
    const s = atob(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  },
};

// { publicKey: base64url raw point (65 bytes, what the browser's subscribe() wants), privateJwk }
export async function generateVapidKeys() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const [raw, jwk] = await Promise.all([subtle.exportKey('raw', pair.publicKey), subtle.exportKey('jwk', pair.privateKey)]);
  return { publicKey: b64u.encode(raw), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

// "vapid t=<jwt>, k=<public key>" for one push-service origin; the JWT is valid 12 h, reuse it
// until `expires` (an hour of margin).
export async function vapidAuth(endpoint, vapid, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const part = (o) => b64u.encode(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const key = await subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));   // raw r||s, as JWS wants
  return { aud, header: `vapid t=${unsigned}.${b64u.encode(sig)}, k=${vapid.publicKey}`, expires: now + 11 * 3600000 };
}

// POST one empty message. `topic`: the push service keeps only the newest undelivered message
// per topic, so a phone that was offline wakes once, not once per change.
// -> { ok, status, gone } (gone = 404/410: the subscription is dead, delete it)
export async function sendWakeUp(endpoint, auth, { ttl = 900, urgency = 'high', topic = 'sync' } = {}) {
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: auth, TTL: String(ttl), Urgency: urgency, Topic: topic, 'Content-Length': '0' } });
    return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: String(e) };
  }
}
