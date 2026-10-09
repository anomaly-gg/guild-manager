// Building a boss row from a create-style body: next spawn per schedule type + the INSERT statement.
// Shared by POST bosses, template import and game presets, so all three compute spawns the same way.

import { getNextFixedSpawn, getNextWeeklySpawn, getNextBiweeklySpawn, getNextTwiceDailySpawn } from './spawn.js';

// Timer categories besides the default (boss): shared by create + edit validation.
export const CATEGORIES = new Set(['event', 'reset']);

export function nextSpawnFor(b, tz, now = Date.now()) {
  switch (b.type) {
    case 'interval': return now + (b.intervalMs || 3600000);
    case 'fixed': return getNextFixedSpawn(b.fixedTime, tz);
    case 'weekly': return getNextWeeklySpawn(b.weeklyDay, b.weeklyTime, tz);
    case 'biweekly': return getNextBiweeklySpawn(b.biweeklyDays, tz);
    case 'twicedaily': return getNextTwiceDailySpawn(b.twiceDailyTimes, tz);
    default: return now + 3600000;
  }
}

// -> { id, stmt } — stmt is a bound D1 statement, so callers can .run() one or batch() many.
// b.nextSpawnAt (screenshot import) starts the timer at a known spawn instead of from the rule.
export function bossInsertStmt(env, teamId, b, tz, now = Date.now()) {
  const nextSpawn = Number.isFinite(b.nextSpawnAt) ? b.nextSpawnAt : nextSpawnFor(b, tz, now);
  const alertMinutes = b.alertMinutes || 5;
  const warned = (nextSpawn - now) <= alertMinutes * 60000 ? 1 : 0;   // no instant "spawning soon" ping for a fresh timer
  const windowMs = Math.max(0, Math.min(86400000, parseInt(b.windowMs) || 0));
  const location = b.location ? String(b.location).trim().slice(0, 80) : null;
  const category = CATEGORIES.has(b.category) ? b.category : null; // null = boss (the default)
  const id = crypto.randomUUID();
  const stmt = env.DB.prepare(`INSERT INTO bosses (id, team_id, name, type, interval_ms, fixed_time, weekly_day, weekly_time, biweekly_days, alert_minutes, auto_reset_minutes, next_spawn, warned, window_ms, location, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, teamId, String(b.name).trim(), b.type || 'interval',
      b.intervalMs || null, b.fixedTime || null,
      b.weeklyDay ?? null, b.weeklyTime || null,
      b.biweeklyDays ? JSON.stringify(b.biweeklyDays) : b.twiceDailyTimes ? JSON.stringify(b.twiceDailyTimes) : null,
      alertMinutes, b.autoResetMinutes || 5, nextSpawn, warned, windowMs, location, category);
  return { id, stmt };
}
