// Aion 2 (Global client) rifts and world bosses. Built 2026-10-08 from the launch-week community
// schedules (aion2hub + rift timer sites). Everything here runs on the game's SERVER clock, so the
// team timezone in Settings must be set to the server's zone (Global cluster = GMT+9, Asia = GMT+8).
// All entries are fixed schedules — no kill logging needed; they reset on their own.

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
    { name: 'Watcher Kaira', type: 'twicedaily', twiceDailyTimes: times(1, 3, 8),
      location: 'Chaotic Lower Reshanta (random)', autoResetMinutes: 30 },
    // weekday bosses (0 = Sunday)
    { name: 'Executor Argo', type: 'biweekly', biweeklyDays: daysAt([1, 4, 6], '21:30'),
      location: 'Chaotic Lower Reshanta', autoResetMinutes: 30 },
    { name: 'Executor Kaira', type: 'biweekly', biweeklyDays: daysAt([1, 4, 6], '21:30'),
      location: 'Chaotic Lower Reshanta', autoResetMinutes: 30 },
    { name: 'Executor Tamasa', type: 'biweekly', biweeklyDays: daysAt([1, 4, 6], '21:30'),
      location: 'Chaotic Lower Reshanta', autoResetMinutes: 30 },
    { name: 'Abyss Siege Boss (Nahma)', type: 'biweekly', biweeklyDays: daysAt([0, 5], '21:00'),
      location: 'Reshanta — after Abyss siege', autoResetMinutes: 30 },
  ],
};
