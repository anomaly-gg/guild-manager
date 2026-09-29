// Phone alerts (M14 web push). Per member: which devices (push_subs) and, per team, which alerts
// (push_prefs). Free for every team. How it works: lib/push-send.js (wake-ups), lib/push-state.js
// (what a device shows), sw.js (the device side).

import { json, safeJson } from '../lib/http.js';
import { requireTeamMember } from '../lib/team.js';
import { getVapidKeys } from '../lib/push-keys.js';
import { allowedEndpoint, wakeDevices } from '../lib/push-send.js';
import { pushState } from '../lib/push-state.js';
import { prefOf, cleanPrefs, NO_GROUP } from '../lib/push-prefs.js';
import { parseGroups } from '../lib/spawn-groups.js';

const TEST_SHOWN_MS = 2 * 60000;

async function ownDevice(env, userId, endpoint) {
  return endpoint ? env.DB.prepare('SELECT id, endpoint FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(String(endpoint), userId).first() : null;
}

export const routes = [
  // GET /api/push/key -> { key } (VAPID public key for pushManager.subscribe)
  { method: 'GET', pattern: '/api/push/key', handler: async ({ env }) => json({ key: (await getVapidKeys(env)).publicKey }) },

  // POST /api/push/subscribe { endpoint } — this device gets alerts for this member. A device that
  // changes hands (another member signs in) moves to the new member.
  { method: 'POST', pattern: '/api/push/subscribe', handler: async ({ request, env, user }) => {
    const body = await safeJson(request);
    const endpoint = String(body?.endpoint || '');
    if (!allowedEndpoint(env, endpoint)) return json({ error: 'This browser\'s push service is not supported' }, 400);
    await env.DB.prepare(`INSERT INTO push_subs (id, user_id, endpoint, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, fails = 0, pending = 0`)
      .bind(crypto.randomUUID(), user.userId, endpoint, Date.now()).run();
    return json({ ok: true });
  } },

  // POST /api/push/unsubscribe { endpoint }
  { method: 'POST', pattern: '/api/push/unsubscribe', handler: async ({ request, env, user }) => {
    const body = await safeJson(request);
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(String(body?.endpoint || ''), user.userId).run();
    return json({ ok: true });
  } },

  // GET /api/push/prefs?endpoint= -> { device, devices, teams: [{ id, name, soon, spawned, groups, groupList }] }
  // device = this endpoint is on for this member; groups null = all.
  { method: 'GET', pattern: '/api/push/prefs', handler: async ({ request, env, user }) => {
    const endpoint = new URL(request.url).searchParams.get('endpoint');
    const [subs, teams] = await env.DB.batch([
      env.DB.prepare('SELECT endpoint FROM push_subs WHERE user_id = ?').bind(user.userId),
      env.DB.prepare(`SELECT t.id, t.name, ts.spawn_groups, p.soon, p.spawned, p.groups FROM team_members tm JOIN teams t ON t.id = tm.team_id
          LEFT JOIN team_settings ts ON ts.team_id = t.id LEFT JOIN push_prefs p ON p.user_id = tm.user_id AND p.team_id = t.id
          WHERE tm.user_id = ? ORDER BY t.name`).bind(user.userId),
    ]);
    return json({
      device: !!endpoint && subs.results.some(s => s.endpoint === endpoint),
      devices: subs.results.length,
      noGroup: NO_GROUP,
      teams: teams.results.map(t => ({ id: t.id, name: t.name, ...prefOf(t), groupList: parseGroups(t.spawn_groups).map(g => ({ id: g.id, name: g.name })) })),
    });
  } },

  // PUT /api/push/prefs { teamId, soon, spawned, groups: [ids] | null }
  { method: 'PUT', pattern: '/api/push/prefs', handler: async ({ request, env, user }) => {
    const body = await safeJson(request);
    const teamId = String(body?.teamId || '');
    if (!(await requireTeamMember(env, teamId, user.userId))) return json({ error: 'Not a member' }, 403);
    const s = await env.DB.prepare('SELECT spawn_groups FROM team_settings WHERE team_id = ?').bind(teamId).first();
    const p = cleanPrefs(body, parseGroups(s?.spawn_groups).map(g => g.id));
    if (typeof p === 'string') return json({ error: p }, 400);
    await env.DB.prepare(`INSERT INTO push_prefs (user_id, team_id, soon, spawned, groups) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, team_id) DO UPDATE SET soon = excluded.soon, spawned = excluded.spawned, groups = excluded.groups`)
      .bind(user.userId, teamId, p.soon, p.spawned, p.groups).run();
    return json({ ok: true });
  } },

  // POST /api/push/test { endpoint } — a test alert on that device (the next sync shows it once)
  { method: 'POST', pattern: '/api/push/test', handler: async ({ request, env, user }) => {
    const body = await safeJson(request);
    const dev = await ownDevice(env, user.userId, body?.endpoint);
    if (!dev) return json({ error: 'Turn on alerts on this device first' }, 400);
    await env.DB.prepare('UPDATE push_subs SET test_at = ? WHERE id = ?').bind(Date.now(), dev.id).run();
    const r = await wakeDevices(env, new Map([[dev.id, dev.endpoint]]));
    return r.sent && !r.failed && !r.gone ? json({ ok: true }) : json({ error: r.gone ? 'This device is no longer subscribed. Turn alerts off and on again.' : 'The push service did not accept the test. Try again in a minute.' }, 502);
  } },
];

// No sign-in: called by the service worker.
export const publicRoutes = [
  // POST /public/push/sync { endpoint } — the service worker, after a wake-up (no sign-in there:
  // the endpoint is the device's secret) -> { items: [one per team], test? }
  { method: 'POST', pattern: '/public/push/sync', handler: async ({ request, env }) => {
    const body = await safeJson(request);
    const dev = body?.endpoint ? await env.DB.prepare('SELECT id, user_id, test_at FROM push_subs WHERE endpoint = ?').bind(String(body.endpoint)).first() : null;
    if (!dev) return json({ items: [], unknown: true });
    const now = Date.now();
    const test = dev.test_at && now - dev.test_at < TEST_SHOWN_MS;
    if (dev.test_at) await env.DB.prepare('UPDATE push_subs SET test_at = NULL WHERE id = ?').bind(dev.id).run();
    return json({ items: await pushState(env, dev.user_id, now), ...(test ? { test: { tag: 'test', title: 'Test alert', body: 'Phone alerts work on this device.' } } : {}) });
  } },
];
