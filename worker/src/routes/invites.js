// Invite codes and join-request approval (protected routes)

import { json } from '../lib/http.js';
import { rateLimit } from '../lib/ratelimit.js';
import { sendDiscord } from '../lib/discord.js';
import { hookUrls } from '../lib/webhooks.js';
import { isPremiumTeam } from '../lib/team.js';
import { limitsFor } from '../lib/limits.js';

export const routes = [
  // POST /api/invite/:code — join team via invite code
  { method: 'POST', pattern: /^\/api\/invite\/([^/]+)$/, handler: async ({ request, env, user, params }) => {
    const code = params[1];

    const team = await env.DB.prepare('SELECT * FROM teams WHERE invite_code = ?').bind(code).first();
    if (!team) return json({ error: 'Invalid invite code' }, 404);
    const me = await env.DB.prepare('SELECT auth_type FROM users WHERE id = ?').bind(user.userId).first();
    if (!me || me.auth_type === 'deleted') return json({ error: 'Account deleted' }, 401);

    // Check if invites are enabled
    const settings = await env.DB.prepare('SELECT invites_enabled, invite_approval FROM team_settings WHERE team_id = ?').bind(team.id).first();
    if (settings && !settings.invites_enabled) {
      return json({ error: 'This team is not accepting new members right now' }, 403);
    }

    // Check if already a member
    const existing = await env.DB.prepare(
      'SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?'
    ).bind(team.id, user.userId).first();
    if (existing) return json({ error: 'Already a member', team: { id: team.id, name: team.name } }, 400);

    // Check member limit (plan limits; premium includes an active trial)
    const maxMembers = limitsFor(await isPremiumTeam(env, team.id)).members;
    const count = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM team_members WHERE team_id = ?'
    ).bind(team.id).first();
    if (count.count >= maxMembers) {
      return json({ error: `Team is full (${maxMembers} members max)` }, 403);
    }

    // Check if approval is required
    if (settings?.invite_approval) {
      // Rate limit join requests (5 per hour per user)
      if (rateLimit(`join-req:${user.userId}`, 5, 3600000)) {
        return json({ error: 'Too many join requests. Try again later.' }, 429);
      }
      // Check if already has a pending request
      const pendingReq = await env.DB.prepare(
        "SELECT 1 FROM join_requests WHERE team_id = ? AND user_id = ? AND status = 'pending'"
      ).bind(team.id, user.userId).first();
      if (pendingReq) return json({ error: 'You already have a pending request for this team', pending: true }, 400);

      // Create join request
      const reqId = crypto.randomUUID();
      const dbUser = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(user.userId).first();
      await env.DB.prepare('INSERT INTO join_requests (id, team_id, user_id, username) VALUES (?, ?, ?, ?)')
        .bind(reqId, team.id, user.userId, dbUser?.username || 'Unknown').run();

      // Notify via webhook if available
      const fullSettings = await env.DB.prepare('SELECT webhook_url FROM team_settings WHERE team_id = ?').bind(team.id).first();
      if (fullSettings?.webhook_url) {
        await sendDiscord(env, hookUrls(fullSettings.webhook_url), 'Join Request',
          `**${dbUser?.username || 'Someone'}** wants to join **${team.name}**.\nApprove or deny in team settings.`, 16760576);
      }

      return json({ ok: true, pending: true, message: 'Join request sent! Waiting for approval.' });
    }

    await env.DB.prepare('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)')
      .bind(team.id, user.userId, 'member').run();

    return json({ ok: true, team: { id: team.id, name: team.name } });
  } },

  // GET /api/invite/:code — get invite info (public)
  { method: 'GET', pattern: /^\/api\/invite\/([^/]+)$/, handler: async ({ env, params }) => {
    const code = params[1];
    const team = await env.DB.prepare('SELECT id, name FROM teams WHERE invite_code = ?').bind(code).first();
    if (!team) return json({ error: 'Invalid invite code' }, 404);
    const settings = await env.DB.prepare('SELECT invites_enabled, invite_approval FROM team_settings WHERE team_id = ?').bind(team.id).first();
    if (settings && !settings.invites_enabled) {
      return json({ error: 'This team is not accepting new members' }, 403);
    }
    const count = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM team_members WHERE team_id = ?'
    ).bind(team.id).first();
    return json({ team: { name: team.name, members: count.count, requiresApproval: !!(settings?.invite_approval) } });
  } },

  // GET /api/teams/:id/join-requests — list pending requests (leader/officer)
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/join-requests$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await env.DB.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .bind(teamId, user.userId).first();
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);

    const requests = await env.DB.prepare(
      "SELECT id, user_id, username, status, created_at FROM join_requests WHERE team_id = ? AND status = 'pending' ORDER BY created_at DESC"
    ).bind(teamId).all();

    return json({ requests: requests.results });
  } },

  // POST /api/teams/:id/join-requests/:reqId/approve
  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/join-requests\/([^/]+)\/(approve|deny)$/, handler: async ({ request, env, user, params }) => {
    const teamId = params[1];
    const reqId = params[2];
    const action = params[3];

    const member = await env.DB.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .bind(teamId, user.userId).first();
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);

    const req = await env.DB.prepare("SELECT * FROM join_requests WHERE id = ? AND team_id = ? AND status = 'pending'")
      .bind(reqId, teamId).first();
    if (!req) return json({ error: 'Request not found or already resolved' }, 404);

    if (action === 'approve') {
      // Check member limit
      const maxMembers = limitsFor(await isPremiumTeam(env, teamId)).members;
      const count = await env.DB.prepare('SELECT COUNT(*) as count FROM team_members WHERE team_id = ?').bind(teamId).first();
      if (count.count >= maxMembers) {
        return json({ error: `Team is full (${maxMembers} members max)` }, 403);
      }

      // Check not already a member (could have joined another way)
      const alreadyMember = await env.DB.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?')
        .bind(teamId, req.user_id).first();
      if (alreadyMember) {
        await env.DB.prepare("UPDATE join_requests SET status = 'approved', resolved_by = ?, resolved_at = unixepoch() WHERE id = ?")
          .bind(user.userId, reqId).run();
        return json({ error: 'User is already a member' }, 400);
      }

      await env.DB.batch([
        env.DB.prepare('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)').bind(teamId, req.user_id, 'member'),
        env.DB.prepare("UPDATE join_requests SET status = 'approved', resolved_by = ?, resolved_at = unixepoch() WHERE id = ?").bind(user.userId, reqId),
      ]);

      // Notify via webhook
      const settings = await env.DB.prepare('SELECT webhook_url FROM team_settings WHERE team_id = ?').bind(teamId).first();
      if (settings?.webhook_url) {
        await sendDiscord(env, hookUrls(settings.webhook_url), 'Member Joined',
          `**${req.username}** has been approved and joined the team!`, 5763719);
      }

      return json({ ok: true, message: `${req.username} approved and added to the team` });
    } else {
      // Deny
      await env.DB.prepare("UPDATE join_requests SET status = 'denied', resolved_by = ?, resolved_at = unixepoch() WHERE id = ?")
        .bind(user.userId, reqId).run();

      return json({ ok: true, message: `${req.username}'s request denied` });
    }
  } },
];
