// Team settings (protected routes). Every field returned here has a consumer; dead ones were cut in M8.
// Discord alert channels are added/removed/tested in routes/webhooks.js.

import { json, safeJson } from '../lib/http.js';
import { requireTeamMember, isPremiumTeam } from '../lib/team.js';
import { KINDS, publicHooks } from '../lib/webhooks.js';
import { backfillSettings } from '../lib/settings-backfill.js';
import { parseRoles } from './events.js';
import { lootModeFor } from '../lib/rotation.js';
import { createToken } from '../lib/auth.js';
import { guildName, guildRoles } from '../lib/discord-interactions.js';
import { parseGroups, cleanGroups } from '../lib/spawn-groups.js';
import { queueScheduleRefresh } from '../lib/schedule-post.js';
import { DEFAULT_MINUTES, clampMinutes } from '../lib/discord-cleanup.js';

// Linked servers for Settings; rows linked before names were fetched get their name filled in here.
async function linkedGuildsWithNames(env, teamId) {
  const rows = (await env.DB.prepare('SELECT guild_id, guild_name, linked_at FROM discord_guilds WHERE team_id = ? ORDER BY linked_at').bind(teamId).all()).results;
  for (const g of rows) {
    if (g.guild_name) continue;
    const name = await guildName(env, g.guild_id);
    if (name) { g.guild_name = name; await env.DB.prepare('UPDATE discord_guilds SET guild_name = ? WHERE guild_id = ?').bind(name, g.guild_id).run(); }
  }
  return rows.map(g => ({ guildId: g.guild_id, name: g.guild_name, linkedAt: g.linked_at }));
}

