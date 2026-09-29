// Who gets woken up, and the sending. A change (a boss spawning soon, up, killed, auto-reset, a
// maintenance reset) wakes every device of the team's members who want that change
// (lib/push-prefs.js); each device then syncs its one notification per team (lib/push-state.js).
//
// A run sends at most MAX_PER_RUN wake-ups (free plan: 50 subrequests per invocation, shared with
// Discord); the rest are marked `pending` and go out on the next cron minute.

import { sendWakeUp } from './webpush.js';
import { authFor } from './push-keys.js';
import { prefOf, wants } from './push-prefs.js';

export const MAX_PER_RUN = 30;
const MAX_FAILS = 50;   // a device that has failed this many times in a row is dropped

// Push services browsers use; nothing else may be an endpoint (the worker POSTs to it).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function allowedEndpoint(env, endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (env.PUSH_TEST_ORIGIN && u.origin === env.PUSH_TEST_ORIGIN) return true;   // local tests only
  return u.protocol === 'https:' && PUSH_HOSTS.some(re => re.test(u.hostname));
}

// Send to these devices (Map id -> endpoint), keep the bookkeeping in one batch.
export async function wakeDevices(env, devices) {
  const list = [...devices];
  if (!list.length) return { sent: 0, deferred: 0 };
  const now = list.slice(0, MAX_PER_RUN), later = list.slice(MAX_PER_RUN);
  const results = await Promise.all(now.map(async ([id, endpoint]) => [id, await sendWakeUp(endpoint, await authFor(env, endpoint))]));
  const gone = results.filter(([, r]) => r.gone).map(([id]) => id);
  const failed = results.filter(([, r]) => !r.ok && !r.gone).map(([id]) => id);
  const ok = results.filter(([, r]) => r.ok).map(([id]) => id);
  const inList = (ids) => ids.map(() => '?').join(',');
  const stmts = [];
  if (gone.length) stmts.push(env.DB.prepare(`DELETE FROM push_subs WHERE id IN (${inList(gone)})`).bind(...gone));
  if (failed.length) {
    stmts.push(env.DB.prepare(`UPDATE push_subs SET fails = fails + 1, pending = 0 WHERE id IN (${inList(failed)})`).bind(...failed));
    stmts.push(env.DB.prepare(`DELETE FROM push_subs WHERE fails >= ${MAX_FAILS} AND id IN (${inList(failed)})`).bind(...failed));
  }
  if (ok.length) stmts.push(env.DB.prepare(`UPDATE push_subs SET fails = 0, pending = 0 WHERE (fails > 0 OR pending > 0) AND id IN (${inList(ok)})`).bind(...ok));
  const lateIds = later.map(([id]) => id);
  if (lateIds.length) stmts.push(env.DB.prepare(`UPDATE push_subs SET pending = 1 WHERE id IN (${inList(lateIds)})`).bind(...lateIds));
  if (stmts.length) await env.DB.batch(stmts);
  return { sent: now.length, deferred: later.length, gone: gone.length, failed: failed.length };
}

// changes: [{ teamId, kind: 'soon' | 'spawned' | 'ended' | 'maintenance', groupId }]
// -> Map id -> endpoint of the devices to wake (one wake-up per device, however many changes)
export async function devicesFor(env, changes) {
  const teams = [...new Set(changes.map(c => c.teamId))];
  if (!teams.length) return new Map();
  const rows = await env.DB.prepare(`SELECT s.id, s.endpoint, tm.team_id, p.soon, p.spawned, p.groups
      FROM push_subs s JOIN team_members tm ON tm.user_id = s.user_id
      LEFT JOIN push_prefs p ON p.user_id = s.user_id AND p.team_id = tm.team_id
      WHERE tm.team_id IN (${teams.map(() => '?').join(',')})`).bind(...teams).all();
  const out = new Map();
  for (const r of rows.results) {
    const pref = prefOf(r);
    if (changes.some(c => c.teamId === r.team_id && wants(pref, c.kind, c.groupId))) out.set(r.id, r.endpoint);
  }
  return out;
}

// Cron: this tick's changes + devices left over from the last tick. Never throws (push must not
// break the boss loop; e.g. the tables do not exist until the first request after a deploy).
export async function cronPush(env, changes) {
  try {
    const devices = await devicesFor(env, changes);
    const pending = await env.DB.prepare(`SELECT id, endpoint FROM push_subs WHERE pending = 1 LIMIT ${MAX_PER_RUN}`).all();
    for (const r of pending.results) devices.set(r.id, r.endpoint);
    return await wakeDevices(env, devices);
  } catch (e) {
    console.error('push (cron) failed:', e);
    return null;
  }
}

// From a request (a kill, a maintenance reset): after the response when there is a ctx.
export function queuePush(ctx, env, changes) {
  const work = devicesFor(env, changes).then(d => wakeDevices(env, d)).catch(e => console.error('push failed:', e));
  if (ctx?.waitUntil) ctx.waitUntil(work);
  return work;
}
