// Events, RSVPs (with roles + caps), lineup, attendance, event templates, attendance report,
// iCal export (protected routes)

import { json, safeJson } from '../lib/http.js';
import { sendDiscord } from '../lib/discord.js';
import { alertHooks } from '../lib/webhooks.js';
import { requireTeamMember, isPremiumTeam } from '../lib/team.js';

export const DEFAULT_RSVP_ROLES = ['Tank', 'Healer', 'DPS', 'Support'];
const RECURRENCE = ['daily', 'weekly', 'biweekly', 'monthly'];
const RRULE = { daily: 'FREQ=DAILY', weekly: 'FREQ=WEEKLY', biweekly: 'FREQ=WEEKLY;INTERVAL=2', monthly: 'FREQ=MONTHLY' };

export function parseRoles(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(arr) && arr.length) return arr.map(s => String(s).trim().slice(0, 20)).filter(Boolean).slice(0, 8);
  } catch {}
  return DEFAULT_RSVP_ROLES;
}

function cleanLineup(raw) {
  if (!Array.isArray(raw)) return null;
  return JSON.stringify(raw.slice(0, 40).map(s => ({
    role: String(s?.role || 'Member').trim().slice(0, 30),
    userId: s?.userId ? String(s.userId).slice(0, 64) : null,
  })));
}

