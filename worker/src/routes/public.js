// Public, unauthenticated read-only endpoints (public routes)

import { json } from '../lib/http.js';
import { parseGroups } from '../lib/spawn-groups.js';

export const routes = [
  // GET /public/timers/:token — read-only boss timers for a team that enabled sharing
  { method: 'GET', pattern: /^\/public\/timers\/([A-Za-z0-9]{16,64})$/, handler: async ({ env, params }) => {
    const row = await env.DB.prepare(
      'SELECT ts.team_id, ts.timezone, ts.spawn_groups, t.name FROM team_settings ts JOIN teams t ON t.id = ts.team_id WHERE ts.public_token = ?'
    ).bind(params[1]).first();
    if (!row) return json({ error: 'Not found' }, 404);

    const bosses = await env.DB.prepare(
      `SELECT id, name, type, interval_ms, fixed_time, weekly_day, weekly_time, biweekly_days, alert_minutes,
              auto_reset_minutes, window_ms, location, next_spawn, status, last_death, spawn_group
       FROM bosses WHERE team_id = ? ORDER BY next_spawn ASC`
    ).bind(row.team_id).all();

    // Which group has each boss's next spawn: names only (no Discord role ids, no later picks).
    const groups = parseGroups(row.spawn_groups).map(g => ({ id: g.id, name: g.name }));
    return json({ team: { name: row.name, timezone: row.timezone || 'Asia/Manila' }, bosses: bosses.results, groups });
  } },
];
