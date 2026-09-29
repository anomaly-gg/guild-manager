// What a phone should show right now (POST /public/push/sync). Phones get empty wake-ups
// (lib/webpush.js) and then ask this; the service worker (sw.js) makes the screen match.
//
// ONE notification per team, never one per boss (no flooding): the title is the newest thing that
// happened, the body lists every boss up or spawning soon for this member. `entries` are ids like
// "<bossId>:spawned"; the service worker only plays a sound when an entry is new, updates silently
// otherwise, and closes the team's notification when `entries` is empty (killed / auto-reset).

import { prefOf, wants } from './push-prefs.js';
import { parseGroups } from './spawn-groups.js';
import { clockIn } from './schedule-format.js';

const MAX_LINES = 6;
const MAINTENANCE_SHOWN_MS = 30 * 60000;

const minutesUntil = (t, now) => Math.max(1, Math.round((t - now) / 60000));

// One boss line + its entry, or null when this member does not want it.
function bossEntry(b, pref, groupName, now, tz) {
  const up = b.status === 'spawned' || b.next_spawn <= now;
  const kind = up ? 'spawned' : 'soon';
  if (!wants(pref, kind, b.spawn_group)) return null;
  const who = groupName ? ` · ${groupName}` : '';
  const where = b.location ? ` · ${b.location}` : '';
  if (up) {
    const closes = b.window_ms > 0 ? `, window closes ${clockIn(b.next_spawn + b.window_ms, tz)}` : '';
    return { id: `${b.id}:spawned`, at: b.next_spawn, up: true, title: `🔴 ${b.name} is up`, line: `🔴 ${b.name}${who}${where} · up since ${clockIn(b.next_spawn, tz)}${closes}` };
  }
  const min = minutesUntil(b.next_spawn, now);
  return { id: `${b.id}:soon`, at: b.next_spawn, up: false, title: `⏳ ${b.name} spawns in ${min} min`, line: `⏳ ${b.name}${who}${where} · ${clockIn(b.next_spawn, tz)} (in ${min} min)` };
}

// -> [{ tag, teamId, title, body, entries, url }] for every team this member is in (entries may be
// empty: that team's notification should close).
export async function pushState(env, userId, now = Date.now()) {
  const [teams, bosses] = await env.DB.batch([
    env.DB.prepare(`SELECT tm.team_id, t.name, ts.timezone, ts.spawn_groups, ts.maintenance_at, ts.maintenance_count, p.soon, p.spawned, p.groups
      FROM team_members tm JOIN teams t ON t.id = tm.team_id
      LEFT JOIN team_settings ts ON ts.team_id = tm.team_id
      LEFT JOIN push_prefs p ON p.user_id = tm.user_id AND p.team_id = tm.team_id
      WHERE tm.user_id = ?`).bind(userId),
    // up now, or warned (inside its "spawning soon" window) and still to come
    env.DB.prepare(`SELECT b.id, b.team_id, b.name, b.location, b.next_spawn, b.status, b.window_ms, b.spawn_group
      FROM bosses b JOIN team_members tm ON tm.team_id = b.team_id
      WHERE tm.user_id = ? AND (b.status = 'spawned' OR (b.status = 'waiting' AND b.warned = 1))`).bind(userId),
  ]);
  const byTeam = new Map();
  for (const b of bosses.results) (byTeam.get(b.team_id) || byTeam.set(b.team_id, []).get(b.team_id)).push(b);

  return teams.results.map(t => {
    const tz = t.timezone || 'Asia/Manila';
    const pref = prefOf(t);
    const names = new Map(parseGroups(t.spawn_groups).map(g => [g.id, g.name]));
    const maint = t.maintenance_at && now - t.maintenance_at < MAINTENANCE_SHOWN_MS && wants(pref, 'maintenance') ? t.maintenance_at : null;
    const entries = [];
    for (const b of byTeam.get(t.team_id) || []) {
      if (t.maintenance_at && b.next_spawn === t.maintenance_at) continue;   // muted by the maintenance reset: one line for all of them
      const e = bossEntry(b, pref, names.get(b.spawn_group), now, tz);
      if (e) entries.push(e);
    }
    // up first (newest spawn first), then soonest spawning
    entries.sort((a, b) => (b.up - a.up) || (a.up ? b.at - a.at : a.at - b.at));
    if (maint) {
      const n = t.maintenance_count || 0;
      entries.unshift({ id: `maint:${maint}`, title: '🔧 Maintenance reset', line: `🔧 ${n} boss${n === 1 ? '' : 'es'} ${maint > now ? 'spawn at' : 'up since'} ${clockIn(maint, tz)}` });
    }
    const lines = entries.slice(0, MAX_LINES).map(e => e.line);
    if (entries.length > MAX_LINES) lines.push(`+${entries.length - MAX_LINES} more`);
    // The service worker titles the notification with the first entry it has not shown yet (what
    // just happened); `title` is the fallback when nothing is new.
    return {
      tag: `team-${t.team_id}`,
      teamId: t.team_id,
      team: t.name,
      title: entries.length ? `${entries[0].title} · ${t.name}` : `${t.name}: all clear`,
      body: lines.join('\n'),
      entries: entries.map(e => ({ id: e.id, title: `${e.title} · ${t.name}` })),
      url: './',
    };
  });
}
