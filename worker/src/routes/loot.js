// Boss loot log + loot wishlist (protected routes)

import { json, safeJson } from '../lib/http.js';
import { requireTeamMember, isPremiumTeam } from '../lib/team.js';
import { lootModeFor, moveMember, ROTATION_ORDER_SQL } from '../lib/rotation.js';
import { sendDiscord } from '../lib/discord.js';
import { hookUrls } from '../lib/webhooks.js';

export const routes = [
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/loot$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    const loot = await env.DB.prepare(`
      SELECT bl.*, u.username as recipient_name, u2.username as noted_by_name
      FROM boss_loot bl
      JOIN users u ON u.id = bl.recipient_id
      JOIN users u2 ON u2.id = bl.noted_by
      WHERE bl.team_id = ?
      ORDER BY bl.created_at DESC
      LIMIT 100
    `).bind(teamId).all();

    return json({ loot: loot.results, mode: await lootModeFor(env, teamId) });
  } },

  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/loot$/, handler: async ({ request, env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.itemName?.trim() || !body.recipientId) return json({ error: 'Item and recipient required' }, 400);

    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO boss_loot (id, team_id, boss_id, boss_name, item_name, recipient_id, dkp_cost, noted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, teamId, body.bossId || null, body.bossName || 'Unknown', body.itemName.trim(), body.recipientId, body.dkpCost || 0, user.userId).run();

    // Rotation mode: taking a drop sends you to the bottom (unless the officer says it doesn't count)
    const settings = await env.DB.prepare('SELECT webhook_url, on_loot, loot_mode FROM team_settings WHERE team_id = ?').bind(teamId).first();
    const mode = await lootModeFor(env, teamId, settings || null);
    if (body.keepPosition !== true && mode === 'rotation') {
      await moveMember(env, teamId, body.recipientId, 'bottom');
    }

    // Discord: "X received Y" (+ who is next in the rotation). on_loot defaults to on; main webhook channels only.
    if (settings?.webhook_url && (settings.on_loot ?? 1)) {
      const recipient = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(body.recipientId).first();
      const bossPart = body.bossName && body.bossName !== 'Unknown' ? ` from **${body.bossName}**` : '';
      let next = '';
      if (mode === 'rotation') {
        const top = await env.DB.prepare(`SELECT u.username FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? ${ROTATION_ORDER_SQL} LIMIT 1`).bind(teamId).first();
        if (top?.username) next = `\nNext in the rotation: **${top.username}**`;
      } else if (body.dkpCost > 0) {
        next = `\nCost: ${body.dkpCost} points`;
      }
      await sendDiscord(env, hookUrls(settings.webhook_url), `Loot: ${body.itemName.trim()}`, `**${recipient?.username || 'Someone'}** received **${body.itemName.trim()}**${bossPart}.${next}`, 10181046);
    }

    // Deduct DKP if cost > 0
    if (body.dkpCost && body.dkpCost > 0) {
      const dkpId = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO dkp_ledger (id, team_id, user_id, amount, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(dkpId, teamId, body.recipientId, -body.dkpCost, `Loot: ${body.itemName.trim()}`, user.userId).run();
    }

    return json({ ok: true, id });
  } },

  { method: 'DELETE', pattern: /^\/api\/teams\/([^/]+)\/loot\/([^/]+)$/, handler: async ({ env, user, params }) => {
    const [, teamId, lootId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);

    await env.DB.prepare('DELETE FROM boss_loot WHERE id = ? AND team_id = ?').bind(lootId, teamId).run();
    return json({ ok: true });
  } },

  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/wishlist$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);
    if (!(await isPremiumTeam(env, teamId))) return json({ error: 'Premium required', premiumRequired: true }, 403);

    const query = member.role === 'member'
      ? 'SELECT lw.*, u.username FROM loot_wishlist lw JOIN users u ON u.id = lw.user_id WHERE lw.team_id = ? AND lw.user_id = ? ORDER BY lw.priority DESC'
      : 'SELECT lw.*, u.username FROM loot_wishlist lw JOIN users u ON u.id = lw.user_id WHERE lw.team_id = ? ORDER BY lw.item_name, lw.priority DESC';

    const wishes = member.role === 'member'
      ? await env.DB.prepare(query).bind(teamId, user.userId).all()
      : await env.DB.prepare(query).bind(teamId).all();

    return json({ wishes: wishes.results });
  } },

  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/wishlist$/, handler: async ({ request, env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);
    if (!(await isPremiumTeam(env, teamId))) return json({ error: 'Premium required', premiumRequired: true }, 403);

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.itemName?.trim()) return json({ error: 'Item name required' }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO loot_wishlist (id, team_id, user_id, item_name, boss_name, priority) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, teamId, user.userId, body.itemName.trim(), body.bossName || null, body.priority || 1).run();
    return json({ ok: true, id });
  } },

  { method: 'DELETE', pattern: /^\/api\/teams\/([^/]+)\/wishlist\/([^/]+)$/, handler: async ({ env, user, params }) => {
    const [, teamId, wishId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);
    await env.DB.prepare('DELETE FROM loot_wishlist WHERE id = ? AND (user_id = ? OR ? IN ("leader","officer"))')
      .bind(wishId, user.userId, member.role).run();
    return json({ ok: true });
  } },
];
