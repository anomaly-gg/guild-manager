// Daily boss schedule post: one Discord webhook message per team-clock day in each schedule
// channel, posted at 00:00 and edited in place whenever a spawn comes up, is killed or auto-resets,
// or a timer/group changes. State lives on team_settings (webhook_schedule = the channels,
// schedule_day + schedule_msg_id for today's messages, schedule_prev_day + schedule_prev_msg_id for
// yesterday's; message ids per channel, lib/webhooks.js); finished spawns are recorded in
// schedule_spawns so the day's post can keep them, crossed out.

import { webhookCall } from './discord.js';
import { parseHooks, hookUrls, hookId, parseMsgs } from './webhooks.js';
import { dayKey, weekdayLabel, dayScheduleText } from './schedule-format.js';
import { parseGroups, groupsIn } from './spawn-groups.js';

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
const labelForKey = (key) => weekdayLabel(Date.parse(key + 'T12:00:00Z'), 'UTC');

// `timestamp` = when this edit was made: Discord shows it in the footer as "Today at 3:20 PM".
function payload(teamName, day, text, tz, now) {
  return {
    embeds: [{
      title: `${teamName} · ${labelForKey(day)}`.slice(0, 256),
      description: text.length > 4096 ? text.slice(0, 4090) + '\n…' : text,
      color: 0x5865f2,
      footer: { text: `${tz} time · updates live` },
      timestamp: new Date(now).toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

// 4xx other than 429 = the webhook or message is gone/invalid; anything else is worth retrying.
const permanent = (status) => status >= 400 && status < 500 && status !== 429;

// Bring the team's schedule post up to date in each of its channels. `touchedDay` = the day of a
// spawn that just finished, so yesterday's message is edited too when a late-night spawn is killed
// after midnight.
export async function refreshSchedulePost(env, teamId, { touchedDay } = {}) {
  const s = await env.DB.prepare('SELECT t.name AS team_name, ts.* FROM team_settings ts JOIN teams t ON t.id = ts.team_id WHERE ts.team_id = ?').bind(teamId).first();
  const channels = parseHooks(s?.webhook_schedule), hooks = channels.map(h => h.u);
  const serverOf = new Map(channels.map(h => [h.u, h.g || null]));
  if (!hooks.length) return;
  const tz = s.timezone || 'Asia/Manila';
  const now = Date.now();
  const today = dayKey(now, tz);
  let raw = s.schedule_msg_id, prevDay = s.schedule_prev_day, prevRaw = s.schedule_prev_msg_id;

  if (s.schedule_day !== today) {
    // New day: claim the rollover so two refreshes running at once cannot both do it.
    const claim = await env.DB.prepare('UPDATE team_settings SET schedule_prev_day = schedule_day, schedule_prev_msg_id = schedule_msg_id, schedule_day = ?, schedule_msg_id = NULL WHERE team_id = ? AND schedule_day IS ?')
      .bind(today, teamId, s.schedule_day).run();
    if (!claim.meta?.changes) return;
    prevDay = s.schedule_day; prevRaw = s.schedule_msg_id; raw = null;
  }

  const days = [today];
  if (touchedDay && touchedDay !== today && touchedDay === prevDay && prevRaw) days.push(touchedDay);
  const [bosses, ended] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM bosses WHERE team_id = ?').bind(teamId),
    env.DB.prepare(`SELECT * FROM schedule_spawns WHERE team_id = ? AND day IN (${days.map(() => '?').join(',')})`).bind(teamId, ...days),
  ]);
  const groups = parseGroups(s.spawn_groups);
  // Each channel shows the group roles of its own server; channels whose servers see the same roles
  // share one rendering (the text is the costly part of a cron run).
  const rendered = new Map();
  const body = (day, hook) => {
    const view = groupsIn(groups, serverOf.get(hook));
    const key = day + '|' + view.map(g => g.roleId || '').join();
    if (!rendered.has(key)) rendered.set(key, payload(s.team_name, day, dayScheduleText(day, bosses.results, ended.results.filter(e => e.day === day), tz, now, view), tz, now));
    return rendered.get(key);
  };

  // Edit today's message where a channel has one ('' = being posted right now, or refused for good).
  const msgs = parseMsgs(raw, hooks);
  const gone = [];
  await Promise.all(hooks.map(async (hook) => {
    const msgId = msgs[hookId(hook)];
    if (!msgId) return;
    const r = await webhookCall(env, hook, 'PATCH', msgId, body(today, hook));
    if (!r.ok && r.status === 404) gone.push(hook);   // someone deleted the message: post a fresh one
  }));
  const toPost = [...hooks.filter(h => !(hookId(h) in msgs)), ...gone];
  if (toPost.length) await postToday(env, teamId, today, raw, msgs, toPost, hook => body(today, hook));
  if (days.length > 1) {
    const prev = parseMsgs(prevRaw, hooks);
    await Promise.all(hooks.map(hook => prev[hookId(hook)] && webhookCall(env, hook, 'PATCH', prev[hookId(hook)], body(touchedDay, hook))));
  }
}

// Post today's message in the channels that lack one. Claiming them first ('' per channel) keeps
// two refreshes running at once from both posting. A Discord hiccup frees the channel again, so the
// next cron minute retries; a refused webhook keeps '' until the channel is added again.
async function postToday(env, teamId, today, raw, msgs, hooks, bodyFor) {
  const claimed = { ...msgs, ...Object.fromEntries(hooks.map(h => [hookId(h), ''])) };
  const claim = await env.DB.prepare('UPDATE team_settings SET schedule_msg_id = ? WHERE team_id = ? AND schedule_day = ? AND schedule_msg_id IS ?')
    .bind(JSON.stringify(claimed), teamId, today, raw ?? null).run();
  if (!claim.meta?.changes) return;
  const results = await Promise.all(hooks.map(async (hook) => [hookId(hook), await webhookCall(env, hook, 'POST', null, bodyFor(hook))]));
  const stmts = results.filter(([, r]) => r.ok ? !!r.id : !permanent(r.status)).map(([id, r]) => r.ok
    ? env.DB.prepare('UPDATE team_settings SET schedule_msg_id = json_set(schedule_msg_id, ?, ?) WHERE team_id = ? AND schedule_day = ?').bind(`$."${id}"`, r.id, teamId, today)
    : env.DB.prepare('UPDATE team_settings SET schedule_msg_id = json_remove(schedule_msg_id, ?) WHERE team_id = ? AND schedule_day = ?').bind(`$."${id}"`, teamId, today));
  if (stmts.length) await env.DB.batch(stmts);
}

// Fire-and-forget from a request: runs after the response in ctx.waitUntil when there is one.
export function queueScheduleRefresh(ctx, env, teamId, opts) {
  const work = refreshSchedulePost(env, teamId, opts).catch(e => console.error('schedule refresh failed:', e));
  if (ctx?.waitUntil) ctx.waitUntil(work);
  return work;
}

// Cron: teams whose post is due for a new day or still missing in a channel (a Discord hiccup),
// plus the ones whose bosses changed this tick. touched: Map teamId -> touchedDay (or null).
export async function cronScheduleRefresh(env, touched) {
  const now = Date.now();
  const teams = await env.DB.prepare("SELECT team_id, timezone, schedule_day, webhook_schedule, schedule_msg_id FROM team_settings WHERE webhook_schedule IS NOT NULL AND webhook_schedule != ''").all();
  const due = new Map();
  for (const t of teams.results) {
    const hooks = hookUrls(t.webhook_schedule), msgs = parseMsgs(t.schedule_msg_id, hooks);
    if (touched.has(t.team_id) || t.schedule_day !== dayKey(now, t.timezone || 'Asia/Manila') || hooks.some(h => !(hookId(h) in msgs))) {
      due.set(t.team_id, touched.get(t.team_id) || null);
    }
  }
  await Promise.allSettled([...due].map(([teamId, touchedDay]) => refreshSchedulePost(env, teamId, { touchedDay })));
  // Keep a few days of finished spawns (today's and yesterday's posts are the only readers).
  if (new Date(now).getUTCMinutes() === 7) {
    await env.DB.prepare('DELETE FROM schedule_spawns WHERE ended_at < ?').bind(now - KEEP_DAYS * 86400000).run();
  }
}
