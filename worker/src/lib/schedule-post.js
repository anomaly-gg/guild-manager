// Daily boss schedule post: one Discord webhook message per team-clock day, posted at 00:00 and
// edited in place whenever a spawn comes up, is killed or auto-resets, or a timer/group changes.
// State lives on team_settings (webhook_schedule, schedule_day + schedule_msg_id for today's
// message, schedule_prev_day + schedule_prev_msg_id for yesterday's); finished spawns are
// recorded in schedule_spawns so the day's post can keep them, crossed out.

import { isValidDiscordWebhook } from './discord.js';
import { dayKey, dayLabel, dayScheduleText } from './schedule-format.js';
import { parseGroups } from './spawn-groups.js';

const KEEP_DAYS = 3;
const EARLY_SPAWN_SLACK_MS = 6 * 3600000;

// Statement recording a finished spawn; the caller batches it with the boss update.
// The spawn a kill belongs to is the timer's spawn time when that has come (within the last 6 h);
// otherwise (killed before the timer said, or the first kill of an untracked boss) the kill time.
export function spawnEndStmt(env, { teamId, boss, outcome, endedAt, tz }) {
  const due = boss.next_spawn;
  const spawnAt = due <= endedAt && endedAt - due <= EARLY_SPAWN_SLACK_MS ? due : endedAt;
  const day = dayKey(spawnAt, tz);
  return {
    day,
    stmt: env.DB.prepare('INSERT INTO schedule_spawns (id, team_id, boss_id, boss_name, location, spawn_at, day, outcome, group_id, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), teamId, boss.id, boss.name, boss.location || null, spawnAt, day, outcome, boss.spawn_group || null, endedAt),
  };
}

// Noon UTC on a YYYY-MM-DD key, formatted in UTC = that calendar date regardless of zone.
const labelForKey = (key) => dayLabel(Date.parse(key + 'T12:00:00Z'), 'UTC');

function payload(teamName, day, text, tz) {
  return {
    embeds: [{
      title: `${teamName} — ${labelForKey(day)}`.slice(0, 256),
      description: text.length > 4096 ? text.slice(0, 4090) + '\n…' : text,
      color: 0x5865f2,
      footer: { text: `Team time (${tz}) · updates live · Guild Manager` },
    }],
    allowed_mentions: { parse: [] },
  };
}

// -> { ok, id?, status }. DISCORD_API (local harness only) swaps the host for the mock Discord.
async function webhookCall(env, hook, method, msgId, body) {
  const base = env.DISCORD_API ? hook.replace(/^https:\/\/(discord|discordapp)\.com\/api/, env.DISCORD_API) : hook;
  const url = msgId ? `${base}/messages/${msgId}` : `${base}?wait=true`;
  try {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { console.error('schedule post', method, r.status, (await r.text().catch(() => '')).slice(0, 200)); return { ok: false, status: r.status }; }
    const d = method === 'POST' ? await r.json().catch(() => ({})) : {};
    return { ok: true, id: d.id, status: r.status };
  } catch (e) {
    console.error('schedule post failed:', e);
    return { ok: false, status: 0 };
  }
}
// 4xx other than 429 = the webhook or message is gone/invalid; anything else is worth retrying.
const permanent = (status) => status >= 400 && status < 500 && status !== 429;

// Bring the team's schedule post up to date. `touchedDay` = the day of a spawn that just finished,
// so yesterday's message is edited too when a late-night spawn is killed after midnight.
export async function refreshSchedulePost(env, teamId, { touchedDay } = {}) {
  const s = await env.DB.prepare('SELECT t.name AS team_name, ts.* FROM team_settings ts JOIN teams t ON t.id = ts.team_id WHERE ts.team_id = ?').bind(teamId).first();
  if (!s?.webhook_schedule || !isValidDiscordWebhook(s.webhook_schedule)) return;
  const tz = s.timezone || 'Asia/Manila';
  const now = Date.now();
  const today = dayKey(now, tz);
  let msgId = s.schedule_msg_id, prevDay = s.schedule_prev_day, prevMsg = s.schedule_prev_msg_id;

  if (s.schedule_day !== today) {
    // New day: claim the rollover so two refreshes running at once cannot both post.
    const claim = await env.DB.prepare('UPDATE team_settings SET schedule_prev_day = schedule_day, schedule_prev_msg_id = schedule_msg_id, schedule_day = ?, schedule_msg_id = NULL WHERE team_id = ? AND schedule_day IS ?')
      .bind(today, teamId, s.schedule_day).run();
    if (!claim.meta?.changes) return;
    prevDay = s.schedule_day; prevMsg = s.schedule_msg_id; msgId = null;
  } else if (!msgId) {
    return;   // today's post is being made right now, or failed permanently (saving the webhook again retries)
  }

  const days = [today];
  if (touchedDay && touchedDay !== today && touchedDay === prevDay && prevMsg) days.push(touchedDay);
  const [bosses, ended] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM bosses WHERE team_id = ?').bind(teamId),
    env.DB.prepare(`SELECT * FROM schedule_spawns WHERE team_id = ? AND day IN (${days.map(() => '?').join(',')})`).bind(teamId, ...days),
  ]);
  const groups = parseGroups(s.spawn_groups);
  const body = (day) => payload(s.team_name, day, dayScheduleText(day, bosses.results, ended.results.filter(e => e.day === day), tz, now, groups), tz);

  if (msgId) {
    const r = await webhookCall(env, s.webhook_schedule, 'PATCH', msgId, body(today));
    if (!r.ok && r.status === 404) msgId = null;   // someone deleted the message: post a fresh one
  }
  if (!msgId) {
    const r = await webhookCall(env, s.webhook_schedule, 'POST', null, body(today));
    if (r.ok && r.id) {
      await env.DB.prepare('UPDATE team_settings SET schedule_msg_id = ? WHERE team_id = ? AND schedule_day = ?').bind(r.id, teamId, today).run();
    } else if (!permanent(r.status)) {
      // Discord hiccup: give the day back so the next cron minute tries again.
      await env.DB.prepare('UPDATE team_settings SET schedule_day = ?, schedule_msg_id = ? WHERE team_id = ? AND schedule_day = ? AND schedule_msg_id IS NULL')
        .bind(prevDay, prevMsg, teamId, today).run();
      return;
    }
  }
  if (days.length > 1) await webhookCall(env, s.webhook_schedule, 'PATCH', prevMsg, body(touchedDay));
}

