// Discord alert channels (protected, officers+): add, remove and test one channel of an alert kind
// (url = main alerts, boss, events, schedule). Each kind is a list in team_settings (lib/webhooks.js).
// Free: one channel per kind, boss/event alerts go to the main channel. Premium: PLANS.premium.webhooks.
//   POST   /api/teams/:id/webhooks { kind, url }        -> { ok, id, name }
//   DELETE /api/teams/:id/webhooks/:kind/:hookId        -> { ok }
//   POST   /api/teams/:id/webhooks/:kind/:hookId/test   -> { ok }

import { json, safeJson } from '../lib/http.js';
import { rateLimit } from '../lib/ratelimit.js';
import { requireTeamMember, isPremiumTeam } from '../lib/team.js';
import { limitsFor } from '../lib/limits.js';
import { isValidDiscordWebhook, webhookCall, webhookInfo } from '../lib/discord.js';
import { KINDS, PREMIUM_ONLY, hookId, parseHooks, storeHooks, parseMsgs, storeMsgs, keepMsgs } from '../lib/webhooks.js';
import { queueScheduleRefresh } from '../lib/schedule-post.js';

const LABEL = { url: 'alerts', boss: 'boss alerts', events: 'event alerts', schedule: 'the daily schedule post' };

async function officer(env, teamId, user) {
  const m = await requireTeamMember(env, teamId, user.userId);
  return m && m.role !== 'member';
}

const channels = (env, teamId, kind) =>
  env.DB.prepare(`SELECT ${KINDS[kind]} AS hooks, schedule_msg_id, schedule_prev_msg_id FROM team_settings WHERE team_id = ?`).bind(teamId).first();

export const routes = [
  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/webhooks$/, handler: async ({ request, env, ctx, user, params }) => {
    const teamId = params[1];
    if (!(await officer(env, teamId, user))) return json({ error: 'Officers+ only' }, 403);
    const body = await safeJson(request);
    const kind = body?.kind, url = String(body?.url || '').trim();
    if (!KINDS[kind]) return json({ error: 'Unknown alert kind' }, 400);
    if (!isValidDiscordWebhook(url)) return json({ error: 'Webhook must be a Discord webhook URL (https://discord.com/api/webhooks/...)' }, 400);
    const premium = await isPremiumTeam(env, teamId);
    if (PREMIUM_ONLY.includes(kind) && !premium) return json({ error: 'Premium required', premiumRequired: true }, 403);

    await env.DB.prepare("INSERT OR IGNORE INTO team_settings (team_id, timezone) VALUES (?, 'Asia/Manila')").bind(teamId).run();
    const row = await channels(env, teamId, kind);
    const list = parseHooks(row?.hooks);
    const id = hookId(url), at = list.findIndex(h => hookId(h.u) === id);
    const cap = limitsFor(premium).webhooks;
    if (at < 0 && list.length >= cap) {
      return json(premium ? { error: `Up to ${cap} channels for ${LABEL[kind]}` }
        : { error: `Free plan: 1 channel for ${LABEL[kind]}. Premium posts to up to ${limitsFor(true).webhooks}.`, premiumRequired: true }, 403);
    }

    // Ask Discord before saving, so a mistyped or deleted webhook is caught here, not at the next spawn.
    const info = await webhookInfo(env, url);
    if (!info.ok && info.status >= 400 && info.status < 500 && info.status !== 429) {
      return json({ error: 'Discord does not know this webhook. It may have been deleted; copy its URL again.' }, 400);
    }
    const entry = { u: url, n: info.name || null };
    if (at < 0) list.push(entry); else list[at] = entry;

    const sets = [`${KINDS[kind]} = ?`], vals = [storeHooks(list)];
    if (kind === 'schedule' && at >= 0) {
      // Same channel saved again: a post Discord refused for good ('') gets another try.
      const msgs = parseMsgs(row.schedule_msg_id, list.map(h => h.u));
      if (msgs[id] === '') { delete msgs[id]; sets.push('schedule_msg_id = ?'); vals.push(storeMsgs(msgs)); }
    }
    await env.DB.prepare(`UPDATE team_settings SET ${sets.join(', ')} WHERE team_id = ?`).bind(...vals, teamId).run();
    if (kind === 'schedule') queueScheduleRefresh(ctx, env, teamId);   // posts today's schedule in the new channel
    return json({ ok: true, id, name: entry.n });
  } },

  { method: 'DELETE', pattern: /^\/api\/teams\/([^/]+)\/webhooks\/([a-z]+)\/(\d+)$/, handler: async ({ env, user, params }) => {
    const [, teamId, kind, id] = params;
    if (!(await officer(env, teamId, user))) return json({ error: 'Officers+ only' }, 403);
    if (!KINDS[kind]) return json({ error: 'Unknown alert kind' }, 400);
    const row = await channels(env, teamId, kind);
    const before = parseHooks(row?.hooks), after = before.filter(h => hookId(h.u) !== id);
    if (after.length === before.length) return json({ error: 'Channel not found' }, 404);

    const sets = [`${KINDS[kind]} = ?`], vals = [storeHooks(after)];
    if (kind === 'schedule') {
      // Its messages stay in Discord but stop updating; the other channels keep theirs.
      if (!after.length) sets.push('schedule_day = NULL', 'schedule_msg_id = NULL', 'schedule_prev_day = NULL', 'schedule_prev_msg_id = NULL');
      else {
        const b = before.map(h => h.u), a = after.map(h => h.u);
        sets.push('schedule_msg_id = ?', 'schedule_prev_msg_id = ?');
        vals.push(keepMsgs(row.schedule_msg_id, b, a), keepMsgs(row.schedule_prev_msg_id, b, a));
      }
    }
    await env.DB.prepare(`UPDATE team_settings SET ${sets.join(', ')} WHERE team_id = ?`).bind(...vals, teamId).run();
    return json({ ok: true });
  } },

  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/webhooks\/([a-z]+)\/(\d+)\/test$/, handler: async ({ env, user, params }) => {
    const [, teamId, kind, id] = params;
    if (rateLimit(`webhook-test:${user.userId}`, 3, 60000)) return json({ error: 'Too many test requests. Try again in a minute.' }, 429);
    if (!(await officer(env, teamId, user))) return json({ error: 'Officers+ only' }, 403);
    if (!KINDS[kind]) return json({ error: 'Unknown alert kind' }, 400);
    const hook = parseHooks((await channels(env, teamId, kind))?.hooks).find(h => hookId(h.u) === id);
    if (!hook) return json({ error: 'Channel not found' }, 404);
    const r = await webhookCall(env, hook.u, 'POST', null, { embeds: [{ title: 'Test Notification', description: `Guild Manager will post ${LABEL[kind]} in this channel.`, color: 5793266, footer: { text: 'Guild Manager' } }], allowed_mentions: { parse: [] } });
    return r.ok ? json({ ok: true }) : json({ error: `Discord refused the test (${r.status || 'unreachable'})` }, 502);
  } },
];
