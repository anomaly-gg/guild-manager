// Maintenance reset (protected, officers+). After server maintenance every respawn-timer boss
// spawns when the server opens; fixed-schedule bosses (daily / weekly / twice-daily times) keep
// their times. This sets every interval timer to spawn at the server-open time in one batch.
//
// No per-boss alerts: 30+ bosses coming up at once would be 30+ pings, so the rows are marked
// already warned/notified (the cron still flips them to "up" and runs auto-reset as usual) and
// each alert channel gets ONE summary message instead. Phones get one alert too (lib/push-state.js
// shows the reset as one line while maintenance_at is recent).

import { json, safeJson } from '../lib/http.js';
import { requireTeamMember } from '../lib/team.js';
import { webhookCall } from '../lib/discord.js';
import { alertHooks } from '../lib/webhooks.js';
import { clockIn } from '../lib/schedule-format.js';
import { queueScheduleRefresh } from '../lib/schedule-post.js';
import { queuePush } from '../lib/push-send.js';

const HOUR = 3600000;
const EARLIEST = 12 * HOUR;   // server opened up to 12 h ago (reset done late)
const LATEST = 24 * HOUR;     // or opens within the next day (reset set up before maintenance ends)

function summary(count, kept, openAt, now, tz) {
  const when = openAt <= now + 60000 ? 'now' : `at ${clockIn(openAt, tz)}`;
  const lines = [`**${count} boss${count === 1 ? '' : 'es'}** spawn ${when} (server open). Log kills as usual; timers run from each kill.`];
  if (kept) lines.push(`-# ${kept} fixed-schedule boss${kept === 1 ? '' : 'es'} keep${kept === 1 ? 's' : ''} ${kept === 1 ? 'its' : 'their'} usual time.`);
  return {
    embeds: [{ title: '🔧 Maintenance reset', description: lines.join('\n'), color: 0x5865f2, footer: { text: 'Guild Manager' } }],
    allowed_mentions: { parse: [] },
  };
}

export const routes = [
  // POST /api/teams/:id/bosses/maintenance-reset { openAt? } -> { ok, reset, kept, openAt }
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

    const [counts, settings] = await env.DB.batch([
      env.DB.prepare("SELECT SUM(type = 'interval') AS reset, SUM(type != 'interval') AS kept FROM bosses WHERE team_id = ?").bind(teamId),
      env.DB.prepare('SELECT timezone, webhook_url, webhook_boss, on_warning, on_spawn FROM team_settings WHERE team_id = ?').bind(teamId),
    ]);
    const reset = counts.results[0]?.reset || 0, kept = counts.results[0]?.kept || 0;
    if (!reset) return json({ error: 'No respawn-timer bosses to reset. Fixed-schedule bosses keep their times.' }, 400);

    await env.DB.batch([
      env.DB.prepare(`UPDATE bosses SET next_spawn = ?, status = 'waiting', spawned_at = NULL, auto_reset_at = NULL,
          warned = 1, spawn_notified = 1, alert_soon_msg = NULL, alert_spawn_msg = NULL
        WHERE team_id = ? AND type = 'interval'`).bind(openAt, teamId),
      env.DB.prepare('UPDATE team_settings SET maintenance_at = ?, maintenance_count = ? WHERE team_id = ?').bind(openAt, reset, teamId),
    ]);
    queueScheduleRefresh(ctx, env, teamId);
    queuePush(ctx, env, [{ teamId, kind: 'maintenance' }]);

    const s = settings.results[0] || {};
    const hooks = alertHooks(s, 'boss');
    if (hooks.length && (s.on_spawn || s.on_warning)) {
      const body = summary(reset, kept, openAt, now, s.timezone || 'Asia/Manila');
      const post = Promise.all(hooks.map(hook => webhookCall(env, hook, 'POST', null, body)))
        .catch(e => console.error('maintenance summary failed:', e));
      if (ctx?.waitUntil) ctx.waitUntil(post);
    }
    return json({ ok: true, reset, kept, openAt });
  } },
];
