// Lord Nine world bosses. Built 2026-09-23 from the two live guild lists (36 + 19 timers, merged).
// Respawn intervals count from the kill you log; day/time bosses follow the SEA server calendar
// in the team's timezone (Asia/Manila unless changed in Settings). Days: 0 = Sunday.

const H = 3600000;
const interval = (name, hours, location) => ({ name, type: 'interval', intervalMs: hours * H, location });
const weekly = (name, weeklyDay, weeklyTime, location) => ({ name, type: 'weekly', weeklyDay, weeklyTime, location });
const biweekly = (name, days, location) => ({ name, type: 'biweekly', biweeklyDays: days.map(([day, time]) => ({ day, time })), location });

export const LORD_NINE = {
  id: 'lordnine',
  game: 'Lord Nine',
  // one cluster: the SEA calendar the boss list was built from (sets the team timezone on setup)
  clusters: [{ label: 'SEA (GMT+8)', tz: 'Asia/Manila' }],
  note: 'Respawn timers start counting when you log the first kill. Day/time bosses use the SEA server schedule in your team timezone; check the ones that differ on your server.',
  bosses: [
    // respawn after kill
    interval('Venatus', 10),
    interval('Viorent', 10, 'Ancient Sanctum'),
    interval('Lady Dalia', 18),
    interval('Ego', 21),
    interval('Araneo', 24, 'Lower Tomb of Tyriosa 1F'),
    interval('Livera', 24),
    interval('Undomiel', 24, 'Secret Laboratory'),
    interval('Amentis', 29),
    interval('General Aquleus', 29),
    interval('Baron Braudmore', 32),
    interval('Gareth', 32),
    interval('Catena', 35),
    interval('Larba', 35),
    interval('Shuliar', 35),
    interval('Titore', 37),
    interval('Duplican', 48),
    interval('Metus', 48),
    interval('Wannitas', 48),
    interval('Asta', 62),
    interval('Ordo', 62),
    interval('Secreta', 62),
    interval('Supore', 62),
    // twice a day
    { name: 'Ratan / Parto / Nedra', type: 'twicedaily', twiceDailyTimes: ['11:00', '20:00'] },
    // once a week
    weekly('Roderick', 5, '19:00'),
    weekly('Milavy', 6, '15:00'),
    weekly('Ringor', 6, '17:00'),
    weekly('Chaiflock', 6, '22:00'),
    weekly('Lucus', 6, '22:00'),
    weekly('Tumier', 0, '19:00'),
    weekly('Benji', 0, '21:00'),
    weekly('Nevaeh', 0, '22:00'),
    weekly('Camalia', 4, '21:00'),
    // twice a week
    biweekly('Clemantis', [[1, '11:30'], [4, '19:00']], 'Dien'),
    biweekly('Thymele', [[1, '19:00'], [3, '11:30']]),
    biweekly('Libitina', [[1, '21:00'], [6, '21:00']]),
    biweekly('Neutro', [[2, '19:00'], [4, '11:30']]),
    biweekly('Icaruthia', [[2, '21:00'], [5, '21:00']], 'Kransia'),
    biweekly('Rakajeth', [[2, '22:00'], [0, '19:00']]),
    biweekly('Saphirus', [[0, '17:00'], [2, '11:30']], 'Lindris'),
    biweekly('Motti', [[3, '19:00'], [6, '19:00']], 'Kransia'),
    biweekly('Auraq', [[5, '22:00'], [3, '21:00']]),
  ],
};
