// Phone alerts, no server: the VAPID header a push service will check (verified here with Node's own
// crypto, not our code), who wants which alert, and which endpoints the worker may POST to.
import { createPublicKey, verify } from 'node:crypto';
import { generateVapidKeys, vapidAuth, b64u } from '../../worker/src/lib/webpush.js';
import { prefOf, wants, cleanPrefs, NO_GROUP } from '../../worker/src/lib/push-prefs.js';
import { allowedEndpoint } from '../../worker/src/lib/push-send.js';

let pass = 0, fail = 0;
const check = (n, c, i = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   <- ' + JSON.stringify(i))); };

// ---- VAPID
const keys = await generateVapidKeys();
const raw = b64u.decode(keys.publicKey);
check('public key is a raw P-256 point (65 bytes, 0x04 first) — what subscribe() takes', raw.length === 65 && raw[0] === 4, raw.length);
check('base64url round trip', b64u.encode(b64u.decode('AQID_-8')) === 'AQID_-8');

const now = Date.parse('2026-09-30T12:00:00Z');
const a = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc:xyz', keys, 'https://anomaly-gg.github.io/guild-manager/', now);
const m = a.header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
check('header shape: "vapid t=<jwt>, k=<key>"', !!m && m[4] === keys.publicKey, a.header.slice(0, 60));
const [h, p, s] = m.slice(1, 4);
const head = JSON.parse(Buffer.from(b64u.decode(h)).toString()), claims = JSON.parse(Buffer.from(b64u.decode(p)).toString());
check('JWT header ES256', head.alg === 'ES256' && head.typ === 'JWT', head);
check('aud = the push service origin, exp = 12 h, sub = the site', claims.aud === 'https://fcm.googleapis.com' && claims.exp === now / 1000 + 12 * 3600 && claims.sub.startsWith('https://'), claims);
const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: keys.privateJwk.x, y: keys.privateJwk.y }, format: 'jwk' });
check('signature verifies with Node crypto (raw r||s)', verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64u.decode(s))));
check('cache window ends before the JWT does', a.expires < claims.exp * 1000 && a.expires > now);

// ---- who wants what
const all = prefOf(null);
check('no row = soon + spawned, every group', all.soon && all.spawned && all.groups === null, all);
check('defaults want everything', ['soon', 'spawned', 'ended'].every(k => wants(all, k, 'k1')) && wants(all, 'spawned', null));
const senOnly = prefOf({ soon: 1, spawned: 1, groups: JSON.stringify(['s1']) });
check('group filter: followed group yes, other group no', wants(senOnly, 'spawned', 's1') && !wants(senOnly, 'spawned', 'k1'));
check('group filter: a boss with no group only if "No group" is followed', !wants(senOnly, 'soon', null) && wants(prefOf({ groups: JSON.stringify([NO_GROUP]) }), 'soon', null));
const noSoon = prefOf({ soon: 0, spawned: 1 });
check('"spawning soon" off: no soon alert, spawned still', !wants(noSoon, 'soon', 'k1') && wants(noSoon, 'spawned', 'k1'));
check('both off: nothing, not even the kill update', !wants(prefOf({ soon: 0, spawned: 0 }), 'ended', 'k1') && !wants(prefOf({ soon: 0, spawned: 0 }), 'maintenance'));
check('maintenance ignores the group filter', wants(senOnly, 'maintenance'));

check('cleanPrefs: unknown group refused', cleanPrefs({ groups: ['zz'] }, ['k1', 's1']) === 'Unknown group');
check('cleanPrefs: every group ticked = null (follows groups added later)', cleanPrefs({ groups: ['k1', 's1', NO_GROUP] }, ['k1', 's1']).groups === null);
const c = cleanPrefs({ soon: false, groups: ['s1'] }, ['k1', 's1']);
check('cleanPrefs: soon off, one group kept', c.soon === 0 && c.spawned === 1 && c.groups === '["s1"]', c);

// ---- endpoints the worker may POST to
const env = {};
check('Chrome/Android (FCM) allowed', allowedEndpoint(env, 'https://fcm.googleapis.com/fcm/send/abc'));
check('Firefox, Safari, Edge allowed', ['https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QK', 'https://wns2-par02p.notify.windows.com/w/?token=x'].every(u => allowedEndpoint(env, u)));
check('anything else refused (no SSRF)', !['https://evil.example/x', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.io/x', 'not a url'].some(u => allowedEndpoint(env, u)));
check('the local test origin only when configured', allowedEndpoint({ PUSH_TEST_ORIGIN: 'http://127.0.0.1:8797' }, 'http://127.0.0.1:8797/push/a') && !allowedEndpoint(env, 'http://127.0.0.1:8797/push/a'));

console.log(`\n${pass}/${pass + fail} checks passed`);
