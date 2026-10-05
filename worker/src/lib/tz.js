// Team-clock time math. The first Intl time-zone formatter built in a fresh isolate costs ~10 ms
// (ICU setup) = the whole free-plan CPU budget of a cron run, and cron runs mostly land on a fresh
// isolate. Zones that never change their UTC offset are plain arithmetic; any other zone (DST)
// asks Intl. Output matches Intl exactly (tests/unit/tz.test.mjs).

// Minutes east of UTC; only zones without daylight saving.
const FIXED = {
  'UTC': 0, 'Etc/UTC': 0, 'GMT': 0,
  'Asia/Manila': 480, 'Asia/Singapore': 480, 'Asia/Kuala_Lumpur': 480, 'Asia/Hong_Kong': 480,
  'Asia/Taipei': 480, 'Asia/Shanghai': 480, 'Asia/Makassar': 480, 'Australia/Perth': 480,
  'Asia/Tokyo': 540, 'Asia/Seoul': 540, 'Asia/Jayapura': 540,
  'Asia/Jakarta': 420, 'Asia/Bangkok': 420, 'Asia/Ho_Chi_Minh': 420, 'Asia/Saigon': 420,
  'Asia/Kolkata': 330, 'Asia/Calcutta': 330, 'Asia/Dubai': 240, 'Asia/Riyadh': 180,
};

const intlCache = new Map();
function intlOffset(ts, tz) {
  let f = intlCache.get(tz);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }); }
    catch { f = null; }   // unknown zone: UTC
    intlCache.set(tz, f);
  }
  if (!f) return 0;
  const p = f.formatToParts(new Date(ts)).reduce((a, x) => (a[x.type] = x.value, a), {});
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(ts / 60000) * 60000) / 60000);
}

// UTC offset of `tz` at `ts`, in minutes.
export const offsetMin = (ts, tz) => FIXED[tz] ?? intlOffset(ts, tz);

// A Date whose UTC fields read as the team-clock wall time at `ts` (use getUTC* on it).
export const wall = (ts, tz) => new Date(ts + offsetMin(ts, tz) * 60000);

// The instant whose team-clock wall time is `w` (a wall() Date or its ms). Wall times skipped or
// repeated by a DST change resolve with the offset in force just before them.
export function fromWall(w, tz) {
  const ms = +w;
  const first = ms - offsetMin(ms, tz) * 60000;
  return ms - offsetMin(first, tz) * 60000;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n) => String(n).padStart(2, '0');

// "2:04 AM" (as Intl en-US writes it on Workers: a plain space before AM/PM)
export function clockIn(ts, tz) {
  const d = wall(ts, tz), h = d.getUTCHours();
  return `${h % 12 || 12}:${pad(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}
// "29 September 2026"
export function dayLabel(ts, tz) {
  const d = wall(ts, tz);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
// "Wednesday 30 September"
export function weekdayLabel(ts, tz) {
  const d = wall(ts, tz);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
// "2026-09-29": the team-clock calendar day `ts` falls on
export const dayKey = (ts, tz) => wall(ts, tz).toISOString().slice(0, 10);
