// Boss spawn-time math (all in the team's timezone). `from` (default: now) lets the daily schedule
// project later spawns: the first spawn strictly after that moment.

import { wall, fromWall } from './tz.js';

export function getNextFixedSpawn(timeStr, tz, from = Date.now()) {
  const [h, m] = timeStr.split(':').map(Number);
  const local = wall(from, tz);
  const spawn = new Date(local);
  spawn.setUTCHours(h, m, 0, 0);
  if (spawn <= local) spawn.setUTCDate(spawn.getUTCDate() + 1);
  return fromWall(spawn, tz);
}

export function getNextWeeklySpawn(targetDay, timeStr, tz, from = Date.now()) {
  const [h, m] = timeStr.split(':').map(Number);
  const local = wall(from, tz);
  const spawn = new Date(local);
  spawn.setUTCHours(h, m, 0, 0);
  let daysUntil = targetDay - local.getUTCDay();
  if (daysUntil < 0) daysUntil += 7;
  if (daysUntil === 0 && spawn <= local) daysUntil = 7;
  spawn.setUTCDate(spawn.getUTCDate() + daysUntil);
  return fromWall(spawn, tz);
}

export function getNextBiweeklySpawn(days, tz, from = Date.now()) {
  const parsed = typeof days === 'string' ? JSON.parse(days) : days;
  return Math.min(...parsed.map(d => getNextWeeklySpawn(d.day, d.time, tz, from)));
}

export function getNextTwiceDailySpawn(times, tz, from = Date.now()) {
  if (!times) return from + 3600000;
  const parsed = typeof times === 'string' ? JSON.parse(times) : times;
  if (!Array.isArray(parsed) || parsed.length === 0) return from + 3600000;
  const spawns = parsed.map(t => getNextFixedSpawn(t, tz, from));
  return Math.min(...spawns);
}

export function calcNextSpawn(boss, fromTime, tz) {
  if (boss.type === 'interval') return fromTime + boss.interval_ms;
  if (boss.type === 'fixed') return getNextFixedSpawn(boss.fixed_time, tz);
  if (boss.type === 'weekly') return getNextWeeklySpawn(boss.weekly_day, boss.weekly_time, tz);
  if (boss.type === 'biweekly') return getNextBiweeklySpawn(boss.biweekly_days, tz);
  if (boss.type === 'twicedaily') return getNextTwiceDailySpawn(boss.biweekly_days, tz);
  return fromTime + 3600000;
}

// How long a boss that is up waits for a kill before it auto-resets. A maintenance reset brings
// every respawn-timer boss up at once (next_spawn = the team's maintenance_at) and the guild clears
// them one by one, the last ~30 min after server open, so those spawns wait at least that long.
export const MAINTENANCE_RESET_MS = 30 * 60000;
export function autoResetMs(boss, maintenanceAt) {
  const ms = boss.window_ms > 0 ? boss.window_ms : (boss.auto_reset_minutes ?? 5) * 60000;
  return maintenanceAt && boss.next_spawn === maintenanceAt ? Math.max(ms, MAINTENANCE_RESET_MS) : ms;
}

// The spawn after the one at `t`, assuming it is killed when it comes up (schedule projection).
export function spawnAfter(boss, t, tz) {
  switch (boss.type) {
    case 'interval': return boss.interval_ms > 0 ? t + boss.interval_ms : null;
    case 'fixed': return boss.fixed_time ? getNextFixedSpawn(boss.fixed_time, tz, t) : null;
    case 'weekly': return boss.weekly_time ? getNextWeeklySpawn(boss.weekly_day, boss.weekly_time, tz, t) : null;
    case 'biweekly': return boss.biweekly_days ? getNextBiweeklySpawn(boss.biweekly_days, tz, t) : null;
    case 'twicedaily': return boss.biweekly_days ? getNextTwiceDailySpawn(boss.biweekly_days, tz, t) : null;
    default: return null;
  }
}
