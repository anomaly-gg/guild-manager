// Boss schedule text for Discord, one line per spawn:
//   `3:05 PM ` **Baron Braudmore** @Senado 🔴 up 15 minutes ago
//   -# ~~`1:30 PM ` Araneo · Kongreso~~ ✓
// Used by /next (day headers, upcoming only) and the daily schedule post (one day, finished spawns
// packed at the top in small grey text). No DB, no network.

import { groupTag, groupName } from './spawn-groups.js';
import { spawnsInWindow } from './spawn-projection.js';
import { clockIn, dayLabel, weekdayLabel, dayKey, fromWall } from './tz.js';

// Team-clock formatting lives in lib/tz.js (no Intl for fixed-offset zones: cron CPU).
export { clockIn, dayLabel, weekdayLabel, dayKey };

export function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

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

const TIME_WIDTH = 8;   // "11:30 PM"; shorter times are padded with no-break spaces so the code pills line up
const FINISHED = new Set(['dead', 'reset']);

// <t:…:R> is drawn by each reader's Discord ("in 4 hours", "15 minutes ago") and keeps counting
// between edits, so the post never shows a stale countdown.
const relTime = (ts) => `<t:${Math.floor(ts / 1000)}:R>`;

// row: { at, name, location?, tag?, group?, state: 'waiting' | 'spawned' | 'window' | 'dead' | 'reset',
//        windowEnd?, next? }. Finished spawns shrink to grey subtext with the plain group name.
function rowText(r, tz) {
  const time = `\`${clockIn(r.at, tz).padEnd(TIME_WIDTH, ' ')}\``;
  const where = r.location ? ` · ${r.location}` : '';
  if (FINISHED.has(r.state)) {
    const who = r.group ? ` · ${r.group}` : '';
    return `-# ~~${time} ${r.name}${where}${who}~~ ${r.state === 'dead' ? '✓' : '↺ auto-reset'}`;
  }
  const line = `${time} **${r.name}**${where}${r.tag ? ' ' + r.tag : ''}`;
  if (r.state === 'spawned') return `${line} 🔴 up ${relTime(r.at)}`;
  if (r.state === 'window') return `${line} 🟠 window closes ${relTime(r.windowEnd)}`;
  if (r.next) return `${line} ⏳ next, ${relTime(r.at)}`;
  return line;
}

// Rows (already in display order) -> lines. A block = one group's run of spawns, however far apart:
// a blank line only where the group changes (rows without a group count as one "no group" group).
// Finished lines stay packed. `headers` adds a bold day line whenever the calendar day changes (rows may carry
// `header` to override the day label).
export function scheduleLines(rows, tz, { headers = false } = {}) {
  const out = [];
  let day = null, prev = null;
  for (const r of rows) {
    const d = headers ? (r.header || dayLabel(r.at, tz)) : null;
    if (headers && d !== day) {
      if (day !== null) out.push('');
      out.push(`**${d}**`);
      day = d; prev = null;
    } else if (prev && !(FINISHED.has(prev.state) && FINISHED.has(r.state)) && (prev.tag || '') !== (r.tag || '')) {
      out.push('');
    }
    prev = r;
    out.push(rowText(r, tz));
  }
  return out;
}

// Rows for one boss: its live next spawn (with up/window state) and, inside [from, until), the
// spawns projected after it, each with its own group.
function bossRows(b, now, from, until, tz, groups) {
  return spawnsInWindow(b, from, until, tz, groups).map(sp => {
    const st = sp.index === 0 ? bossState(b, now) : { key: 'waiting' };
    return { at: sp.at, index: sp.index, name: b.name, location: b.location, tag: groupTag(groups, sp.groupId), state: st.key, windowEnd: st.key === 'window' ? now + st.windowLeft : undefined };
  });
}

// Flags the soonest spawn still to come (rows in time order) so it carries the countdown.
function markNext(rows) {
  const i = rows.findIndex(r => r.state === 'waiting');
  return i < 0 ? rows : rows.map((r, j) => j === i ? { ...r, next: true } : r);
}

// /next: up-now bosses first, then every spawn in the next 24 h, soonest first, under day headers.
export function nextSpawnsText(bosses, tz, now = Date.now(), limit = 10, groups = []) {
  const rank = { spawned: 0, window: 0, waiting: 1 };
  const rows = bosses.flatMap(b => bossRows(b, now, now, now + 86400000, tz, groups))
    .sort((x, y) => (rank[x.state] - rank[y.state]) || (x.at - y.at))
    .slice(0, limit)
    .map(r => r.state === 'waiting' ? r : { ...r, header: 'Up now' });
  if (!rows.length) return 'No boss timers yet. Add some in Guild Manager → Timers.';
  return scheduleLines(markNext(rows), tz, { headers: true }).join('\n');
}

// 00:00 of a YYYY-MM-DD day in the team zone, as epoch ms.
export function dayStart(key, tz) {
  const [y, m, d] = key.split('-').map(Number);
  return fromWall(Date.UTC(y, m - 1, d), tz);
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
    ...ended.map(e => ({ at: e.spawn_at, name: e.boss_name, location: e.location, group: groupName(groups, e.group_id), state: e.outcome })),
    ...live,
  ].sort((x, y) => x.at - y.at);
  if (!rows.length) return 'No spawns on the schedule for this day.';
  return fitScheduleText(today ? markNext(rows) : rows, tz);
}

// Discord's cap on an embed description.
export const EMBED_TEXT_MAX = 4096;

// "-# ✅ 9 done · 🔴 2 up · ⏳ 6 to go" (zero counts left out), over the whole day even when lines are cut.
function summaryLine(rows) {
  const n = (test) => rows.filter(test).length;
  const parts = [
    [n(r => FINISHED.has(r.state)), '✅', 'done'],
    [n(r => r.state === 'spawned' || r.state === 'window'), '🔴', 'up'],
    [n(r => r.state === 'waiting'), '⏳', 'to go'],
  ].filter(([c]) => c).map(([c, icon, word]) => `${icon} ${c} ${word}`);
  return '-# ' + parts.join('  ·  ');
}

// The day's rows as text no longer than `max`: a summary line, finished spawns packed at the top,
// then what is up and still to come. A day too long for one embed (every boss respawning after
// maintenance) sheds the oldest finished lines first, then the latest spawns still to come, each
// replaced by a count; bosses up right now always stay. The post is edited on every spawn, kill
// and auto-reset, so the visible window moves down the day by itself.
export function fitScheduleText(rows, tz, max = EMBED_TEXT_MAX) {
  const finished = rows.filter(r => FINISHED.has(r.state));   // rows are in time order: oldest first
  const rest = rows.filter(r => !FINISHED.has(r.state));
  const upcoming = rest.filter(r => r.state === 'waiting');
  const head = [summaryLine(rows), ''];
  const render = (dropEarlier, dropLater) => {
    const gone = new Set([...finished.slice(0, dropEarlier), ...upcoming.slice(upcoming.length - dropLater)]);
    const lines = scheduleLines([...finished, ...rest].filter(r => !gone.has(r)), tz);
    if (dropEarlier) lines.unshift(`-# … ${dropEarlier} earlier ${dropEarlier === 1 ? 'spawn' : 'spawns'} finished`);
    if (dropLater) lines.push(`-# … ${dropLater} more coming later today`);
    return [...head, ...lines].join('\n');
  };
  let text = render(0, 0);
  for (let e = 1; text.length > max && e <= finished.length; e++) text = render(e, 0);
  for (let l = 1; text.length > max && l <= upcoming.length; l++) text = render(finished.length, l);
  return text;
}
