// M14 phone alerts against `wrangler dev --local --test-scheduled` (8788), with a mock push service on
// 8797 that records every wake-up (and answers 410 for endpoints under /push/gone). argv[2] = worker dir.
// Devices sync like sw.js does (POST /public/push/sync) and the test reads what they would show.
import { createPublicKey, verify } from 'node:crypto';
import { execSync } from 'node:child_process';
import http from 'node:http';

const W = 'http://127.0.0.1:8788', PUSH = 'http://127.0.0.1:8797';
const WORKER_DIR = process.argv[2];
const checks = [];
const check = (name, cond, info = '') => { checks.push(!!cond); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : `   <- ${typeof info === 'string' ? info : JSON.stringify(info).slice(0, 600)}`)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fetch = async (url, opts) => { try { return await globalThis.fetch(url, opts); } catch (e) { if (e.cause?.code !== 'ECONNRESET') throw e; await sleep(100); return globalThis.fetch(url, opts); } };

// ---- mock push service
const wakes = [];   // { dev, headers }
const mock = http.createServer((req, res) => {
  req.on('data', () => {}); req.on('end', () => {
    const m = req.url.match(/^\/push\/([\w-]+)$/);
    if (req.method === 'POST' && m) {
      wakes.push({ dev: m[1], headers: req.headers });
      res.writeHead(m[1].startsWith('gone') ? 410 : 201); return res.end();
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => mock.listen(8797, '127.0.0.1', r));

async function api(method, path, body, token) {
  const r = await fetch(W + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let d; try { d = await r.json(); } catch { d = {}; }
  return [r.status, d];
}
const sql = (q) => execSync(`npx wrangler d1 execute guild-manager --local --json --command "${q.replace(/"/g, '\\"')}"`, { cwd: WORKER_DIR, shell: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
const rows = (q) => { const out = sql(q); return JSON.parse(out.slice(out.indexOf('[')))[0].results; };
const cron = () => fetch(W + '/__scheduled?cron=*+*+*+*+*').then(r => r.text());
const ep = (dev) => `${PUSH}/push/${dev}`;
// devices woken after index `from` (waits for the fire-and-forget sends of a request)
async function wokenSince(from, ms = 3000) { await sleep(ms); return [...new Set(wakes.slice(from).map(w => w.dev))].sort(); }
const sync = async (dev) => (await api('POST', '/public/push/sync', { endpoint: ep(dev) }))[1];
const teamItem = (d, team) => (d.items || []).find(i => i.teamId === team);
const entryIds = (d, team) => (teamItem(d, team)?.entries || []).map(e => e.id);

// ---- setup: leader, two members, one team with groups Kongreso + Senado, one boss per group
const tok = {};
for (const n of ['p_leader', 'p_kon', 'p_sen']) { const [, a] = await api('POST', '/auth/guest', { username: n }); tok[n] = a.token; }
const [, tc] = await api('POST', '/api/teams', { name: 'Push Guild' }, tok.p_leader); const team = tc.id || tc.team?.id;
const [, td] = await api('GET', `/api/teams/${team}`, null, tok.p_leader); const code = (td.team || td).invite_code;
for (const n of ['p_kon', 'p_sen']) await api('POST', `/api/invite/${code}`, {}, tok[n]);
await api('PUT', `/api/teams/${team}/settings`, { spawnGroups: [{ name: 'Kongreso' }, { name: 'Senado' }] }, tok.p_leader);
const [, st] = await api('GET', `/api/teams/${team}/settings`, null, tok.p_leader);
const [KON, SEN] = st.spawnGroups.map(g => g.id);
const [, b1] = await api('POST', `/api/teams/${team}/bosses`, { name: 'Venatus', type: 'interval', intervalMs: 36000000 }, tok.p_leader);
const [, b2] = await api('POST', `/api/teams/${team}/bosses`, { name: 'Ego', type: 'interval', intervalMs: 36000000 }, tok.p_leader);
const VEN = b1.id, EGO = b2.id;
sql(`UPDATE bosses SET spawn_group='${KON}', next_spawn=${Date.now() + 5 * 3600000} WHERE id='${VEN}'; UPDATE bosses SET spawn_group='${SEN}', next_spawn=${Date.now() + 5 * 3600000} WHERE id='${EGO}'`);
await cron(); await sleep(500);   // nothing due yet

// ---- key + subscribe
let [s, d] = await api('GET', '/api/push/key', null, tok.p_kon);
const key = d.key;
check('key: a raw P-256 public key for subscribe()', s === 200 && /^[A-Za-z0-9_-]{87}$/.test(key || ''), d);
[, d] = await api('GET', '/api/push/key', null, tok.p_sen);
check('key: the same key every time (made once, kept)', d.key === key);
[s] = await api('POST', '/api/push/subscribe', { endpoint: 'https://evil.example/x' }, tok.p_kon);
check('subscribe: an endpoint outside the push services is refused', s === 400, s);
for (const [dev, who] of [['kon1', 'p_kon'], ['sen1', 'p_sen'], ['lead1', 'p_leader']]) await api('POST', '/api/push/subscribe', { endpoint: ep(dev) }, tok[who]);
check('subscribe: three devices stored', rows(`SELECT COUNT(*) AS n FROM push_subs`)[0].n === 3);

[s, d] = await api('GET', `/api/push/prefs?endpoint=${encodeURIComponent(ep('kon1'))}`, null, tok.p_kon);
const t0 = d.teams?.find(t => t.id === team);
check('prefs: this device on, defaults (soon + spawned, all groups), the team\'s groups listed', s === 200 && d.device === true && t0?.soon && t0?.spawned && t0?.groups === null && t0?.groupList.map(g => g.name).join() === 'Kongreso,Senado', d);
[s] = await api('PUT', '/api/push/prefs', { teamId: team, groups: ['nope'] }, tok.p_sen);
check('prefs: unknown group refused', s === 400, s);
[s] = await api('PUT', '/api/push/prefs', { teamId: 'someone-elses-team', soon: true }, tok.p_sen);
check('prefs: a team you are not in is refused', s === 403, s);
await api('PUT', '/api/push/prefs', { teamId: team, soon: true, spawned: true, groups: [SEN] }, tok.p_sen);   // Senado only
await api('PUT', '/api/push/prefs', { teamId: team, soon: false, spawned: true, groups: null }, tok.p_leader);   // no "spawning soon"

// ---- Venatus (Kongreso) spawning soon -> only the Kongreso member (Senado filters it out, leader has soon off)
let mark = wakes.length;
sql(`UPDATE bosses SET status='waiting', warned=0, spawn_notified=0, alert_minutes=5, next_spawn=${Date.now() + 120000} WHERE id='${VEN}'`);
await cron();
check('soon: wakes only the member who wants it (group + soon filters)', JSON.stringify(await wokenSince(mark)) === '["kon1"]', wakes.slice(mark).map(w => w.dev));
const w = wakes.find(x => x.dev === 'kon1');
const mm = (w?.headers.authorization || '').match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
const jwk = (() => { const raw = Buffer.from(key.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); return { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }; })();
check('wake-up: VAPID JWT for this push origin, signed by the served key', !!mm && mm[4] === key && JSON.parse(Buffer.from(mm[2], 'base64url')).aud === PUSH
  && verify('sha256', Buffer.from(`${mm[1]}.${mm[2]}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(mm[3], 'base64url')), w?.headers);
check('wake-up: empty body, TTL, high urgency, one topic (offline phones wake once)', w?.headers['content-length'] === '0' && w?.headers.ttl === '900' && w?.headers.urgency === 'high' && w?.headers.topic === 'sync', w?.headers);

d = await sync('kon1');
check('sync: one item for the team, Venatus spawning soon', JSON.stringify(entryIds(d, team)) === JSON.stringify([`${VEN}:soon`]) && /Venatus spawns in \d+ min · Push Guild/.test(teamItem(d, team)?.entries[0].title) && /Kongreso/.test(teamItem(d, team)?.body), teamItem(d, team));
check('sync: the Senado-only member sees nothing for Venatus', entryIds(await sync('sen1'), team).length === 0);

// ---- Ego (Senado) spawning soon too -> the one notification lists both (no second notification)
mark = wakes.length;
sql(`UPDATE bosses SET status='waiting', warned=0, spawn_notified=0, alert_minutes=5, next_spawn=${Date.now() + 180000} WHERE id='${EGO}'`);
await cron();
check('second boss: Kongreso member (follows every group) and Senado member woken', JSON.stringify(await wokenSince(mark)) === '["kon1","sen1"]', wakes.slice(mark).map(w => w.dev));
d = await sync('kon1');
check('sync: still ONE item per team, now listing both bosses (soonest first)', (d.items || []).filter(i => i.teamId === team).length === 1 && JSON.stringify(entryIds(d, team)) === JSON.stringify([`${VEN}:soon`, `${EGO}:soon`]) && teamItem(d, team).body.split('\n').length === 2, teamItem(d, team));

// ---- Venatus spawns -> Kongreso member + leader (spawned on); Senado member filtered
mark = wakes.length;
sql(`UPDATE bosses SET next_spawn=${Date.now() - 1000} WHERE id='${VEN}'`);
await cron();
check('spawned: wakes the Kongreso member and the leader', JSON.stringify(await wokenSince(mark)) === '["kon1","lead1"]', wakes.slice(mark).map(w => w.dev));
d = await sync('kon1');
check('sync: Venatus up (listed first), Ego still soon', JSON.stringify(entryIds(d, team)) === JSON.stringify([`${VEN}:spawned`, `${EGO}:soon`]) && d.items.find(i => i.teamId === team).entries[0].title.startsWith('🔴 Venatus is up'), teamItem(d, team));
check('sync: leader (soon off) sees Venatus up but not Ego soon', JSON.stringify(entryIds(await sync('lead1'), team)) === JSON.stringify([`${VEN}:spawned`]));

// ---- kill Venatus from the site -> its line goes; leader's notification is now empty (closes)
mark = wakes.length;
[s] = await api('POST', `/api/teams/${team}/bosses/${VEN}/kill`, {}, tok.p_leader);
check('kill: wakes the devices that had Venatus', s === 200 && JSON.stringify(await wokenSince(mark)) === '["kon1","lead1"]', wakes.slice(mark).map(w => w.dev));
check('sync after kill: Kongreso member keeps only Ego', JSON.stringify(entryIds(await sync('kon1'), team)) === JSON.stringify([`${EGO}:soon`]));
d = await sync('lead1');
check('sync after kill: leader has nothing left (the phone closes it)', entryIds(d, team).length === 0 && /all clear/.test(teamItem(d, team)?.title), teamItem(d, team));

// ---- auto-reset (cron) of Ego after it spawns
sql(`UPDATE bosses SET status='spawned', spawn_notified=1, next_spawn=${Date.now() - 400000}, auto_reset_at=${Date.now() - 1000} WHERE id='${EGO}'`);
mark = wakes.length; await cron();
check('auto-reset: wakes everyone following Ego (Senado member, Kongreso member, leader)', JSON.stringify(await wokenSince(mark)) === '["kon1","lead1","sen1"]', wakes.slice(mark).map(w => w.dev));
check('sync after auto-reset: nothing up or soon', entryIds(await sync('sen1'), team).length === 0);

mark = wakes.length; await cron();
check('a cron minute with no changes wakes nobody', (await wokenSince(mark)).length === 0, wakes.slice(mark).map(w => w.dev));

// ---- test alert
[s] = await api('POST', '/api/push/test', { endpoint: ep('kon1') }, tok.p_kon);
d = await sync('kon1');
check('test: woken, the next sync carries the test alert', s === 200 && wakes.at(-1).dev === 'kon1' && d.test?.title === 'Test alert', [s, d.test]);
check('test: shown once only', !(await sync('kon1')).test);
[s] = await api('POST', '/api/push/test', { endpoint: ep('sen1') }, tok.p_kon);
check('test: someone else\'s device refused', s === 400, s);

// ---- maintenance reset -> one wake per device, one line instead of a line per boss
mark = wakes.length;
[s, d] = await api('POST', `/api/teams/${team}/bosses/maintenance-reset`, {}, tok.p_leader);
check('maintenance: one wake-up per device', s === 200 && JSON.stringify(await wokenSince(mark)) === '["kon1","lead1","sen1"]' && wakes.length - mark === 3, wakes.slice(mark).map(w => w.dev));
await cron(); await sleep(500);   // the cron brings them up, muted: no more wake-ups
d = await sync('kon1');
check('maintenance: the notification shows ONE line for the reset, not a line per boss', JSON.stringify(entryIds(d, team)) === JSON.stringify([entryIds(d, team)[0]]) && /^maint:/.test(entryIds(d, team)[0]) && /2 bosses up since/.test(teamItem(d, team).body), teamItem(d, team));
check('maintenance: the muted spawns wake nobody when the cron brings them up', wakes.length - mark === 3, wakes.slice(mark).map(w => w.dev));

// ---- dead devices are dropped; big teams go out over two minutes
await api('POST', '/api/push/subscribe', { endpoint: ep('gone1') }, tok.p_leader);
const many = Array.from({ length: 34 }, (_, i) => `bulk${i}`);
sql(`INSERT INTO push_subs (id, user_id, endpoint, created_at) VALUES ${many.map(dv => `('${dv}', (SELECT user_id FROM push_subs WHERE endpoint='${ep('lead1')}'), '${ep(dv)}', 0)`).join(', ')}`);
sql(`UPDATE bosses SET status='waiting', warned=0, spawn_notified=0, spawn_group='${KON}', next_spawn=${Date.now() - 1000} WHERE id='${VEN}'`);
// 37 devices want this spawn (Kongreso member, leader's own + gone1 + 34 more of the leader's)
mark = wakes.length; await cron(); await sleep(3000);
const first = wakes.length - mark;
const waiting = rows(`SELECT COUNT(*) AS n FROM push_subs WHERE pending = 1`)[0].n;
check('cap: 30 wake-ups in the first run, the other 7 marked for the next minute', first === 30 && waiting === 7, [first, waiting]);
mark = wakes.length; await cron(); await sleep(3000);
check('next cron minute sends the 7, none left waiting', wakes.length - mark === 7 && rows(`SELECT COUNT(*) AS n FROM push_subs WHERE pending = 1`)[0].n === 0, wakes.length - mark);
check('410 from the push service deletes that device', rows(`SELECT COUNT(*) AS n FROM push_subs WHERE endpoint='${ep('gone1')}'`)[0].n === 0);

// ---- turning off
await api('POST', '/api/push/unsubscribe', { endpoint: ep('sen1') }, tok.p_sen);
d = await sync('sen1');
check('unsubscribe: the device is forgotten; its next sync says so (sw.js then unsubscribes)', d.unknown === true && (d.items || []).length === 0, d);

// ---- account deletion takes the member's devices and choices with it
const [, meKon] = await api('GET', '/auth/me', null, tok.p_kon);
await api('DELETE', '/api/me', null, tok.p_kon);
check('account delete: devices and choices gone', rows(`SELECT COUNT(*) AS n FROM push_subs WHERE user_id='${meKon.id}'`)[0].n === 0 && rows(`SELECT COUNT(*) AS n FROM push_prefs WHERE user_id='${meKon.id}'`)[0].n === 0);

console.log(`${checks.filter(Boolean).length}/${checks.length} checks passed`);
mock.close();
process.exitCode = checks.every(Boolean) ? 0 : 1;
