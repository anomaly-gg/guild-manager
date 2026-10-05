// lib/tz.js (team-clock math without Intl for fixed-offset zones) must match what Intl gives:
// formats, day keys/starts, and the fixed/weekly spawn math it replaced in lib/spawn.js.
// Run: node tests/unit/tz.test.mjs
process.env.TZ = 'UTC';   // the old spawn math assumed a UTC process clock, as on Workers

const { clockIn, dayLabel, weekdayLabel, dayKey, offsetMin } = await import('../../worker/src/lib/tz.js');
const { dayStart } = await import('../../worker/src/lib/schedule-format.js');
const { getNextFixedSpawn, getNextWeeklySpawn } = await import('../../worker/src/lib/spawn.js');

const checks = [];
const check = (name, cond, info = '') => { checks.push(!!cond); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : `   <- ${JSON.stringify(info).slice(0, 400)}`)); };

const FIXED = ['UTC', 'Etc/UTC', 'GMT', 'Asia/Manila', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Shanghai',
  'Asia/Makassar', 'Australia/Perth', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Jayapura', 'Asia/Jakarta', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh',
  'Asia/Saigon', 'Asia/Kolkata', 'Asia/Calcutta', 'Asia/Dubai', 'Asia/Riyadh'];
const DST = ['America/New_York', 'Europe/London', 'Australia/Sydney', 'America/Los_Angeles'];
const safe = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; } };

// ---- the Intl versions this replaced (schedule-format.js / spawn.js before 2026-10-05)
const ref = {
  clockIn: (ts, tz) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: safe(tz) }).format(new Date(ts)),
  dayLabel: (ts, tz) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: safe(tz) }).format(new Date(ts)),
  weekdayLabel: (ts, tz) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: safe(tz) }).format(new Date(ts)),
  dayKey: (ts, tz) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: safe(tz) }).format(new Date(ts)),
  dayStart(key, tz) {
    const [y, m, d] = key.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d);
    const offset = (ts) => {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
        .formatToParts(new Date(ts)).reduce((a, x) => (a[x.type] = x.value, a), {});
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - ts;
    };
    return guess - offset(guess - offset(guess));
  },
  fixed(timeStr, tz, from) {
    const [h, m] = timeStr.split(':').map(Number);
    const now = new Date(from), local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const spawn = new Date(local); spawn.setHours(h, m, 0, 0);
    if (spawn <= local) spawn.setDate(spawn.getDate() + 1);
    return spawn.getTime() + (now.getTime() - local.getTime());
  },
  weekly(targetDay, timeStr, tz, from) {
    const [h, m] = timeStr.split(':').map(Number);
    const now = new Date(from), local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const spawn = new Date(local); spawn.setHours(h, m, 0, 0);
    let daysUntil = targetDay - local.getDay();
    if (daysUntil < 0) daysUntil += 7;
    if (daysUntil === 0 && spawn <= local) daysUntil = 7;
    spawn.setDate(spawn.getDate() + daysUntil);
    return spawn.getTime() + (now.getTime() - local.getTime());
  },
};

// deterministic pseudo-random instants, 2024..2032, plus exact minute/midnight edges
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const START = Date.UTC(2024, 0, 1), SPAN = Date.UTC(2032, 0, 1) - START;
const instants = Array.from({ length: 1500 }, () => START + Math.floor(rnd() * SPAN));
for (let i = 0; i < 60; i++) instants.push(START + Math.floor(rnd() * 3000) * 86400000 + Math.floor(rnd() * 24) * 3600000);

function sweep(zones, name, fn, refFn) {
  const bad = [];
  for (const tz of zones) for (const ts of instants) {
    const a = fn(ts, tz), b = refFn(ts, tz);
    if (a !== b) bad.push({ tz, ts, got: a, want: b });
  }
  check(`${name} matches Intl (${zones.length} zones x ${instants.length} instants)`, !bad.length, bad.slice(0, 3));
}
const ALL = [...FIXED, ...DST, 'Not/AZone'];
sweep(ALL, 'clockIn', clockIn, ref.clockIn);
sweep(ALL, 'dayLabel', dayLabel, ref.dayLabel);
sweep(ALL, 'weekdayLabel', weekdayLabel, ref.weekdayLabel);
sweep(ALL, 'dayKey', dayKey, ref.dayKey);