// Fire-and-forget from a request: runs after the response in ctx.waitUntil when there is one.
export function queueScheduleRefresh(ctx, env, teamId, opts) {
  const work = refreshSchedulePost(env, teamId, opts).catch(e => console.error('schedule refresh failed:', e));
  if (ctx?.waitUntil) ctx.waitUntil(work);
  return work;
}

// Cron: teams whose post is due for a new day, plus the ones whose bosses changed this tick.
// touched: Map teamId -> touchedDay (or null).
export async function cronScheduleRefresh(env, touched) {
  const now = Date.now();
  const teams = await env.DB.prepare("SELECT team_id, timezone, schedule_day FROM team_settings WHERE webhook_schedule IS NOT NULL AND webhook_schedule != ''").all();
  const due = new Map();
  for (const t of teams.results) {
    if (touched.has(t.team_id) || t.schedule_day !== dayKey(now, t.timezone || 'Asia/Manila')) due.set(t.team_id, touched.get(t.team_id) || null);
  }
  await Promise.allSettled([...due].map(([teamId, touchedDay]) => refreshSchedulePost(env, teamId, { touchedDay })));
  // Keep a few days of finished spawns (today's and yesterday's posts are the only readers).
  if (new Date(now).getUTCMinutes() === 7) {
    await env.DB.prepare('DELETE FROM schedule_spawns WHERE ended_at < ?').bind(now - KEEP_DAYS * 86400000).run();
  }
}
