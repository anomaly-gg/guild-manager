// Logging a boss kill: reset the timer from the death time and record it. Shared by the
// POST /bosses/:id/kill route and the Discord /killed command.

import { calcNextSpawn } from './spawn.js';
import { spawnEndStmt } from './schedule-post.js';
import { advanceGroups } from './spawn-groups.js';

// boss: full bosses row. -> { nextSpawn, day } (day = the schedule day of the spawn that ended)
// The caller then edits the spawn's Discord alert with killAlert (lib/boss-alerts.js), after its reply.
// The spawn's group goes with it; the next spawn gets the next group in the boss's list (or alternation).
// groups = the team's spawn groups (for alternation).
export async function killBoss(env, { teamId, boss, deathTime, userId, tz, groups = [] }) {
  const nextSpawn = calcNextSpawn(boss, deathTime, tz || 'Asia/Manila');
  const { spawnGroup, laterGroups } = advanceGroups(boss, groups);
  const ended = spawnEndStmt(env, { teamId, boss, outcome: 'dead', endedAt: deathTime, tz: tz || 'Asia/Manila' });
  await env.DB.batch([
    env.DB.prepare('UPDATE bosses SET status = ?, spawned_at = NULL, auto_reset_at = NULL, last_death = ?, next_spawn = ?, warned = 0, spawn_notified = 0, spawn_group = ?, later_groups = ?, alert_soon_msg = NULL, alert_spawn_msg = NULL WHERE id = ?')
      .bind('waiting', deathTime, nextSpawn, spawnGroup, laterGroups, boss.id),
    env.DB.prepare('INSERT INTO boss_kill_log (id, team_id, boss_id, boss_name, killed_at, killed_by) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), teamId, boss.id, boss.name, deathTime, userId || null),
    ended.stmt,
  ]);
  return { nextSpawn, day: ended.day };
}