function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function icsText(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

async function canEditEvent(env, teamId, eventId, member) {
  const event = await env.DB.prepare('SELECT * FROM events WHERE id = ? AND team_id = ?').bind(eventId, teamId).first();
  if (!event) return { error: json({ error: 'Not found' }, 404) };
  if (event.created_by !== member.userId && member.role === 'member') return { error: json({ error: 'No permission' }, 403) };
  return { event };
}

export const routes = [
  // GET /api/teams/:id/events — events (last 90 days + future) with counts, plus every RSVP for them
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/events$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    const since = Date.now() - 90 * 86400000;
    const events = await env.DB.prepare(`
      SELECT e.*, u.username as creator_name,
        (SELECT COUNT(*) FROM event_rsvps WHERE event_id = e.id AND status = 'going') as going_count,
        (SELECT COUNT(*) FROM event_rsvps WHERE event_id = e.id AND status = 'maybe') as maybe_count,
        (SELECT COUNT(*) FROM event_rsvps WHERE event_id = e.id AND status = 'not_going') as not_going_count,
        (SELECT status FROM event_rsvps WHERE event_id = e.id AND user_id = ?) as my_rsvp,
        (SELECT role FROM event_rsvps WHERE event_id = e.id AND user_id = ?) as my_role
      FROM events e
      JOIN users u ON u.id = e.created_by
      WHERE e.team_id = ? AND e.event_time > ?
      ORDER BY e.event_time ASC
    `).bind(user.userId, user.userId, teamId, since).all();

    const rsvps = await env.DB.prepare(`
      SELECT r.event_id, r.user_id, r.status, r.role, u.username
      FROM event_rsvps r
      JOIN users u ON u.id = r.user_id
      JOIN events e ON e.id = r.event_id
      WHERE e.team_id = ? AND e.event_time > ?
      ORDER BY r.responded_at ASC
    `).bind(teamId, since).all();

    return json({ events: events.results, rsvps: rsvps.results });
  } },

  // POST /api/teams/:id/events — create event
  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/events$/, handler: async ({ request, env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    // Check if members can create events
    if (member.role === 'member') {
      const ts = await env.DB.prepare('SELECT members_create_events FROM team_settings WHERE team_id = ?').bind(teamId).first();
      if (ts && !ts.members_create_events) return json({ error: 'Only officers+ can create events' }, 403);
    }

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.title?.trim() || !body.eventTime) return json({ error: 'Title and time required' }, 400);
    const title = String(body.title).trim().slice(0, 100);
    const eventTime = Number(body.eventTime);
    if (!Number.isFinite(eventTime)) return json({ error: 'Invalid time' }, 400);

    const id = crypto.randomUUID();
    const recurrence = RECURRENCE.includes(body.recurrence) ? body.recurrence : null;
    const maxGoing = Math.max(0, Math.min(500, parseInt(body.maxGoing) || 0));
    await env.DB.prepare(`INSERT INTO events (id, team_id, title, description, event_type, event_time, duration_minutes, created_by, recurrence, max_going) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, teamId, title, body.description ? String(body.description).slice(0, 2000) : null, body.eventType || 'other',
        eventTime, Math.max(5, Math.min(1440, parseInt(body.durationMinutes) || 60)), user.userId, recurrence, maxGoing).run();

    // Auto-RSVP creator as going
    await env.DB.prepare('INSERT INTO event_rsvps (event_id, user_id, status, role) VALUES (?, ?, ?, ?)')
      .bind(id, user.userId, 'going', body.myRole ? String(body.myRole).slice(0, 20) : null).run();

    // Discord notification
    const settings = await env.DB.prepare('SELECT * FROM team_settings WHERE team_id = ?').bind(teamId).first();
    const eventHooks = alertHooks(settings, 'events');
    if (eventHooks.length) {
      const date = new Date(eventTime).toLocaleString('en-US', { timeZone: settings.timezone || 'Asia/Manila' });
      await sendDiscord(env, eventHooks, `New Event: ${title}`,
        `**${title}** scheduled for **${date}**\nCreated by ${user.username}${body.description ? '\n\n' + body.description : ''}`,
        5793266);
    }

    return json({ ok: true, id });
  } },

  // GET /api/teams/:id/events/export — iCal feed (token may come via ?token= for calendar apps)
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/events\/export$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);
    if (!(await isPremiumTeam(env, teamId))) return json({ error: 'Premium required', premiumRequired: true }, 403);
    const team = await env.DB.prepare('SELECT name FROM teams WHERE id = ?').bind(teamId).first();
    const events = await env.DB.prepare('SELECT * FROM events WHERE team_id = ? AND event_time > ? ORDER BY event_time ASC')
      .bind(teamId, Date.now() - 30 * 86400000).all();

    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Guild Manager//Events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsText(team?.name || 'Guild')} events`];
    for (const e of events.results) {
      lines.push('BEGIN:VEVENT', `UID:${e.id}@guild-manager`, `DTSTAMP:${icsDate(Date.now())}`, `DTSTART:${icsDate(e.event_time)}`,
        `DURATION:PT${Math.max(5, e.duration_minutes || 60)}M`, `SUMMARY:${icsText(e.title)}`);
      if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
      if (e.recurrence && RRULE[e.recurrence]) lines.push(`RRULE:${RRULE[e.recurrence]}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return new Response(lines.join('\r\n') + '\r\n', {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="events.ics"', 'Cache-Control': 'no-cache' },
    });
  } },

  // PUT /api/teams/:id/events/:eventId — edit (creator or officers+); lineup lives here too
  { method: 'PUT', pattern: /^\/api\/teams\/([^/]+)\/events\/([^/]+)$/, handler: async ({ request, env, user, params }) => {
    const [, teamId, eventId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);
    const { event, error } = await canEditEvent(env, teamId, eventId, { ...member, userId: user.userId });
    if (error) return error;

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    const sets = [], vals = [];
    if (body.title !== undefined) {
      const t = String(body.title).trim().slice(0, 100);
      if (!t) return json({ error: 'Title required' }, 400);
      sets.push('title = ?'); vals.push(t);
    }
    if (body.description !== undefined) { sets.push('description = ?'); vals.push(body.description ? String(body.description).slice(0, 2000) : null); }
    if (body.eventType !== undefined) { sets.push('event_type = ?'); vals.push(String(body.eventType).slice(0, 20)); }
    if (body.eventTime !== undefined) {
      const t = Number(body.eventTime);
      if (!Number.isFinite(t)) return json({ error: 'Invalid time' }, 400);
      sets.push('event_time = ?', 'reminder_sent = 0', 'start_notified = 0', 'end_notified = 0'); vals.push(t);
    }
    if (body.durationMinutes !== undefined) { sets.push('duration_minutes = ?'); vals.push(Math.max(5, Math.min(1440, parseInt(body.durationMinutes) || 60))); }
    if (body.recurrence !== undefined) { sets.push('recurrence = ?'); vals.push(RECURRENCE.includes(body.recurrence) ? body.recurrence : null); }
    if (body.maxGoing !== undefined) { sets.push('max_going = ?'); vals.push(Math.max(0, Math.min(500, parseInt(body.maxGoing) || 0))); }
    if (body.lineup !== undefined) {
      if (member.role === 'member') return json({ error: 'Officers+ only' }, 403);
      sets.push('lineup = ?'); vals.push(body.lineup === null ? null : cleanLineup(body.lineup));
    }
    if (sets.length === 0) return json({ ok: true });
    vals.push(eventId);
    await env.DB.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    return json({ ok: true });
  } },

  // DELETE /api/teams/:id/events/:eventId
  { method: 'DELETE', pattern: /^\/api\/teams\/([^/]+)\/events\/([^/]+)$/, handler: async ({ env, user, params }) => {
    const [, teamId, eventId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);
    const { error } = await canEditEvent(env, teamId, eventId, { ...member, userId: user.userId });
    if (error) return error;

    await env.DB.batch([
      env.DB.prepare('DELETE FROM event_rsvps WHERE event_id = ?').bind(eventId),
      env.DB.prepare('DELETE FROM event_attendance WHERE event_id = ?').bind(eventId),
      env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId),
    ]);
    return json({ ok: true });
  } },

  // POST /api/teams/:id/events/:eventId/rsvp — { status, role }
  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/events\/([^/]+)\/rsvp$/, handler: async ({ request, env, user, params }) => {
    const [, teamId, eventId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    const status = ['going', 'maybe', 'not_going'].includes(body.status) ? body.status : 'going';
    const role = body.role ? String(body.role).trim().slice(0, 20) : null;

    const event = await env.DB.prepare('SELECT max_going FROM events WHERE id = ? AND team_id = ?').bind(eventId, teamId).first();
    if (!event) return json({ error: 'Event not found' }, 404);

    const existing = await env.DB.prepare('SELECT status FROM event_rsvps WHERE event_id = ? AND user_id = ?')
      .bind(eventId, user.userId).first();

    if (status === 'going' && event.max_going > 0 && existing?.status !== 'going') {
      const going = await env.DB.prepare("SELECT COUNT(*) as n FROM event_rsvps WHERE event_id = ? AND status = 'going'").bind(eventId).first();
      if (going.n >= event.max_going) return json({ error: `Event is full (${event.max_going} spots)`, full: true }, 409);
    }

    if (existing) {
      await env.DB.prepare('UPDATE event_rsvps SET status = ?, role = ?, responded_at = ? WHERE event_id = ? AND user_id = ?')
        .bind(status, role, Math.floor(Date.now() / 1000), eventId, user.userId).run();
    } else {
      await env.DB.prepare('INSERT INTO event_rsvps (event_id, user_id, status, role) VALUES (?, ?, ?, ?)')
        .bind(eventId, user.userId, status, role).run();
    }

    return json({ ok: true });
  } },

  // GET /api/teams/:id/events/:eventId/rsvps — get RSVP details
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/events\/([^/]+)\/rsvps$/, handler: async ({ env, user, params }) => {
    const [, teamId, eventId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    const rsvps = await env.DB.prepare(`
      SELECT u.username, u.avatar, u.discord_id, r.status, r.role
      FROM event_rsvps r JOIN users u ON u.id = r.user_id
      WHERE r.event_id = ? ORDER BY r.responded_at ASC
    `).bind(eventId).all();

    return json({ rsvps: rsvps.results });
  } },

  // POST /api/teams/:id/events/:eventId/attendance — mark attendance (officers+)
  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/events\/([^/]+)\/attendance$/, handler: async ({ request, env, user, params }) => {
    const [, teamId, eventId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    // body.attendance = [{userId, attended: true/false}, ...] — one batch, upsert per member
    const stmts = (body.attendance || []).slice(0, 200).map(a =>
      env.DB.prepare('INSERT INTO event_attendance (event_id, user_id, attended) VALUES (?, ?, ?) ON CONFLICT(event_id, user_id) DO UPDATE SET attended = excluded.attended')
        .bind(eventId, String(a.userId), a.attended ? 1 : 0));
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  } },

  // GET /api/teams/:id/events/:eventId/attendance
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/events\/([^/]+)\/attendance$/, handler: async ({ env, user, params }) => {
    const [, teamId, eventId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    const attendance = await env.DB.prepare(`
      SELECT a.user_id, u.username, u.avatar, u.discord_id, a.attended
      FROM event_attendance a JOIN users u ON u.id = a.user_id
      WHERE a.event_id = ?
    `).bind(eventId).all();

    return json({ attendance: attendance.results });
  } },

  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/event-templates$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);
    if (!(await isPremiumTeam(env, teamId))) return json({ error: 'Premium required', premiumRequired: true }, 403);

    const templates = await env.DB.prepare('SELECT * FROM event_templates WHERE team_id = ? ORDER BY name')
      .bind(teamId).all();
    return json({ templates: templates.results });
  } },

  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/event-templates$/, handler: async ({ request, env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);
    if (!(await isPremiumTeam(env, teamId))) return json({ error: 'Premium required', premiumRequired: true }, 403);

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.name?.trim() || !body.title?.trim()) return json({ error: 'Name and title required' }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO event_templates (id, team_id, name, title, description, event_type, duration_minutes, recurrence, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, teamId, body.name.trim(), body.title.trim(), body.description || null, body.eventType || 'other', body.durationMinutes || 60, body.recurrence || null, user.userId).run();
    return json({ ok: true, id });
  } },

  { method: 'DELETE', pattern: /^\/api\/teams\/([^/]+)\/event-templates\/([^/]+)$/, handler: async ({ env, user, params }) => {
    const [, teamId, templateId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);
    await env.DB.prepare('DELETE FROM event_templates WHERE id = ? AND team_id = ?').bind(templateId, teamId).run();
    return json({ ok: true });
  } },

  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/attendance-report$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);
    if (!(await isPremiumTeam(env, teamId))) return json({ error: 'Premium required', premiumRequired: true }, 403);

    const report = await env.DB.prepare(`
      SELECT u.id, u.username, u.avatar,
        (SELECT COUNT(DISTINCT ea.event_id) FROM event_attendance ea
         JOIN events e ON e.id = ea.event_id WHERE ea.user_id = u.id AND e.team_id = ? AND ea.attended = 1) as attended,
        (SELECT COUNT(*) FROM events WHERE team_id = ?) as total_events,
        (SELECT COUNT(DISTINCT er.event_id) FROM event_rsvps er
         JOIN events e ON e.id = er.event_id WHERE er.user_id = u.id AND e.team_id = ? AND er.status = 'going') as rsvp_going
      FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ?
      ORDER BY attended DESC
    `).bind(teamId, teamId, teamId, teamId).all();

    return json({ report: report.results });
  } },
];
