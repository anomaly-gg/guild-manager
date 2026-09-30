// Which bosses a maintenance reset brings up at server open (routes/maintenance-reset.js).
// The window is [from, openAt): the server was down from `from` until it opened at `openAt`.
//   - every respawn-timer (interval) boss: after maintenance they all spawn when the server opens
//   - a fixed-schedule boss (daily / weekly / twice-daily / two days a week) whose spawn fell inside
//     the window: in game it is up when the server opens. Here it is either still waiting for that
//     spawn, shown up with no kill, or already auto-reset by us while the server was down (its
//     schedule_spawns 'reset' row in the window); all three come back as up at open.
// A boss with a kill logged after the server opened is left alone: the reset was pressed late and
// that kill is real. After the kill each boss goes back to its own rule (lib/spawn.js calcNextSpawn).

// bosses: rows of the team; resets: schedule_spawns rows { id, boss_id, spawn_at } with outcome 'reset'
// and spawn_at in the window. from = null: respawn timers only (the dialog before windows existed).
// -> { up, fixed, kept, killed } (boss rows), resetRows (ids of the in-window auto-resets to drop)
export function planReset(bosses, resets, { from, openAt }) {
  const inWindow = (t) => from != null && t != null && t >= from && t < openAt;
  const autoReset = new Set(resets.filter(r => inWindow(r.spawn_at)).map(r => r.boss_id));
  const up = [], fixed = [], kept = [], killed = [];
  for (const b of bosses) {
    if (b.last_death != null && b.last_death >= openAt) killed.push(b);
    else if (b.type === 'interval') up.push(b);
    else if (inWindow(b.next_spawn) || (autoReset.has(b.id) && !(b.last_death >= from))) fixed.push(b);
    else kept.push(b);
  }
  const brought = new Set([...up, ...fixed].map(b => b.id));
  const resetRows = resets.filter(r => inWindow(r.spawn_at) && brought.has(r.boss_id)).map(r => r.id);
  return { up, fixed, kept, killed, resetRows };
}
