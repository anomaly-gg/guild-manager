// Maintenance reset (protected, officers+). After server maintenance every respawn-timer boss
// spawns when the server opens, and so does a fixed-schedule boss that was due while the server was
// down; the other fixed-schedule bosses keep their times. Which ones: lib/maintenance.js planReset.
// { preview: true } answers the same counts without changing anything (the dialog's live summary).
//
// No per-boss alerts: 30+ bosses coming up at once would be 30+ pings, so the rows are marked
// already warned/notified (the cron still flips them to "up" and runs auto-reset as usual) and
// each alert channel gets ONE summary message instead. Phones get one alert too (lib/push-state.js
// shows the reset as one line while maintenance_at is recent). Clearing them all takes longer than
// the usual 5-minute auto-reset, so these spawns wait MAINTENANCE_RESET_MS (lib/spawn.js autoResetMs).

import { json, safeJson } from '../lib/http.js';
import { requireTeamMember } from '../lib/team.js';
import { webhookCall } from '../lib/discord.js';
import { alertHooks } from '../lib/webhooks.js';
import { clockIn } from '../lib/schedule-format.js';
import { MAINTENANCE_RESET_MS } from '../lib/spawn.js';
import { planReset } from '../lib/maintenance.js';
import { queueScheduleRefresh } from '../lib/schedule-post.js';
import { queuePush } from '../lib/push-send.js';

const HOUR = 3600000;
const EARLIEST = 12 * HOUR;   // server opened up to 12 h ago (reset done late)
const LATEST = 24 * HOUR;     // or opens within the next day (reset set up before maintenance ends)
const LONGEST = 24 * HOUR;    // a maintenance window (from -> open) is at most a day
const CHUNK = 90;             // ids per IN (...): D1 allows 100 bound parameters per query

const names = (list) => list.map(b => b.name);

function summary(count, fixed, kept, openAt, now, tz) {
  const when = openAt <= now + 60000 ? 'now' : `at ${clockIn(openAt, tz)}`;
  const lines = [`**${count} boss${count === 1 ? '' : 'es'}** spawn ${when} (server open). Log kills as usual; timers run from each kill.`];
  if (fixed.length) lines.push(`Due during maintenance, up at open too: ${fixed.join(', ')}.`.slice(0, 1000));
  lines.push(`-# Unkilled ones wait ${MAINTENANCE_RESET_MS / 60000} minutes before they auto-reset, so there is time to clear them all.`);
  if (kept) lines.push(`-# ${kept} fixed-schedule boss${kept === 1 ? '' : 'es'} keep${kept === 1 ? 's' : ''} ${kept === 1 ? 'its' : 'their'} usual time.`);
  return {
    embeds: [{ title: '🔧 Maintenance reset', description: lines.join('\n'), color: 0x5865f2, footer: { text: 'Guild Manager' } }],
    allowed_mentions: { parse: [] },
  };
}

export const routes = [
  // POST /api/teams/:id/bosses/maintenance-reset { openAt?, from?, preview? }
  //   -> { ok, reset, fixed: [names], killed: [names], kept, openAt, from }
  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/bosses\/maintenance-reset$/, handler: async ({ request, env, ctx, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);
    const body = (await safeJson(request)) || {};
    const now = Date.now();
    const openAt = body.openAt == null ? now : Number(body.openAt);
    if (!Number.isFinite(openAt) || openAt < now - EARLIEST || openAt > now + LATEST) {
      return json({ error: 'Server open time must be within the last 12 hours or the next 24 hours' }, 400);
    }
    const from = body.from == null ? null : Number(body.from);
    if (from != null && (!Number.isFinite(from) || from >= openAt || openAt - from > LONGEST)) {
      return json({ error: 'Maintenance must start before the server opens, and last at most 24 hours' }, 400);
    }

    const [bosses, resets, settings] = await env.DB.batch([
      env.DB.prepare('SELECT id, name, type, next_spawn, last_death FROM bosses WHERE team_id = ?').bind(teamId),
      env.DB.prepare("SELECT id, boss_id, spawn_at FROM schedule_spawns WHERE team_id = ? AND outcome = 'reset' AND spawn_at >= ? AND spawn_at < ?").bind(teamId, from ?? openAt, openAt),
      env.DB.prepare('SELECT timezone, webhook_url, webhook_boss, on_warning, on_spawn FROM team_settings WHERE team_id = ?').bind(teamId),
    ]);
    const plan = planReset(bosses.results, resets.results, { from, openAt });
    const reset = plan.up.length, kept = plan.kept.length;
    const answer = { ok: true, reset, fixed: names(plan.fixed), killed: names(plan.killed), kept, openAt, from };
    if (body.preview) return json(answer);
    if (!reset && !plan.fixed.length) return json({ error: 'Nothing to reset: no respawn-timer bosses, and no fixed-schedule boss was due during maintenance.' }, 400);

    const ids = [...plan.up, ...plan.fixed].map(b => b.id), stmts = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      stmts.push(env.DB.prepare(`UPDATE bosses SET next_spawn = ?, status = 'waiting', spawned_at = NULL, auto_reset_at = NULL,
          warned = 1, spawn_notified = 1, alert_soon_msg = NULL, alert_spawn_msg = NULL
        WHERE team_id = ? AND id IN (${part.map(() => '?').join(',')})`).bind(openAt, teamId, ...part));
    }
    // Spawns we auto-reset while the server was down never happened in game: off the schedule post.
    for (let i = 0; i < plan.resetRows.length; i += CHUNK) {
      const part = plan.resetRows.slice(i, i + CHUNK);
      stmts.push(env.DB.prepare(`DELETE FROM schedule_spawns WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part));
    }
    stmts.push(env.DB.prepare('UPDATE team_settings SET maintenance_at = ?, maintenance_from = ?, maintenance_count = ? WHERE team_id = ?').bind(openAt, from, ids.length, teamId));
    await env.DB.batch(stmts);
    queueScheduleRefresh(ctx, env, teamId);
    queuePush(ctx, env, [{ teamId, kind: 'maintenance' }]);

    const s = settings.results[0] || {};
    const hooks = alertHooks(s, 'boss');
    if (hooks.length && (s.on_spawn || s.on_warning)) {
      const body = summary(ids.length, answer.fixed, kept, openAt, now, s.timezone || 'Asia/Manila');
      const post = Promise.all(hooks.map(hook => webhookCall(env, hook, 'POST', null, body)))
        .catch(e => console.error('maintenance summary failed:', e));
      if (ctx?.waitUntil) ctx.waitUntil(post);
    }
    return json(answer);
  } },
];
