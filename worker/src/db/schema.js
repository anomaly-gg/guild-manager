// Schema creation + idempotent migrations. Runs once per isolate.

let _dbInit = null; // per-isolate memo; reset to null on failure so the next request retries

export function ensureSchema(env) {
  if (!_dbInit) _dbInit = initDB(env.DB).catch(e => { _dbInit = null; console.error('initDB error:', e); });
  return _dbInit;
}

async function initDB(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      discord_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      avatar TEXT,
      premium INTEGER DEFAULT 0,
      premium_type TEXT,
      premium_until INTEGER,
      ls_customer_id TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL,
      max_members INTEGER DEFAULT 5,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (owner_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joined_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (team_id, user_id),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS bosses (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      interval_ms INTEGER,
      fixed_time TEXT,
      weekly_day INTEGER,
      weekly_time TEXT,
      biweekly_days TEXT,
      alert_minutes INTEGER DEFAULT 5,
      auto_reset_minutes INTEGER DEFAULT 5,
      next_spawn INTEGER NOT NULL,
      status TEXT DEFAULT 'waiting',
      spawned_at INTEGER,
      auto_reset_at INTEGER,
      last_death INTEGER,
      warned INTEGER DEFAULT 0,
      spawn_notified INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      event_type TEXT DEFAULT 'other',
      event_time INTEGER NOT NULL,
      duration_minutes INTEGER DEFAULT 60,
      created_by TEXT NOT NULL,
      reminder_sent INTEGER DEFAULT 0,
      start_notified INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS event_rsvps (
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'going',
      responded_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (event_id, user_id),
      FOREIGN KEY (event_id) REFERENCES events(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS event_attendance (
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      attended INTEGER DEFAULT 0,
      PRIMARY KEY (event_id, user_id),
      FOREIGN KEY (event_id) REFERENCES events(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS team_settings (
      team_id TEXT PRIMARY KEY,
      webhook_url TEXT,
      on_warning INTEGER DEFAULT 1,
      on_spawn INTEGER DEFAULT 1,
      on_announcement INTEGER DEFAULT 1,
      timezone TEXT DEFAULT 'Asia/Manila',
      FOREIGN KEY (team_id) REFERENCES teams(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS member_activity (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_seen INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (team_id, user_id),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS boss_loot (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      boss_id TEXT,
      boss_name TEXT NOT NULL,
      item_name TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      dkp_cost INTEGER DEFAULT 0,
      noted_by TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (recipient_id) REFERENCES users(id),
      FOREIGN KEY (noted_by) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS dkp_ledger (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS member_availability (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      day INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id, day, start_time),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`),
  ]);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS member_notes (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (target_user_id) REFERENCES users(id),
      FOREIGN KEY (author_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS boss_kill_log (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      boss_id TEXT NOT NULL,
      boss_name TEXT NOT NULL,
      killed_at INTEGER NOT NULL,
      killed_by TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS boss_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      game TEXT NOT NULL,
      bosses TEXT NOT NULL,
      is_global INTEGER DEFAULT 0,
      created_by TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS event_templates (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      event_type TEXT DEFAULT 'other',
      duration_minutes INTEGER DEFAULT 60,
      recurrence TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS loot_wishlist (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      boss_name TEXT,
      priority INTEGER DEFAULT 1,
      fulfilled INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS dkp_auctions (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      boss_name TEXT,
      started_by TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      min_bid INTEGER DEFAULT 0,
      winner_id TEXT,
      winning_bid INTEGER,
      expires_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS dkp_bids (
      id TEXT PRIMARY KEY,
      auction_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (auction_id) REFERENCES dkp_auctions(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`),
  ]);


  // Run migrations (each one is idempotent via catch).
  // Probes MUST include the newest added column/table — otherwise DBs that passed
  // older probes will silently miss newer migrations forever.
  // One sqlite_master read instead of one SELECT per probe: on a healthy DB every probe used to
  // pass and run in turn = 10 sequential D1 round trips per cold isolate, which from a far colo
  // (Gumroad's webhook arrives via IAD) took long enough for the caller to time out.
  const PROBES = [
    ['users', 'premium'], ['team_settings', 'accent_color'], ['users', 'trial_started'], ['users', 'google_id'],
    ['team_settings', 'invites_enabled'], ['join_requests', null], ['team_settings', 'public_token'],
    ['team_settings', 'rsvp_roles'], ['team_settings', 'points_name'], ['users', 'gumroad_license'],
    ['team_settings', 'discord_guild_id'], ['discord_guilds', null], ['attendance_claims', null], ['team_settings', 'attendance_self_checkin'],
    ['schedule_spawns', null], ['team_settings', 'spawn_groups'], ['bosses', 'spawn_group'], ['app_state', null],
    ['discord_cleanup', null], ['team_settings', 'discord_delete_next_min'], ['bosses', 'alert_spawn_msg'], ['bosses', 'alternate_groups'],
    ['push_subs', null], ['push_prefs', null], ['team_settings', 'maintenance_count'], ['team_settings', 'maintenance_from'],
  ];
  const tables = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
  const createSql = Object.fromEntries(tables.results.map(t => [t.name, t.sql || '']));
  const present = (table, column) => {
    const sql = createSql[table];
    if (sql === undefined) return false;
    if (!column) return true;
    return sql.split(/[\s(),"`[\]]+/).some(tok => tok.toLowerCase() === column);
  };
  const needsMigrations = PROBES.some(([table, column]) => !present(table, column));
  if (needsMigrations) {
    const migrations = [
      'ALTER TABLE users ADD COLUMN premium INTEGER DEFAULT 0',
      'ALTER TABLE users ADD COLUMN premium_type TEXT',
      'ALTER TABLE users ADD COLUMN premium_until INTEGER',
      'ALTER TABLE users ADD COLUMN ls_customer_id TEXT',
      'ALTER TABLE team_settings ADD COLUMN on_announcement INTEGER DEFAULT 1',
      'ALTER TABLE team_settings ADD COLUMN on_event INTEGER DEFAULT 1',
      'ALTER TABLE team_settings ADD COLUMN on_war INTEGER DEFAULT 1',
      'ALTER TABLE team_settings ADD COLUMN event_reminder_minutes INTEGER DEFAULT 15',
      'ALTER TABLE team_settings ADD COLUMN inactive_days INTEGER DEFAULT 7',
      'ALTER TABLE team_settings ADD COLUMN default_event_duration INTEGER DEFAULT 60',
      'ALTER TABLE team_settings ADD COLUMN team_description TEXT',
      'ALTER TABLE team_settings ADD COLUMN members_create_events INTEGER DEFAULT 1',
      'ALTER TABLE team_settings ADD COLUMN auto_delete_events_days INTEGER DEFAULT 0',
      'ALTER TABLE team_settings ADD COLUMN auto_delete_chat_days INTEGER DEFAULT 0',
      'ALTER TABLE team_settings ADD COLUMN starting_dkp INTEGER DEFAULT 0',
      'ALTER TABLE events ADD COLUMN recurrence TEXT',
      'ALTER TABLE events ADD COLUMN parent_event_id TEXT',
      'ALTER TABLE events ADD COLUMN end_notified INTEGER DEFAULT 0',
      'ALTER TABLE team_settings ADD COLUMN webhook_boss TEXT',
      'ALTER TABLE team_settings ADD COLUMN webhook_events TEXT',
      'ALTER TABLE team_settings ADD COLUMN webhook_wars TEXT',
      'ALTER TABLE team_settings ADD COLUMN webhook_announcements TEXT',
      'ALTER TABLE team_settings ADD COLUMN dkp_decay_enabled INTEGER DEFAULT 0',
      'ALTER TABLE team_settings ADD COLUMN dkp_decay_percent INTEGER DEFAULT 10',
      'ALTER TABLE team_settings ADD COLUMN dkp_decay_inactive_days INTEGER DEFAULT 14',
      'ALTER TABLE team_settings ADD COLUMN dkp_decay_interval_days INTEGER DEFAULT 7',
      'ALTER TABLE team_settings ADD COLUMN dkp_decay_last_run INTEGER',
      'ALTER TABLE team_settings ADD COLUMN accent_color TEXT',
      'ALTER TABLE team_settings ADD COLUMN team_icon TEXT',
      'ALTER TABLE users ADD COLUMN trial_started INTEGER',
      'ALTER TABLE users ADD COLUMN trial_used INTEGER DEFAULT 0',
      'ALTER TABLE users ADD COLUMN google_id TEXT',
      'ALTER TABLE users ADD COLUMN auth_type TEXT DEFAULT "discord"',
      'ALTER TABLE bosses ADD COLUMN auto_reset_minutes INTEGER DEFAULT 5',
      'ALTER TABLE team_settings ADD COLUMN invites_enabled INTEGER DEFAULT 1',
      'ALTER TABLE team_settings ADD COLUMN invite_approval INTEGER DEFAULT 0',
      'ALTER TABLE bosses ADD COLUMN window_ms INTEGER DEFAULT 0',
      'ALTER TABLE bosses ADD COLUMN location TEXT',
      'ALTER TABLE team_settings ADD COLUMN public_token TEXT',
      'ALTER TABLE events ADD COLUMN max_going INTEGER DEFAULT 0',
      'ALTER TABLE events ADD COLUMN lineup TEXT',
      'ALTER TABLE event_rsvps ADD COLUMN role TEXT',
      'ALTER TABLE team_settings ADD COLUMN rsvp_roles TEXT',
      'ALTER TABLE team_members ADD COLUMN game_role TEXT',
      'ALTER TABLE team_settings ADD COLUMN modules TEXT',
      'ALTER TABLE team_settings ADD COLUMN loot_mode TEXT',
      'ALTER TABLE team_members ADD COLUMN loot_pos INTEGER',
      'ALTER TABLE team_settings ADD COLUMN on_loot INTEGER DEFAULT 1',
      'ALTER TABLE team_settings ADD COLUMN points_name TEXT',
      'ALTER TABLE users ADD COLUMN gumroad_license TEXT',
      'ALTER TABLE users ADD COLUMN gumroad_product TEXT',
      'ALTER TABLE users ADD COLUMN license_checked_at INTEGER',
      'ALTER TABLE team_settings ADD COLUMN discord_guild_id TEXT',
      `CREATE TABLE IF NOT EXISTS discord_guilds (
        guild_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        guild_name TEXT,
        linked_by TEXT,
        linked_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      )`,
      `CREATE TABLE IF NOT EXISTS attendance_claims (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        bosses TEXT NOT NULL,
        day TEXT NOT NULL,
        source TEXT NOT NULL,
        image_key TEXT,
        image_sha256 TEXT,
        note TEXT,
        flags TEXT,
        status TEXT DEFAULT 'pending',
        points INTEGER DEFAULT 1,
        reviewed_by TEXT,
        reviewed_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (team_id) REFERENCES teams(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      'ALTER TABLE team_settings ADD COLUMN attendance_points INTEGER DEFAULT 1',
      'ALTER TABLE team_settings ADD COLUMN attendance_auto_approve INTEGER DEFAULT 0',
      'ALTER TABLE team_settings ADD COLUMN attendance_self_checkin INTEGER DEFAULT 1',
      // daily schedule post (lib/schedule-post.js) + officer-assigned spawn groups
      'ALTER TABLE team_settings ADD COLUMN webhook_schedule TEXT',
      'ALTER TABLE team_settings ADD COLUMN schedule_day TEXT',
      'ALTER TABLE team_settings ADD COLUMN schedule_msg_id TEXT',
      'ALTER TABLE team_settings ADD COLUMN schedule_prev_day TEXT',
      'ALTER TABLE team_settings ADD COLUMN schedule_prev_msg_id TEXT',
      'ALTER TABLE team_settings ADD COLUMN spawn_groups TEXT',
      'ALTER TABLE bosses ADD COLUMN spawn_group TEXT',
      `CREATE TABLE IF NOT EXISTS schedule_spawns (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        boss_id TEXT,
        boss_name TEXT NOT NULL,
        location TEXT,
        spawn_at INTEGER NOT NULL,
        day TEXT NOT NULL,
        outcome TEXT NOT NULL,
        group_id TEXT,
        ended_at INTEGER NOT NULL,
        FOREIGN KEY (team_id) REFERENCES teams(id)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_schedule_spawns_team_day ON schedule_spawns (team_id, day)',
      // small key/value store for app-wide state (e.g. the slash-command list Discord last accepted)
      'CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)',
      // slash-command reply auto-delete (lib/discord-cleanup.js)
      'ALTER TABLE team_settings ADD COLUMN discord_autodelete INTEGER DEFAULT 1',
      'ALTER TABLE team_settings ADD COLUMN discord_delete_action_min INTEGER DEFAULT 1',
      'ALTER TABLE team_settings ADD COLUMN discord_delete_next_min INTEGER DEFAULT 5',
      'CREATE TABLE IF NOT EXISTS discord_cleanup (token TEXT PRIMARY KEY, delete_at INTEGER NOT NULL)',
      // boss alerts edited in place (lib/boss-alerts.js)
      'ALTER TABLE bosses ADD COLUMN alert_soon_msg TEXT',
      'ALTER TABLE bosses ADD COLUMN alert_spawn_msg TEXT',
      // groups for the spawns after the next one + alternation (lib/spawn-groups.js)
      'ALTER TABLE bosses ADD COLUMN later_groups TEXT',
      'ALTER TABLE bosses ADD COLUMN alternate_groups INTEGER DEFAULT 0',
      // carry over the single-server links made before this table existed
      'INSERT OR IGNORE INTO discord_guilds (guild_id, team_id) SELECT discord_guild_id, team_id FROM team_settings WHERE discord_guild_id IS NOT NULL',
      // phone alerts (M14 web push): one row per browser/device; per-member choices per team
      `CREATE TABLE IF NOT EXISTS push_subs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        fails INTEGER NOT NULL DEFAULT 0,
        pending INTEGER NOT NULL DEFAULT 0,
        test_at INTEGER
      )`,
      'CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subs (user_id)',
      `CREATE TABLE IF NOT EXISTS push_prefs (
        user_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        soon INTEGER NOT NULL DEFAULT 1,
        spawned INTEGER NOT NULL DEFAULT 1,
        groups TEXT,
        PRIMARY KEY (user_id, team_id)
      )`,
      // the last maintenance reset (routes/maintenance-reset.js), so phones show one alert for it
      'ALTER TABLE team_settings ADD COLUMN maintenance_at INTEGER',
      'ALTER TABLE team_settings ADD COLUMN maintenance_count INTEGER',
      // start of that maintenance window: the reset dialog offers the same times next time
      'ALTER TABLE team_settings ADD COLUMN maintenance_from INTEGER',
      `CREATE TABLE IF NOT EXISTS join_requests (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (unixepoch()),
        resolved_by TEXT,
        resolved_at INTEGER,
        FOREIGN KEY (team_id) REFERENCES teams(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
    ];
    // prepare().run() — NOT db.exec(): D1's exec() splits on newlines, so the
    // multi-line CREATE TABLE above could never succeed and the probe failed forever.
    for (const sql of migrations) await db.prepare(sql).run().catch(() => {});
  }
}
