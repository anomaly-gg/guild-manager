// Boss timers, kills, templates, game presets, kill history (protected routes)

import { json, safeJson } from '../lib/http.js';
import { getNextFixedSpawn, getNextWeeklySpawn, getNextBiweeklySpawn, getNextTwiceDailySpawn, calcNextSpawn } from '../lib/spawn.js';
import { bossInsertStmt } from '../lib/boss-create.js';
import { killBoss } from '../lib/boss-kill.js';
import { requireTeamMember, isPremiumTeam } from '../lib/team.js';
import { limitsFor } from '../lib/limits.js';
import { PRESETS, findPreset } from '../presets/index.js';
import { queueScheduleRefresh } from '../lib/schedule-post.js';
import { parseGroups } from '../lib/spawn-groups.js';

export const routes = [
  // GET /api/teams/:id/bosses
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/bosses$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    // Spawn groups ride along (one batch = one round trip) so timer rows can show and assign them.
    const [bosses, settings] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM bosses WHERE team_id = ? ORDER BY next_spawn ASC').bind(teamId),
      env.DB.prepare('SELECT spawn_groups FROM team_settings WHERE team_id = ?').bind(teamId),
    ]);
    return json({ bosses: bosses.results, groups: parseGroups(settings.results[0]?.spawn_groups) });
  } },

  // POST /api/teams/:id/bosses — add boss
  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/bosses$/, handler: async ({ request, env, ctx, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);
    if (member.role === 'member') {
      // Members can add bosses too — officers+ can delete
    }

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.name?.trim()) return json({ error: 'Name required' }, 400);
    if (body.name.trim().length > 100) return json({ error: 'Name too long (max 100 chars)' }, 400);

    const cap = limitsFor(await isPremiumTeam(env, teamId)).timers;
    if (Number.isFinite(cap)) {
      const n = await env.DB.prepare('SELECT COUNT(*) as n FROM bosses WHERE team_id = ?').bind(teamId).first();
      if (n.n >= cap) return json({ error: `Free plan: ${cap} timers max. Upgrade for unlimited timers.`, premiumRequired: true }, 403);
    }

    const settings = await env.DB.prepare('SELECT timezone FROM team_settings WHERE team_id = ?').bind(teamId).first();
    const tz = settings?.timezone || 'Asia/Manila';

    const { id, stmt } = bossInsertStmt(env, teamId, body, tz);
    await stmt.run();
    queueScheduleRefresh(ctx, env, teamId);

    return json({ ok: true, id });
  } },

  // POST /api/teams/:id/bosses/:bossId/kill
  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/bosses\/([^/]+)\/kill$/, handler: async ({ request, env, ctx, user, params }) => {
    const [, teamId, bossId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    const body = await request.json().catch(() => ({}));
    const deathTime = Number(body.deathTime) || Date.now();
    if (deathTime < 0 || deathTime > Date.now() + 86400000) return json({ error: 'Invalid death time' }, 400);

    const boss = await env.DB.prepare('SELECT * FROM bosses WHERE id = ? AND team_id = ?').bind(bossId, teamId).first();
    if (!boss) return json({ error: 'Boss not found' }, 404);

    const settings = await env.DB.prepare('SELECT timezone FROM team_settings WHERE team_id = ?').bind(teamId).first();
    const { day } = await killBoss(env, { teamId, boss, deathTime, userId: user.userId, tz: settings?.timezone || 'Asia/Manila' });
    queueScheduleRefresh(ctx, env, teamId, { touchedDay: day });

    return json({ ok: true });
  } },

  // PUT /api/teams/:id/bosses/:bossId — edit a boss (officers+). Schedule changes recompute next_spawn.
  { method: 'PUT', pattern: /^\/api\/teams\/([^/]+)\/bosses\/([^/]+)$/, handler: async ({ request, env, ctx, user, params }) => {
    const [, teamId, bossId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    const boss = await env.DB.prepare('SELECT * FROM bosses WHERE id = ? AND team_id = ?').bind(bossId, teamId).first();
    if (!boss) return json({ error: 'Boss not found' }, 404);

    const sets = [], vals = [];
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return json({ error: 'Name required' }, 400);
      if (name.length > 100) return json({ error: 'Name too long (max 100 chars)' }, 400);
      sets.push('name = ?'); vals.push(name);
    }
    if (body.location !== undefined) { sets.push('location = ?'); vals.push(body.location ? String(body.location).trim().slice(0, 80) : null); }
    if (body.alertMinutes !== undefined) { sets.push('alert_minutes = ?'); vals.push(Math.max(1, Math.min(1440, parseInt(body.alertMinutes) || 5))); }
    if (body.autoResetMinutes !== undefined) { sets.push('auto_reset_minutes = ?'); vals.push(Math.max(1, Math.min(1440, parseInt(body.autoResetMinutes) || 5))); }
    if (body.windowMs !== undefined) { sets.push('window_ms = ?'); vals.push(Math.max(0, Math.min(86400000, parseInt(body.windowMs) || 0))); }

    const scheduleChanged = body.type !== undefined || body.intervalMs !== undefined || body.fixedTime !== undefined ||
      body.weeklyDay !== undefined || body.weeklyTime !== undefined || body.biweeklyDays !== undefined || body.twiceDailyTimes !== undefined;
    if (scheduleChanged) {
      const type = body.type || boss.type;
      const settings = await env.DB.prepare('SELECT timezone FROM team_settings WHERE team_id = ?').bind(teamId).first();
      const tz = settings?.timezone || 'Asia/Manila';
      const intervalMs = body.intervalMs ?? boss.interval_ms;
      const fixedTime = body.fixedTime ?? boss.fixed_time;
      const weeklyDay = body.weeklyDay ?? boss.weekly_day;
      const weeklyTime = body.weeklyTime ?? boss.weekly_time;
      const days = body.biweeklyDays ? JSON.stringify(body.biweeklyDays) : body.twiceDailyTimes ? JSON.stringify(body.twiceDailyTimes) : boss.biweekly_days;
      let nextSpawn;
      if (type === 'interval') {
        if (!intervalMs) return json({ error: 'Interval required' }, 400);
        nextSpawn = (boss.last_death || Date.now()) + intervalMs;
        if (nextSpawn < Date.now()) nextSpawn = Date.now() + intervalMs;
      } else if (type === 'fixed') nextSpawn = getNextFixedSpawn(fixedTime, tz);
      else if (type === 'weekly') nextSpawn = getNextWeeklySpawn(weeklyDay, weeklyTime, tz);
      else if (type === 'biweekly') nextSpawn = getNextBiweeklySpawn(days, tz);
      else if (type === 'twicedaily') nextSpawn = getNextTwiceDailySpawn(days, tz);
      else return json({ error: 'Invalid type' }, 400);
      sets.push('type = ?', 'interval_ms = ?', 'fixed_time = ?', 'weekly_day = ?', 'weekly_time = ?', 'biweekly_days = ?', 'next_spawn = ?', "status = 'waiting'", 'spawned_at = NULL', 'auto_reset_at = NULL', 'warned = 0', 'spawn_notified = 0');
      vals.push(type, type === 'interval' ? intervalMs : null, type === 'fixed' ? fixedTime : null, type === 'weekly' ? weeklyDay : null, type === 'weekly' ? weeklyTime : null, (type === 'biweekly' || type === 'twicedaily') ? days : null, nextSpawn);
    }
    if (sets.length === 0) return json({ ok: true });
    vals.push(bossId);
    await env.DB.prepare(`UPDATE bosses SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    queueScheduleRefresh(ctx, env, teamId);
    return json({ ok: true });
  } },

  // DELETE /api/teams/:id/bosses/:bossId
  { method: 'DELETE', pattern: /^\/api\/teams\/([^/]+)\/bosses\/([^/]+)$/, handler: async ({ env, ctx, user, params }) => {
    const [, teamId, bossId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);

    await env.DB.prepare('DELETE FROM bosses WHERE id = ? AND team_id = ?').bind(bossId, teamId).run();
    queueScheduleRefresh(ctx, env, teamId);
    return json({ ok: true });
  } },

  // PUT /api/teams/:id/bosses/:bossId/group { groupId | null } — tag the boss's NEXT spawn with a
  // spawn group (officers+). Cleared automatically when that spawn is killed or auto-resets.
  { method: 'PUT', pattern: /^\/api\/teams\/([^/]+)\/bosses\/([^/]+)\/group$/, handler: async ({ request, env, ctx, user, params }) => {
    const [, teamId, bossId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);
    const body = await safeJson(request);
    if (!body) return json({ error: 'Invalid request body' }, 400);
    const groupId = body.groupId ? String(body.groupId) : null;
    if (groupId) {
      const s = await env.DB.prepare('SELECT spawn_groups FROM team_settings WHERE team_id = ?').bind(teamId).first();
      if (!parseGroups(s?.spawn_groups).some(g => g.id === groupId)) return json({ error: 'Unknown group' }, 400);
    }
    const r = await env.DB.prepare('UPDATE bosses SET spawn_group = ? WHERE id = ? AND team_id = ?').bind(groupId, bossId, teamId).run();
    if (!r.meta?.changes) return json({ error: 'Boss not found' }, 404);
    queueScheduleRefresh(ctx, env, teamId);
    return json({ ok: true });
  } },

  { method: 'GET', pattern: '/api/boss-templates', handler: async ({ env, user }) => {
    const templates = await env.DB.prepare('SELECT * FROM boss_templates WHERE is_global = 1 OR created_by = ? ORDER BY game, name')
      .bind(user.userId).all();
    return json({ templates: templates.results });
  } },

  { method: 'POST', pattern: '/api/boss-templates', handler: async ({ request, env, user }) => {
    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.name?.trim() || !body.game?.trim() || !body.bosses) return json({ error: 'Name, game, and bosses required' }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO boss_templates (id, name, game, bosses, created_by) VALUES (?, ?, ?, ?, ?)')
      .bind(id, body.name.trim(), body.game.trim(), JSON.stringify(body.bosses), user.userId).run();
    return json({ ok: true, id });
  } },

  { method: 'DELETE', pattern: /^\/api\/boss-templates\/([^/]+)$/, handler: async ({ env, user, params }) => {
    await env.DB.prepare('DELETE FROM boss_templates WHERE id = ? AND created_by = ?')
      .bind(params[1], user.userId).run();
    return json({ ok: true });
  } },

  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/bosses\/import-template$/, handler: async ({ request, env, ctx, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);
    if (!(await isPremiumTeam(env, teamId))) return json({ error: 'Premium required', premiumRequired: true }, 403);

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    const template = await env.DB.prepare('SELECT * FROM boss_templates WHERE id = ?').bind(body.templateId).first();
    if (!template) return json({ error: 'Template not found' }, 404);

    const bosses = JSON.parse(template.bosses);
    const settings = await env.DB.prepare('SELECT timezone FROM team_settings WHERE team_id = ?').bind(teamId).first();
    const tz = settings?.timezone || 'Asia/Manila';

    const stmts = bosses.filter(b => b && b.name).map(b => bossInsertStmt(env, teamId, b, tz).stmt);
    if (stmts.length) { await env.DB.batch(stmts); queueScheduleRefresh(ctx, env, teamId); }
    return json({ ok: true, count: stmts.length });
  } },

  // GET /api/presets — built-in boss lists per game (free)
  { method: 'GET', pattern: '/api/presets', handler: async () => {
    return json({ presets: PRESETS.map(p => ({ id: p.id, game: p.game, note: p.note, bosses: p.bosses })) });
  } },

  // POST /api/teams/:id/bosses/presets { presetId, names?: [] } — add a game's bosses to the team.
  // Skips names the team already has, stops at the plan's timer cap, inserts in one batch.
  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/bosses\/presets$/, handler: async ({ request, env, ctx, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);

    const body = await safeJson(request);
    const preset = body && findPreset(body.presetId);
    if (!preset) return json({ error: 'Preset not found' }, 404);
    const wanted = Array.isArray(body.names) && body.names.length ? new Set(body.names.map(n => String(n).toLowerCase())) : null;

    const [existing, settings, premium] = await Promise.all([
      env.DB.prepare('SELECT name FROM bosses WHERE team_id = ?').bind(teamId).all(),
      env.DB.prepare('SELECT timezone FROM team_settings WHERE team_id = ?').bind(teamId).first(),
      isPremiumTeam(env, teamId),
    ]);
    const have = new Set(existing.results.map(r => String(r.name).toLowerCase()));
    const tz = settings?.timezone || 'Asia/Manila';
    const cap = limitsFor(premium).timers;
    let room = Number.isFinite(cap) ? Math.max(0, cap - have.size) : Infinity;

    const stmts = [], added = [], skippedExisting = [], skippedCap = [];
    for (const b of preset.bosses) {
      const key = b.name.toLowerCase();
      if (wanted && !wanted.has(key)) continue;
      if (have.has(key)) { skippedExisting.push(b.name); continue; }
      if (room <= 0) { skippedCap.push(b.name); continue; }
      stmts.push(bossInsertStmt(env, teamId, b, tz).stmt); added.push(b.name); have.add(key); room--;
    }
    if (stmts.length) { await env.DB.batch(stmts); queueScheduleRefresh(ctx, env, teamId); }
    return json({ ok: true, added, skippedExisting, skippedCap, cap: Number.isFinite(cap) ? cap : null });
  } },

  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/bosses\/history$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);
    if (!(await isPremiumTeam(env, teamId))) return json({ error: 'Premium required', premiumRequired: true }, 403);

    const history = await env.DB.prepare(`
      SELECT bkl.*, u.username as killed_by_name
      FROM boss_kill_log bkl LEFT JOIN users u ON u.id = bkl.killed_by
      WHERE bkl.team_id = ? ORDER BY bkl.killed_at DESC LIMIT 100
    `).bind(teamId).all();

    // Stats per boss
    const stats = await env.DB.prepare(`
      SELECT boss_name, COUNT(*) as kill_count, MAX(killed_at) as last_kill
      FROM boss_kill_log WHERE team_id = ? GROUP BY boss_name ORDER BY kill_count DESC
    `).bind(teamId).all();

    return json({ history: history.results, stats: stats.results });
  } },
];
