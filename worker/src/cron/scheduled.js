// Cron tick (every minute): boss timers, daily schedule posts, event notifications, recurring events, DKP decay, auctions, cleanup, license recheck

import { sendDiscord } from '../lib/discord.js';
import { calcNextSpawn } from '../lib/spawn.js';
import { recheckLicenses } from '../lib/gumroad.js';
import { spawnEndStmt, cronScheduleRefresh } from '../lib/schedule-post.js';
import { syncCommands } from '../lib/discord-commands.js';

export async function handleScheduled(env) {
  // NOTE: initDB intentionally NOT called here. Schema is created by handleRequest
  // on first user request. Running initDB on every cron tick was burning ~30ms CPU
  // on ~40 CREATE TABLE IF NOT EXISTS + migration probes, blowing the Workers Free
  // 10ms budget. Cron assumes tables exist.
  const now = Date.now();

  const dbWrites = [];
  const discordSends = [];
  const scheduleTouched = new Map();   // teamId -> day of a spawn that ended this tick (or null)

  // --- BOSSES: merge 'waiting' (warn/spawn) + 'spawned' (auto-reset) into one
  //     query with team_settings JOINed, eliminating per-boss N+1 settings lookups. ---
  try {
    const bosses = await env.DB.prepare(`
      SELECT b.*,
             ts.webhook_url, ts.webhook_boss, ts.on_warning, ts.on_spawn, ts.timezone
      FROM bosses b
      LEFT JOIN team_settings ts ON ts.team_id = b.team_id
      WHERE b.status IN ('waiting', 'spawned')
    `).all();

    for (const boss of bosses.results) {
      try {
        const bossHook = boss.webhook_boss || boss.webhook_url;
        if (boss.status === 'waiting') {
          const remaining = boss.next_spawn - now;
          const alertMs = (boss.alert_minutes || 5) * 60000;

          if (remaining > 0 && remaining <= alertMs && !boss.warned) {
            if (boss.on_warning && bossHook) {
              const minLeft = Math.max(1, Math.round(remaining / 60000));
              discordSends.push(sendDiscord(bossHook, `${boss.name} - Spawning Soon!`,
                `**${boss.name}** spawns in **${minLeft} minute${minLeft !== 1 ? 's' : ''}**!`, 16760576));
            }
            dbWrites.push(env.DB.prepare('UPDATE bosses SET warned = 1 WHERE id = ?').bind(boss.id));
            continue;
          }

          if (remaining <= 0) {
            const resetMin = boss.auto_reset_minutes ?? 5;
            const resetMs = boss.window_ms > 0 ? boss.window_ms : resetMin * 60000;
            if (!boss.spawn_notified && boss.on_spawn && bossHook) {
              discordSends.push(sendDiscord(bossHook, `${boss.name} has SPAWNED!`,
                boss.window_ms > 0
                  ? `**${boss.name}**'s spawn window is open for the next ${Math.round(boss.window_ms / 60000)} minutes.`
                  : `**${boss.name}** is now available!\nAuto-reset in ${resetMin} minute${resetMin !== 1 ? 's' : ''} if not killed.`, 15548997));
            }
            dbWrites.push(env.DB.prepare('UPDATE bosses SET status = ?, spawned_at = ?, auto_reset_at = ?, spawn_notified = 1 WHERE id = ?')
              .bind('spawned', now, now + resetMs, boss.id));
            if (!scheduleTouched.has(boss.team_id)) scheduleTouched.set(boss.team_id, null);
          }
        } else if (boss.status === 'spawned' && boss.auto_reset_at != null && boss.auto_reset_at <= now) {
          const tz = boss.timezone || 'Asia/Manila';
          const nextSpawn = calcNextSpawn(boss, now, tz);
          const ended = spawnEndStmt(env, { teamId: boss.team_id, boss, outcome: 'reset', endedAt: now, tz });
          dbWrites.push(env.DB.prepare('UPDATE bosses SET status = ?, spawned_at = NULL, auto_reset_at = NULL, warned = 0, spawn_notified = 0, spawn_group = NULL, next_spawn = ? WHERE id = ?')
            .bind('waiting', nextSpawn, boss.id), ended.stmt);
          scheduleTouched.set(boss.team_id, ended.day);
          if (boss.on_spawn && bossHook) {
            discordSends.push(sendDiscord(bossHook, `${boss.name} - Auto Reset`,
              `**${boss.name}** was not killed in time and has been reset.\nNext spawn recalculated.`, 9807270));
          }
        }
      } catch (e) { console.error('Boss processing error:', boss.id, e); }
    }
  } catch (e) { console.error('Boss query error:', e); }

  // --- EVENT REMINDERS: JOIN settings + aggregate rsvp count in one query. ---
  try {
    const upcomingEvents = await env.DB.prepare(`
      SELECT e.*,
             ts.webhook_url, ts.webhook_events, ts.on_event, ts.event_reminder_minutes,
             (SELECT COUNT(*) FROM event_rsvps WHERE event_id = e.id AND status = 'going') as rsvp_count
      FROM events e
      LEFT JOIN team_settings ts ON ts.team_id = e.team_id
      WHERE e.reminder_sent = 0
        AND e.event_time > ?
        AND e.event_time <= ? + COALESCE(ts.event_reminder_minutes, 15) * 60000
    `).bind(now, now).all();

    for (const event of upcomingEvents.results) {
      const eventHook = event.webhook_events || event.webhook_url;
      if (eventHook && event.on_event !== 0) {
        const minLeft = Math.max(1, Math.round((event.event_time - now) / 60000));
        discordSends.push(sendDiscord(eventHook, `${event.title} - Starting Soon!`,
          `**${event.title}** starts in **${minLeft} minute${minLeft !== 1 ? 's' : ''}**!\n${event.rsvp_count} member${event.rsvp_count !== 1 ? 's' : ''} going.${event.description ? '\n\n' + event.description : ''}`,
          16760576));
      }
      dbWrites.push(env.DB.prepare('UPDATE events SET reminder_sent = 1 WHERE id = ?').bind(event.id));
    }
  } catch (e) { console.error('Event reminder error:', e); }

  // --- EVENT START: JOIN settings. ---
  try {
    const startingEvents = await env.DB.prepare(`
      SELECT e.*, ts.webhook_url, ts.webhook_events
      FROM events e
      LEFT JOIN team_settings ts ON ts.team_id = e.team_id
      WHERE e.event_time <= ? AND e.start_notified = 0
    `).bind(now).all();

    for (const event of startingEvents.results) {
      const eventHook = event.webhook_events || event.webhook_url;
      if (eventHook) {
        discordSends.push(sendDiscord(eventHook, `${event.title} is starting NOW!`,
          `**${event.title}** has started!${event.description ? '\n\n' + event.description : ''}`, 15548997));
      }
      dbWrites.push(env.DB.prepare('UPDATE events SET start_notified = 1 WHERE id = ?').bind(event.id));
    }
  } catch (e) { console.error('Event start notification error:', e); }

  // --- EVENT END: JOIN settings. ---
  try {
    const endedEvents = await env.DB.prepare(`
      SELECT e.*, ts.webhook_url, ts.webhook_events
      FROM events e
      LEFT JOIN team_settings ts ON ts.team_id = e.team_id
      WHERE e.event_time + e.duration_minutes * 60000 <= ?
        AND e.start_notified = 1 AND e.end_notified = 0
    `).bind(now).all();

    for (const event of endedEvents.results) {
      const eventHook = event.webhook_events || event.webhook_url;
      if (eventHook) {
        discordSends.push(sendDiscord(eventHook, `${event.title} has ended!`,
          `**${event.title}** has ended. Thanks to everyone who participated!`, 5763719));
      }
      dbWrites.push(env.DB.prepare('UPDATE events SET end_notified = 1 WHERE id = ?').bind(event.id));
    }
  } catch (e) { console.error('Event end notification error:', e); }

  // --- Flush primary batch: all boss/event updates land in ONE D1 roundtrip,
  //     all Discord webhooks fire in parallel (network wait, not CPU). ---
  if (dbWrites.length > 0) {
    try { await env.DB.batch(dbWrites); } catch (e) { console.error('Primary batch write error:', e); }
    dbWrites.length = 0;
  }
  if (discordSends.length > 0) {
    await Promise.allSettled(discordSends);
    discordSends.length = 0;
  }

  // --- Daily schedule posts: new day at 00:00 team time, edits for bosses that changed above. ---
  try {
    await cronScheduleRefresh(env, scheduleTouched);
  } catch (e) { console.error('Schedule post error:', e); }

  // --- Recurring event auto-create. ---
  try {
    const recurringEnded = await env.DB.prepare(
      "SELECT * FROM events WHERE recurrence IS NOT NULL AND recurrence != 'none' AND event_time + duration_minutes * 60000 <= ? AND end_notified = 1"
    ).bind(now).all();

    const insertStmts = [];
    for (const event of recurringEnded.results) {
      const parentId = event.parent_event_id || event.id;
      const existing = await env.DB.prepare(
        'SELECT 1 FROM events WHERE parent_event_id = ? AND event_time > ?'
      ).bind(parentId, event.event_time).first();
      if (existing) continue;

      let nextTime = event.event_time;
      if (event.recurrence === 'daily') nextTime += 86400000;
      else if (event.recurrence === 'weekly') nextTime += 7 * 86400000;
      else if (event.recurrence === 'biweekly') nextTime += 14 * 86400000;
      else if (event.recurrence === 'monthly') {
        const d = new Date(event.event_time);
        d.setMonth(d.getMonth() + 1);
        nextTime = d.getTime();
      }
      if (nextTime < now - 86400000) continue;

      const newId = crypto.randomUUID();
      insertStmts.push(env.DB.prepare(`INSERT INTO events (id, team_id, title, description, event_type, event_time, duration_minutes, created_by, recurrence, parent_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(newId, event.team_id, event.title, event.description, event.event_type, nextTime, event.duration_minutes, event.created_by, event.recurrence, parentId));
    }
    if (insertStmts.length > 0) await env.DB.batch(insertStmts);
  } catch (e) { console.error('Recurring event error:', e); }

  // --- DKP decay: JOIN ledger balance into the inactive-members query
  //     to eliminate per-member balance lookup. ---
  try {
    const decayTeams = await env.DB.prepare(
      'SELECT ts.* FROM team_settings ts JOIN teams t ON t.id = ts.team_id JOIN users u ON u.id = t.owner_id WHERE ts.dkp_decay_enabled = 1 AND u.premium = 1 AND (ts.dkp_decay_last_run IS NULL OR ts.dkp_decay_last_run < unixepoch() - ts.dkp_decay_interval_days * 86400)'
    ).all();

    if (decayTeams.results.length > 0) {
      const decayWrites = [];
      for (const ts of decayTeams.results) {
        const inactiveWithBal = await env.DB.prepare(`
          SELECT ma.user_id, COALESCE(SUM(dl.amount), 0) as balance
          FROM member_activity ma
          LEFT JOIN dkp_ledger dl ON dl.team_id = ma.team_id AND dl.user_id = ma.user_id
          WHERE ma.team_id = ? AND ma.last_seen < unixepoch() - ?
          GROUP BY ma.user_id
          HAVING balance > 0
        `).bind(ts.team_id, (ts.dkp_decay_inactive_days || 14) * 86400).all();

        for (const m of inactiveWithBal.results) {
          const decay = Math.max(1, Math.floor(m.balance * (ts.dkp_decay_percent || 10) / 100));
          decayWrites.push(env.DB.prepare('INSERT INTO dkp_ledger (id, team_id, user_id, amount, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(crypto.randomUUID(), ts.team_id, m.user_id, -decay, 'Inactivity decay', 'system'));
        }
        decayWrites.push(env.DB.prepare('UPDATE team_settings SET dkp_decay_last_run = unixepoch() WHERE team_id = ?').bind(ts.team_id));
      }
      if (decayWrites.length > 0) await env.DB.batch(decayWrites);
    }
  } catch (e) { console.error('DKP decay error:', e); }

  // --- Auctions: JOIN top bid into the expired auctions query. ---
  try {
    const expiredAuctions = await env.DB.prepare(`
      SELECT a.*,
             (SELECT user_id FROM dkp_bids WHERE auction_id = a.id ORDER BY amount DESC LIMIT 1) as top_user,
             (SELECT amount FROM dkp_bids WHERE auction_id = a.id ORDER BY amount DESC LIMIT 1) as top_amount
      FROM dkp_auctions a
      WHERE a.status = 'open' AND a.expires_at IS NOT NULL AND a.expires_at < ?
    `).bind(Math.floor(now / 1000)).all();

    if (expiredAuctions.results.length > 0) {
      const auctionWrites = [];
      for (const auction of expiredAuctions.results) {
        if (auction.top_user) {
          auctionWrites.push(env.DB.prepare('INSERT INTO dkp_ledger (id, team_id, user_id, amount, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(crypto.randomUUID(), auction.team_id, auction.top_user, -auction.top_amount, `Auction: ${auction.item_name}`, 'system'));
          auctionWrites.push(env.DB.prepare('UPDATE dkp_auctions SET status = ?, winner_id = ?, winning_bid = ? WHERE id = ?')
            .bind('closed', auction.top_user, auction.top_amount, auction.id));
        } else {
          auctionWrites.push(env.DB.prepare("UPDATE dkp_auctions SET status = 'closed' WHERE id = ?").bind(auction.id));
        }
      }
      if (auctionWrites.length > 0) await env.DB.batch(auctionWrites);
    }
  } catch (e) { console.error('Auction close error:', e); }

  // --- Auto-delete old events. Collect all deletes into one batch. ---
  try {
    const allSettings = await env.DB.prepare('SELECT team_id, auto_delete_events_days FROM team_settings WHERE auto_delete_events_days > 0').all();
    if (allSettings.results.length > 0) {
      const deleteWrites = [];
      for (const s of allSettings.results) {
        if (s.auto_delete_events_days > 0) {
          const cutoff = Math.floor(now / 1000) - s.auto_delete_events_days * 86400;
          const oldEvents = await env.DB.prepare('SELECT id FROM events WHERE team_id = ? AND event_time / 1000 < ? AND recurrence IS NULL').bind(s.team_id, cutoff).all();
          for (const e of oldEvents.results) {
            deleteWrites.push(env.DB.prepare('DELETE FROM event_rsvps WHERE event_id = ?').bind(e.id));
            deleteWrites.push(env.DB.prepare('DELETE FROM event_attendance WHERE event_id = ?').bind(e.id));
            deleteWrites.push(env.DB.prepare('DELETE FROM events WHERE id = ?').bind(e.id));
          }
        }
      }
      if (deleteWrites.length > 0) await env.DB.batch(deleteWrites);
    }
  } catch (e) { console.error('Auto-delete error:', e); }

  // --- Join request cleanup: single statement, already optimal. ---
  try {
    await env.DB.prepare("DELETE FROM join_requests WHERE status != 'pending' AND resolved_at < unixepoch() - 2592000").run();
  } catch (e) { console.error('Join request cleanup error:', e); }

  // --- Discord slash commands: re-register after a deploy that changed them (once per isolate). ---
  try {
    await syncCommands(env);
  } catch (e) { console.error('Command sync error:', e); }

  // --- Gumroad licenses: re-verify a few whose last check is older than ~20 h (see lib/gumroad.js). ---
  try {
    await recheckLicenses(env);
  } catch (e) { console.error('License recheck error:', e); }
}
