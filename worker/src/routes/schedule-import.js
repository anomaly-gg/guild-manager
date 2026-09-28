// Timer import from a schedule screenshot (protected). The browser reads the image (OCR) and the
// officer reviews the matches; this route applies the reviewed list in one batch:
//   update: an existing timer's next spawn (and the spawn's group, when the line had a tag)
//   add:    a new timer (preset/rule from the client) starting at that spawn
// A name that already exists is never added twice, whatever the client sent.

import { json, safeJson } from '../lib/http.js';
import { requireTeamMember, isPremiumTeam } from '../lib/team.js';
import { limitsFor } from '../lib/limits.js';
import { bossInsertStmt } from '../lib/boss-create.js';
import { parseGroups } from '../lib/spawn-groups.js';
import { queueScheduleRefresh } from '../lib/schedule-post.js';

const DAY = 86400000;
const MAX_ITEMS = 100;
const RULE_KEYS = ['type', 'intervalMs', 'fixedTime', 'weeklyDay', 'weeklyTime', 'biweeklyDays', 'twiceDailyTimes', 'windowMs', 'location', 'alertMinutes', 'autoResetMinutes'];

export const routes = [
  // POST /api/teams/:id/bosses/import-schedule { items: [{ bossId? | add: { name, type, ... }, nextSpawn, groupId? }] }
  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/bosses\/import-schedule$/, handler: async ({ request, env, ctx, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);
    const body = await safeJson(request);
    const items = Array.isArray(body?.items) ? body.items.slice(0, MAX_ITEMS) : null;
    if (!items?.length) return json({ error: 'Nothing to import' }, 400);

    const [bossRows, settingsRows] = await env.DB.batch([
      env.DB.prepare('SELECT id, name FROM bosses WHERE team_id = ?').bind(teamId),
      env.DB.prepare('SELECT timezone, spawn_groups FROM team_settings WHERE team_id = ?').bind(teamId),
    ]);
    const existing = bossRows.results;
    const byId = new Map(existing.map(b => [b.id, b]));
    const byName = new Map(existing.map(b => [b.name.trim().toLowerCase(), b]));
    const tz = settingsRows.results[0]?.timezone || 'Asia/Manila';
    const groupIds = new Set(parseGroups(settingsRows.results[0]?.spawn_groups).map(g => g.id));
    const now = Date.now();

    const stmts = [], updated = [], added = [], skipped = [];
    const touched = new Set();
    let room = null;   // free-plan timer room, computed on the first add
    for (const it of items) {
      const at = Number(it?.nextSpawn);
      if (!Number.isFinite(at) || at < now - DAY || at > now + 8 * DAY) { skipped.push({ name: it?.add?.name || byId.get(it?.bossId)?.name || '?', why: 'time out of range' }); continue; }
      const groupId = it.groupId && groupIds.has(String(it.groupId)) ? String(it.groupId) : null;
      const target = byId.get(it.bossId) || (it.add?.name && byName.get(String(it.add.name).trim().toLowerCase()));
      if (target) {
        if (touched.has(target.id)) { skipped.push({ name: target.name, why: 'listed twice' }); continue; }
        touched.add(target.id);
        stmts.push(env.DB.prepare(`UPDATE bosses SET next_spawn = ?, status = 'waiting', spawned_at = NULL, auto_reset_at = NULL, warned = 0, spawn_notified = 0,
            alert_soon_msg = NULL, alert_spawn_msg = NULL, spawn_group = COALESCE(?, spawn_group) WHERE id = ? AND team_id = ?`)
          .bind(at, groupId, target.id, teamId));
        updated.push(target.name);
        continue;
      }
      const name = String(it.add?.name || '').trim().slice(0, 100);
      if (!name || !it.add?.type) { skipped.push({ name: name || '?', why: 'no spawn rule' }); continue; }
      if (room === null) {
        const cap = limitsFor(await isPremiumTeam(env, teamId)).timers;
        room = Number.isFinite(cap) ? Math.max(0, cap - existing.length) : Infinity;
      }
      if (room <= 0) { skipped.push({ name, why: 'free plan timer limit' }); continue; }
      const rule = Object.fromEntries(RULE_KEYS.filter(k => it.add[k] !== undefined).map(k => [k, it.add[k]]));
      const { id, stmt } = bossInsertStmt(env, teamId, { ...rule, name, nextSpawnAt: at }, tz, now);
      stmts.push(stmt);
      if (groupId) stmts.push(env.DB.prepare('UPDATE bosses SET spawn_group = ? WHERE id = ?').bind(groupId, id));
      byName.set(name.toLowerCase(), { id, name });
      touched.add(id);
      added.push(name);
      room--;
    }
    if (stmts.length) {
      await env.DB.batch(stmts);
      queueScheduleRefresh(ctx, env, teamId);
    }
    return json({ ok: true, updated, added, skipped });
  } },
];
