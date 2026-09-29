// Account: export my data, delete my account (protected routes).
//
// Deletion keeps the users row as an anonymised stub (id only) because team histories reference
// it: events you created, loot you received, points you were awarded, kills you logged. Those stay
// with the team as "Deleted user". Everything personal is removed: memberships, RSVPs, attendance,
// availability, notes about you, wishlists, bids, join requests, sign-in ids, avatar, licence.
// Teams you lead: deleted with you if you are the only member, otherwise the request is refused
// until you transfer or delete them (a guild's data is not wiped by one member leaving).

import { json } from '../lib/http.js';
import { teamDeleteStmts } from '../lib/team-delete.js';

const PERSONAL_ROW_TABLES = [
  ['event_rsvps', 'user_id'], ['event_attendance', 'user_id'], ['member_activity', 'user_id'],
  ['member_availability', 'user_id'], ['member_notes', 'target_user_id'], ['loot_wishlist', 'user_id'],
  ['dkp_bids', 'user_id'], ['join_requests', 'user_id'], ['team_members', 'user_id'],
  ['push_subs', 'user_id'], ['push_prefs', 'user_id'],
];

export const routes = [
  // GET /api/me/export — everything about you, plus the full data of teams you lead. JSON download.
  // (getUser accepts ?token= on /export paths, so the app can open this in a new tab.)
  { method: 'GET', pattern: '/api/me/export', handler: async ({ env, user }) => {
    const me = await env.DB.prepare('SELECT id, username, auth_type, avatar, premium, premium_type, premium_until, trial_started, created_at FROM users WHERE id = ?').bind(user.userId).first();
    if (!me) return json({ error: 'User not found' }, 404);

    const [memberships, ownedTeams] = await Promise.all([
      env.DB.prepare('SELECT t.id AS team_id, t.name AS team, m.role, m.game_role, m.joined_at FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?').bind(user.userId).all(),
      env.DB.prepare('SELECT * FROM teams WHERE owner_id = ?').bind(user.userId).all(),
    ]);

    const teamDump = async (team) => {
      const q = (sql) => env.DB.prepare(sql).bind(team.id).all().then(r => r.results);
      const [settings, members, bosses, events, rsvps, attendance, loot, ledger, wishlist, kills, requests] = await Promise.all([
        env.DB.prepare('SELECT * FROM team_settings WHERE team_id = ?').bind(team.id).first(),
        q('SELECT m.user_id, u.username, m.role, m.game_role, m.joined_at FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ?'),
        q('SELECT * FROM bosses WHERE team_id = ?'),
        q('SELECT * FROM events WHERE team_id = ?'),
        q('SELECT r.* FROM event_rsvps r WHERE r.event_id IN (SELECT id FROM events WHERE team_id = ?)'),
        q('SELECT a.* FROM event_attendance a WHERE a.event_id IN (SELECT id FROM events WHERE team_id = ?)'),
        q('SELECT * FROM boss_loot WHERE team_id = ?'),
        q('SELECT * FROM dkp_ledger WHERE team_id = ?'),
        q('SELECT * FROM loot_wishlist WHERE team_id = ?'),
        q('SELECT * FROM boss_kill_log WHERE team_id = ?'),
        q('SELECT * FROM join_requests WHERE team_id = ?'),
      ]);
      return { team, settings, members, bosses, events, rsvps, attendance, loot, ledger, wishlist, kills, joinRequests: requests };
    };

    const body = {
      exportedAt: new Date().toISOString(),
      profile: me,
      memberships: memberships.results,
      teamsYouLead: await Promise.all(ownedTeams.results.map(teamDump)),
    };
    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="guild-manager-export.json"', 'Access-Control-Allow-Origin': 'https://anomaly-gg.github.io' },
    });
  } },

  // DELETE /api/me — anonymise the account and remove personal rows (see header comment).
  { method: 'DELETE', pattern: '/api/me', handler: async ({ env, user }) => {
    const me = await env.DB.prepare('SELECT id, auth_type FROM users WHERE id = ?').bind(user.userId).first();
    if (!me || me.auth_type === 'deleted') return json({ error: 'Account not found' }, 404);

    const owned = await env.DB.prepare(
      'SELECT t.id, t.name, (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id AND m.user_id != ?) AS others FROM teams t WHERE t.owner_id = ?'
    ).bind(user.userId, user.userId).all();
    const blocking = owned.results.filter(t => t.others > 0);
    if (blocking.length) {
      return json({ error: 'You lead teams that still have other members. Transfer leadership or delete those teams first.', teams: blocking.map(t => ({ id: t.id, name: t.name, members: t.others + 1 })) }, 409);
    }

    const stmts = [];
    for (const t of owned.results) stmts.push(...teamDeleteStmts(env, t.id));
    for (const [table, col] of PERSONAL_ROW_TABLES) stmts.push(env.DB.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).bind(user.userId));
    stmts.push(env.DB.prepare(
      `UPDATE users SET username = 'Deleted user', discord_id = ?, google_id = NULL, avatar = NULL, auth_type = 'deleted',
       premium = 0, premium_type = NULL, premium_until = NULL, gumroad_license = NULL, gumroad_product = NULL, license_checked_at = NULL,
       trial_started = NULL, trial_used = 1 WHERE id = ?`
    ).bind('deleted_' + user.userId, user.userId));
    await env.DB.batch(stmts);

    return json({ ok: true, deletedTeams: owned.results.map(t => t.name) });
  } },
];