// fixed zones really are fixed: Intl agrees on the offset at every instant
{
  const bad = [];
  for (const tz of FIXED) for (const ts of instants.slice(0, 400)) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(ts)).reduce((a, x) => (a[x.type] = x.value, a), {});
    const want = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(ts / 60000) * 60000) / 60000);
    if (offsetMin(ts, tz) !== want) bad.push({ tz, ts, got: offsetMin(ts, tz), want });
  }
  check('fixed-offset table agrees with Intl', !bad.length, bad.slice(0, 3));
}

{
  const bad = [];
  for (const tz of [...FIXED, ...DST]) for (const ts of instants.slice(0, 300)) {
    const key = ref.dayKey(ts, tz);
    if (dayStart(key, tz) !== ref.dayStart(key, tz)) bad.push({ tz, key, got: dayStart(key, tz), want: ref.dayStart(key, tz) });
  }
  check('dayStart matches the Intl version', !bad.length, bad.slice(0, 3));
}

// spawn math: same instant as before (the old code also carried the milliseconds of `from`)
{
  const bad = [];
  const times = ['00:00', '03:30', '11:59', '12:00', '19:00', '23:45'];
  for (const tz of FIXED) for (const from of instants.slice(0, 250)) for (const t of times) {
    const want = ref.fixed(t, tz, from) - (from % 1000);
    if (getNextFixedSpawn(t, tz, from) !== want) bad.push({ tz, from, t, got: getNextFixedSpawn(t, tz, from), want });
    const day = from % 7;
    const wantW = ref.weekly(day, t, tz, from) - (from % 1000);
    if (getNextWeeklySpawn(day, t, tz, from) !== wantW) bad.push({ tz, from, t, day, got: getNextWeeklySpawn(day, t, tz, from), want: wantW });
  }
  check('fixed + weekly spawns match the old math in fixed zones', !bad.length, bad.slice(0, 3));
}
{
  // DST zones: the next spawn is on the asked wall time / weekday, after `from`, within a day / a week
  const bad = [];
  for (const tz of DST) for (const from of instants.slice(0, 250)) {
    const s = getNextFixedSpawn('19:00', tz, from);
    if (!(s > from && s - from <= 25 * 3600000 && ref.clockIn(s, tz) === '7:00 PM')) bad.push({ tz, from, s, clock: ref.clockIn(s, tz) });
    const w = getNextWeeklySpawn(3, '21:30', tz, from);
    const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(new Date(w));
    if (!(w > from && w - from <= 7 * 86400000 + 3600000 && wd === 'Wed' && ref.clockIn(w, tz) === '9:30 PM')) bad.push({ tz, from, w, wd });
  }
  check('DST zones: spawns land on the asked wall time and weekday', !bad.length, bad.slice(0, 3));
}

// cost: none of the fixed-zone paths may build an Intl formatter
{
  const real = Intl.DateTimeFormat; let built = 0;
  Intl.DateTimeFormat = function (...a) { built++; return new real(...a); };
  const ts = Date.now();
  clockIn(ts, 'Asia/Manila'); dayLabel(ts, 'Asia/Manila'); weekdayLabel(ts, 'Asia/Manila'); dayKey(ts, 'Asia/Manila');
  dayStart('2026-10-05', 'Asia/Manila'); getNextFixedSpawn('19:00', 'Asia/Manila', ts); getNextWeeklySpawn(2, '21:00', 'Asia/Manila', ts);
  Intl.DateTimeFormat = real;
  check('Asia/Manila never touches Intl', built === 0, built);
}

console.log(`${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
