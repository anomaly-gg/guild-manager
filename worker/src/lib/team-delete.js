// Statements that remove a team and everything under it, grandchildren -> children -> team.
// D1 enforces FOREIGN KEYs, so every table that references teams (directly or via a child)
// must be cleared. Used by DELETE /api/teams/:id and by account deletion (teams you lead alone).

export function teamDeleteStmts(env, teamId) {
  const t = (sql) => env.DB.prepare(sql).bind(teamId);
  return [
    t('DELETE FROM event_rsvps WHERE event_id IN (SELECT id FROM events WHERE team_id = ?)'),
    t('DELETE FROM event_attendance WHERE event_id IN (SELECT id FROM events WHERE team_id = ?)'),
    t('DELETE FROM dkp_bids WHERE auction_id IN (SELECT id FROM dkp_auctions WHERE team_id = ?)'),
    t('DELETE FROM events WHERE team_id = ?'),
    t('DELETE FROM bosses WHERE team_id = ?'),
    t('DELETE FROM member_notes WHERE team_id = ?'),
    t('DELETE FROM member_activity WHERE team_id = ?'),
    t('DELETE FROM member_availability WHERE team_id = ?'),
    t('DELETE FROM boss_loot WHERE team_id = ?'),
    t('DELETE FROM boss_kill_log WHERE team_id = ?'),
    t('DELETE FROM dkp_ledger WHERE team_id = ?'),
    t('DELETE FROM dkp_auctions WHERE team_id = ?'),
    t('DELETE FROM loot_wishlist WHERE team_id = ?'),
    t('DELETE FROM event_templates WHERE team_id = ?'),
    t('DELETE FROM join_requests WHERE team_id = ?'),
    t('DELETE FROM attendance_claims WHERE team_id = ?'),
    t('DELETE FROM schedule_spawns WHERE team_id = ?'),
    t('DELETE FROM discord_guilds WHERE team_id = ?'),
    t('DELETE FROM push_prefs WHERE team_id = ?'),
    t('DELETE FROM team_settings WHERE team_id = ?'),
    t('DELETE FROM team_members WHERE team_id = ?'),
    t('DELETE FROM teams WHERE id = ?'),
  ];
}
