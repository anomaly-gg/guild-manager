// Aion 2 (Global client) rifts and world bosses. Boss times verified 2026-10-08 against the
// in-game Abyss timer list (Asia > Meslamtaeda) — the launch-week community schedules were off
// (Watcher Kaira runs on the 00:00 grid, executors spawn 20:35, Nahma 20:05). Everything here runs
// on the game's SERVER clock, so the team timezone in Settings must be set to the server's zone
// (Global cluster = GMT+9, Asia = GMT+8).
// All entries are fixed schedules — no kill logging needed; they reset on their own.
// Not included: "Argo, the Spirit King" — its in-game countdown lands on no fixed grid
// (kill-based respawn); teams can add it as an interval boss once they know the respawn time.

const times = (start, stepH, count) =>
  Array.from({ length: count }, (_, i) => `${String((start + i * stepH) % 24).padStart(2, '0')}:00`);
const daysAt = (days, time) => days.map(day => ({ day, time }));

export const AION2 = {
  id: 'aion2',
  game: 'Aion 2',
  note: 'Times are server time — set the team timezone in Settings to your server\'s clock (Global = GMT+9, Asia = GMT+8). The Mon/Thu/Sat 20:00 and 23:00 rifts are also the Rift Domination (PvP) entry. Fixed schedules reset on their own; no kill logging needed.',
  bosses: [
    // every 3 hours, 8× a day
    { name: 'Spacetime Rift', type: 'twicedaily', twiceDailyTimes: times(2, 3, 8),
      location: 'Random spot — purple map marker', alertMinutes: 10, autoResetMinutes: 10 },
    { name: 'Watcher Kaira', type: 'twicedaily', twiceDailyTimes: times(0, 3, 8),
      location: 'Chaotic Lower Reshanta (random)', autoResetMinutes: 30 },
    // weekday bosses (0 = Sunday)
    { name: 'Executor Argo', type: 'biweekly', biweeklyDays: daysAt([1, 4, 6], '20:35'),
      location: 'Chaotic Lower Reshanta', autoResetMinutes: 30 },
    { name: 'Executor Kaira', type: 'biweekly', biweeklyDays: daysAt([1, 4, 6], '20:35'),
      location: 'Chaotic Lower Reshanta', autoResetMinutes: 30 },
    { name: 'Executor Tamasa', type: 'biweekly', biweeklyDays: daysAt([1, 4, 6], '20:35'),
      location: 'Chaotic Lower Reshanta', autoResetMinutes: 30 },
    { name: 'Abyss Siege Boss (Nahma)', type: 'biweekly', biweeklyDays: daysAt([0, 5], '20:05'),
      location: 'Reshanta — after Abyss siege', autoResetMinutes: 30 },
  ],
};