export const routes = [
  // GET /api/teams/:id/discord-link — the "Add to Discord" URL with a signed state, so the callback
  // (/discord/added, public) can link the chosen server to this team without a /link command.
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/discord-link$/, handler: async ({ env, user, url, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);
    if (!env.DISCORD_APP_ID) return json({ error: 'Discord app not configured' }, 500);
    const state = await createToken({ kind: 'discord-link', teamId, userId: user.userId }, env.JWT_SECRET);
    const q = new URLSearchParams({
      client_id: env.DISCORD_APP_ID, scope: 'applications.commands bot', permissions: '0',
      response_type: 'code', redirect_uri: url.origin + '/discord/added', state,
    });
    return json({ url: `https://discord.com/oauth2/authorize?${q}` });
  } },

  // GET /api/teams/:id/discord-roles — roles of every linked server, for tagging spawn groups (officers+)
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/discord-roles$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);
    const guilds = (await env.DB.prepare('SELECT guild_id, guild_name FROM discord_guilds WHERE team_id = ? ORDER BY linked_at').bind(teamId).all()).results;
    const lists = await Promise.all(guilds.map(g => guildRoles(env, g.guild_id)));
    return json({ servers: guilds.map((g, i) => ({ guildId: g.guild_id, name: g.guild_name, roles: lists[i] })) });
  } },

  // GET /api/teams/:id/settings
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/settings$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    const settings = await backfillSettings(env, teamId, await env.DB.prepare('SELECT * FROM team_settings WHERE team_id = ?').bind(teamId).first());
    return json({
      onWarning: settings?.on_warning ?? true,
      onSpawn: settings?.on_spawn ?? true,
      onEvent: settings?.on_event ?? true,
      onLoot: settings?.on_loot ?? true,
      eventReminderMinutes: settings?.event_reminder_minutes ?? 15,
      teamDescription: settings?.team_description || '',
      membersCreateEvents: settings?.members_create_events ?? true,
      autoDeleteEventsDays: settings?.auto_delete_events_days ?? 0,
      pointsName: settings?.points_name || 'DKP',
      timezone: settings?.timezone || 'Asia/Manila',
      // Discord channels per alert kind: id + name only, never the URL (its token lets anyone post)
      webhooks: Object.fromEntries(Object.entries(KINDS).map(([kind, col]) => [kind, publicHooks(settings?.[col])])),
      spawnGroups: parseGroups(settings?.spawn_groups),
      dkpDecayEnabled: !!(settings?.dkp_decay_enabled),
      dkpDecayPercent: settings?.dkp_decay_percent ?? 10,
      dkpDecayInactiveDays: settings?.dkp_decay_inactive_days ?? 14,
      dkpDecayIntervalDays: settings?.dkp_decay_interval_days ?? 7,
      teamIcon: settings?.team_icon || '',
      invitesEnabled: settings?.invites_enabled ?? true,
      inviteApproval: !!(settings?.invite_approval),
      publicToken: settings?.public_token || null,
      discordGuilds: await linkedGuildsWithNames(env, teamId),
      discordAutoDelete: (settings?.discord_autodelete ?? 1) ? true : false,
      discordDeleteActionMin: settings?.discord_delete_action_min ?? DEFAULT_MINUTES.action,
      discordDeleteNextMin: settings?.discord_delete_next_min ?? DEFAULT_MINUTES.next,
      attendancePoints: settings?.attendance_points ?? 1,
      attendanceAutoApprove: !!settings?.attendance_auto_approve,
      attendanceSelfCheckin: settings?.attendance_self_checkin ?? 1 ? true : false,
      rsvpRoles: parseRoles(settings?.rsvp_roles),
      modules: (() => { try { return settings?.modules ? JSON.parse(settings.modules) : {}; } catch { return {}; } })(),
      lootMode: await lootModeFor(env, teamId, settings || null),
    });
  } },

  // PUT /api/teams/:id/settings
  { method: 'PUT', pattern: /^\/api\/teams\/([^/]+)\/settings$/, handler: async ({ request, env, ctx, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || (member.role !== 'leader' && member.role !== 'officer')) {
      return json({ error: 'Officers+ only' }, 403);
    }

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    let existingRow = await env.DB.prepare('SELECT modules FROM team_settings WHERE team_id = ?').bind(teamId).first();
    let existing = existingRow;
    if (!existing) {
      // First save for this team: create the row, then apply every field through the update path below.
      await env.DB.prepare('INSERT INTO team_settings (team_id, timezone) VALUES (?, ?)').bind(teamId, body.timezone || 'Asia/Manila').run();
      existing = true;
    }

    if (existing) {
      const sets = [];
      const vals = [];
      if (body.spawnGroups !== undefined) {
        const groups = cleanGroups(body.spawnGroups);
        if (typeof groups === 'string') return json({ error: groups }, 400);
        sets.push('spawn_groups = ?'); vals.push(groups.length ? JSON.stringify(groups) : null);
      }
      if (body.discordAutoDelete !== undefined) { sets.push('discord_autodelete = ?'); vals.push(body.discordAutoDelete ? 1 : 0); }
      if (body.discordDeleteActionMin !== undefined) { sets.push('discord_delete_action_min = ?'); vals.push(clampMinutes(body.discordDeleteActionMin, DEFAULT_MINUTES.action)); }
      if (body.discordDeleteNextMin !== undefined) { sets.push('discord_delete_next_min = ?'); vals.push(clampMinutes(body.discordDeleteNextMin, DEFAULT_MINUTES.next)); }
      if (body.unlinkDiscordGuild) await env.DB.prepare('DELETE FROM discord_guilds WHERE guild_id = ? AND team_id = ?').bind(String(body.unlinkDiscordGuild), teamId).run();   // linking happens via Add to Discord or /link
      if (body.onWarning !== undefined) { sets.push('on_warning = ?'); vals.push(body.onWarning ? 1 : 0); }
      if (body.onSpawn !== undefined) { sets.push('on_spawn = ?'); vals.push(body.onSpawn ? 1 : 0); }
      if (body.onEvent !== undefined) { sets.push('on_event = ?'); vals.push(body.onEvent ? 1 : 0); }
      if (body.onLoot !== undefined) { sets.push('on_loot = ?'); vals.push(body.onLoot ? 1 : 0); }
      if (body.eventReminderMinutes !== undefined) { sets.push('event_reminder_minutes = ?'); vals.push(body.eventReminderMinutes); }
      if (body.teamDescription !== undefined) { sets.push('team_description = ?'); vals.push(body.teamDescription || null); }
      if (body.invitesEnabled !== undefined) {
        if (member.role !== 'leader') return json({ error: 'Only the leader can change invite settings' }, 403);
        sets.push('invites_enabled = ?'); vals.push(body.invitesEnabled ? 1 : 0);
      }
      if (body.inviteApproval !== undefined) {
        if (member.role !== 'leader') return json({ error: 'Only the leader can change invite settings' }, 403);
        sets.push('invite_approval = ?'); vals.push(body.inviteApproval ? 1 : 0);
      }
      if (body.modules !== undefined && typeof body.modules === 'object') {
        const cur = (() => { try { return JSON.parse(existingRow?.modules || '{}'); } catch { return {}; } })();
        const next = { ...cur };
        if (body.modules.points !== undefined) next.points = !!body.modules.points;
        sets.push('modules = ?'); vals.push(JSON.stringify(next));
      }
      if (body.lootMode !== undefined) {
        if (!['rotation', 'dkp'].includes(body.lootMode)) return json({ error: 'lootMode must be rotation or dkp' }, 400);
        sets.push('loot_mode = ?'); vals.push(body.lootMode);
      }
      if (body.rsvpRoles !== undefined) {
        const list = Array.isArray(body.rsvpRoles) ? body.rsvpRoles.map(r => String(r).trim().slice(0, 20)).filter(Boolean).slice(0, 8) : [];
        sets.push('rsvp_roles = ?'); vals.push(list.length ? JSON.stringify(list) : null);
      }
      if (body.publicTimers !== undefined) {
        if (body.publicTimers && !(await isPremiumTeam(env, teamId))) return json({ error: 'Premium required', premiumRequired: true }, 403);
        sets.push('public_token = ?'); vals.push(body.publicTimers ? crypto.randomUUID().replace(/-/g, '') : null);
      }
      if (body.membersCreateEvents !== undefined) { sets.push('members_create_events = ?'); vals.push(body.membersCreateEvents ? 1 : 0); }
      if (body.autoDeleteEventsDays !== undefined) { sets.push('auto_delete_events_days = ?'); vals.push(body.autoDeleteEventsDays); }
      if (body.pointsName !== undefined) { const n = String(body.pointsName).trim().slice(0, 20); sets.push('points_name = ?'); vals.push(n || null); }
      if (body.timezone !== undefined) { sets.push('timezone = ?'); vals.push(body.timezone); }
      if (body.attendancePoints !== undefined) { sets.push('attendance_points = ?'); vals.push(Math.max(0, Math.min(100, parseInt(body.attendancePoints) || 0))); }
      if (body.attendanceAutoApprove !== undefined) { sets.push('attendance_auto_approve = ?'); vals.push(body.attendanceAutoApprove ? 1 : 0); }
      if (body.attendanceSelfCheckin !== undefined) { sets.push('attendance_self_checkin = ?'); vals.push(body.attendanceSelfCheckin ? 1 : 0); }
      // Premium fields — require premium team
      const hasPremiumFields = body.dkpDecayEnabled !== undefined || body.dkpDecayPercent !== undefined ||
        body.dkpDecayInactiveDays !== undefined || body.dkpDecayIntervalDays !== undefined;

      if (hasPremiumFields && !(await isPremiumTeam(env, teamId))) {
        return json({ error: 'Premium required', premiumRequired: true }, 403);
      }

      if (body.dkpDecayEnabled !== undefined) { sets.push('dkp_decay_enabled = ?'); vals.push(body.dkpDecayEnabled ? 1 : 0); }
      if (body.dkpDecayPercent !== undefined) { sets.push('dkp_decay_percent = ?'); vals.push(Math.min(100, Math.max(0, parseInt(body.dkpDecayPercent) || 10))); }
      if (body.dkpDecayInactiveDays !== undefined) { sets.push('dkp_decay_inactive_days = ?'); vals.push(Math.min(365, Math.max(1, parseInt(body.dkpDecayInactiveDays) || 14))); }
      if (body.dkpDecayIntervalDays !== undefined) { sets.push('dkp_decay_interval_days = ?'); vals.push(Math.min(90, Math.max(1, parseInt(body.dkpDecayIntervalDays) || 7))); }
      if (body.teamIcon !== undefined) { sets.push('team_icon = ?'); vals.push(body.teamIcon || null); }
      if (sets.length > 0) {
        vals.push(teamId);
        await env.DB.prepare(`UPDATE team_settings SET ${sets.join(', ')} WHERE team_id = ?`).bind(...vals).run();
        if (body.spawnGroups !== undefined || body.timezone !== undefined) queueScheduleRefresh(ctx, env, teamId);
      }
    }

    return json({ ok: true });
  } },
];
