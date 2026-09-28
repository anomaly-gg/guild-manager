// Boss schedule text for Discord, in the guild schedule-post style:
//   `2:04 AM ` | Lady Dalia | @Kongreso
// Used by /next (day headers, upcoming only) and the daily schedule post (one day, with finished
// spawns crossed out). No DB, no network.

import { groupTag } from './spawn-groups.js';
import { spawnsInWindow } from './spawn-projection.js';

// Intl formatters are costly to build; the cron renders every linked team each minute, so cache per zone.
const fmtCache = new Map();
function formatter(kind, tz) {
  const key = kind + '|' + tz;
  if (!fmtCache.has(key)) {
    const opts = {
      time: ['en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }],
      label: ['en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }],
      key: ['en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }],
    }[kind];
    fmtCache.set(key, new Intl.DateTimeFormat(...opts));
  }
  return fmtCache.get(key);
}
const safeTz = (tz) => { try { formatter('key', tz); return tz; } catch { return 'UTC'; } };

export function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

// "2:04 AM" in the team clock. ICU puts a narrow no-break space before AM/PM; keep it, it renders fine.
export const clockIn = (ts, tz) => formatter('time', safeTz(tz)).format(new Date(ts));
// "29 September 2026"
export const dayLabel = (ts, tz) => formatter('label', safeTz(tz)).format(new Date(ts));
// "2026-09-29": the team-clock calendar day a timestamp falls on (schedule post / spawn record key).
export const dayKey = (ts, tz) => formatter('key', safeTz(tz)).format(new Date(ts));

// ---- rows

// Live state of a boss row at `now` (same rules as the web timer cards).
export function bossState(boss, now) {
  const remaining = boss.next_spawn - now;
  const windowMs = boss.window_ms || 0;
  if (boss.status === 'spawned' || remaining <= 0) {
    if (windowMs > 0 && now < boss.next_spawn + windowMs) return { key: 'window', remaining, windowLeft: boss.next_spawn + windowMs - now };
    return { key: 'spawned', remaining };
  }
  return { key: 'waiting', remaining };
}

// Spawns closer together than this share a block; a wider gap gets a dashed divider.
const BLOCK_GAP_MS = 30 * 60000;
const DIVIDER = '-'.repeat(33);
const TIME_WIDTH = 8;   // "11:30 PM"; shorter times are padded with no-break spaces so the code pills line up

// row: { at, name, location?, tag?, state: 'waiting' | 'spawned' | 'window' | 'dead' | 'reset', windowLeft? }
function rowText(r, tz) {
  const cells = [`\`${clockIn(r.at, tz).padEnd(TIME_WIDTH, ' ')}\``, r.name];
  if (r.location) cells.push(r.location);
  if (r.tag) cells.push(r.tag);
  const line = cells.join(' | ');
  if (r.state === 'dead') return `~~${line}~~ — dead`;
  if (r.state === 'reset') return `~~${line}~~ — auto-reset`;
  if (r.state === 'spawned') return `${line} | 🔴 UP`;
  if (r.state === 'window') return `${line} | 🟠 window, ${fmtDuration(r.windowLeft)} left`;
  return line;
}

// Rows (already in display order) -> lines, with a divider between blocks. `headers` adds a bold
// day line whenever the calendar day changes (rows may carry `header` to override the day label).
export function scheduleLines(rows, tz, { headers = false } = {}) {
  const out = [];
  let day = null, prev = null;
  for (const r of rows) {
    const d = headers ? (r.header || dayLabel(r.at, tz)) : null;
    if (headers && d !== day) {
      if (day !== null) out.push('');
      out.push(`**${d}**`);
      day = d; prev = null;
    } else if (prev !== null && r.at - prev > BLOCK_GAP_MS) {
      out.push(DIVIDER);
    }
    prev = r.at;
    out.push(rowText(r, tz));
  }
  return out;
}

// Rows for one boss: its live next spawn (with up/window state) and, inside [from, until), the
// spawns projected after it, each with its own group.
function bossRows(b, now, from, until, tz, groups) {
  return spawnsInWindow(b, from, until, tz, groups).map(sp => {
    const st = sp.index === 0 ? bossState(b, now) : { key: 'waiting' };
    return { at: sp.at, index: sp.index, name: b.name, location: b.location, tag: groupTag(groups, sp.groupId), state: st.key, windowLeft: st.windowLeft };
  });
}

// /next: up-now bosses first, then every spawn in the next 24 h, soonest first, under day headers.
export function nextSpawnsText(bosses, tz, now = Date.now(), limit = 10, groups = []) {
  const rank = { spawned: 0, window: 0, waiting: 1 };
  const rows = bosses.flatMap(b => bossRows(b, now, now, now + 86400000, tz, groups))
    .sort((x, y) => (rank[x.state] - rank[y.state]) || (x.at - y.at))
    .slice(0, limit)
    .map(r => r.state === 'waiting' ? r : { ...r, header: 'Up now' });
  if (!rows.length) return 'No boss timers yet. Add some in Guild Manager → Timers.';
  return scheduleLines(rows, tz, { headers: true }).join('\n');
}

// 00:00 of a YYYY-MM-DD day in the team zone, as epoch ms.
export function dayStart(key, tz) {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const offset = (ts) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(ts)).reduce((a, x) => (a[x.type] = x.value, a), {});
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - ts;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

// Daily post body for calendar day `day` (dayKey): finished spawns recorded that day + every spawn
// still to come that day (repeat spawns of short-timer bosses included), plus, on today's post,
// anything up right now; in time order.
export function dayScheduleText(day, bosses, ended, tz, now = Date.now(), groups = []) {
  const today = day === dayKey(now, tz);
  const from = dayStart(day, tz), until = from + 86400000 + 3600000;   // +1 h absorbs a DST day; dayKey below decides
  const live = bosses.flatMap(b => bossRows(b, now, from, until, tz, groups))
    .filter(r => dayKey(r.at, tz) === day || (today && r.index === 0 && r.state !== 'waiting'));
  const rows = [
    ...ended.map(e => ({ at: e.spawn_at, name: e.boss_name, location: e.location, tag: groupTag(groups, e.group_id), state: e.outcome })),
    ...live,
  ].sort((x, y) => x.at - y.at);
  if (!rows.length) return 'No spawns on the schedule for this day.';
  return scheduleLines(rows, tz).join('\n');
}
