// Every spawn of a boss inside a time window, for the daily schedule post and /next: the live
// next spawn, then the ones after it assuming each is killed when it comes up (lib/spawn.js
// spawnAfter). Later ones are estimates and move by themselves when the real kill is logged.

import { spawnAfter } from './spawn.js';
import { groupsForSpawns } from './spawn-groups.js';

const MAX_PER_BOSS = 12;

// -> [{ at, index, groupId }]: index 0 = the live next spawn, always included (callers decide
// whether it belongs on their view); later ones only when at is in [from, until).
export function spawnsInWindow(boss, from, until, tz, groups) {
  const times = [];
  let t = boss.next_spawn;
  while (t != null && (times.length === 0 || t < until) && times.length < MAX_PER_BOSS) {
    times.push(t);   // the live next spawn always; the projected ones only inside the window
    const n = spawnAfter(boss, t, tz);
    if (n == null || n <= t) break;
    t = n;
  }
  const g = groupsForSpawns(boss, groups, times.length);
  return times.map((at, index) => ({ at, index, groupId: g[index] })).filter(s => s.index === 0 || s.at >= from);
}
