// Boss alerts in the Discord alert channel: at most two messages per spawn, updated in place so the
// channel shows what is true now (and Discord only pings for the two that matter).
//   spawning soon  (new message, pings)
//   spawned        (new message, pings; the "soon" message shrinks to one grey line)
//   killed / auto-reset  -> the spawned message is edited, no ping. Killed before it spawned ->
//                           the "soon" message is edited instead.
// Message ids live on the boss row: alert_soon_msg, alert_spawn_msg (cleared when the spawn ends).

import { webhookCall, isValidDiscordWebhook } from './discord.js';
import { clockIn, fmtDuration } from './schedule-format.js';

const COLOR = { soon: 16760576, up: 15548997, done: 0x4f545c };
const where = (b) => b.location ? ` · ${b.location}` : '';
const embed = (title, description, color) => ({ embeds: [{ title: String(title).slice(0, 256), description: String(description).slice(0, 2048), color, footer: { text: 'Guild Manager' } }], allowed_mentions: { parse: [] } });
const usable = (hook) => hook && isValidDiscordWebhook(hook);

// -> message id, or null
export async function alertSoon(env, hook, boss, tz, now = Date.now()) {
  if (!usable(hook)) return null;
  const min = Math.max(1, Math.round((boss.next_spawn - now) / 60000));
  const r = await webhookCall(env, hook, 'POST', null, embed(`${boss.name} — spawning soon`,
    `Spawns in **${min} minute${min !== 1 ? 's' : ''}** (${clockIn(boss.next_spawn, tz)})${where(boss)}`, COLOR.soon));
  return r.ok ? r.id : null;
}

function spawnedBody(boss, tz) {
  const resetMin = boss.auto_reset_minutes ?? 5;
  const text = boss.window_ms > 0
    ? `Spawn window open for the next ${Math.round(boss.window_ms / 60000)} minutes${where(boss)}.`
    : `Up since ${clockIn(boss.next_spawn, tz)}${where(boss)}. Auto-reset in ${resetMin} minute${resetMin !== 1 ? 's' : ''} if no kill is logged.`;
  return embed(`🔴 ${boss.name} has spawned`, text, COLOR.up);
}

// The boss just came up. post = spawn alerts are on (a new, pinging message); otherwise the
// "soon" message, if any, turns into the spawned one quietly. -> { soon, spawn } ids to store
export async function alertSpawned(env, hook, boss, tz, { post }) {
  if (!usable(hook)) return { soon: null, spawn: null };
  if (post) {
    const r = await webhookCall(env, hook, 'POST', null, spawnedBody(boss, tz));
    if (boss.alert_soon_msg) {
      await webhookCall(env, hook, 'PATCH', boss.alert_soon_msg, { content: `-# ⏰ ${boss.name} spawned at ${clockIn(boss.next_spawn, tz)}`, embeds: [], allowed_mentions: { parse: [] } });
    }
    return { soon: null, spawn: r.ok ? r.id : null };
  }
  if (boss.alert_soon_msg) {
    await webhookCall(env, hook, 'PATCH', boss.alert_soon_msg, spawnedBody(boss, tz));
    return { soon: null, spawn: boss.alert_soon_msg };
  }
  return { soon: null, spawn: null };
}

// The spawn ended. outcome 'dead' (by = who logged it, at = death time) or 'reset' (at = now).
// Edits whichever alert message the spawn has; nothing to do when it has none.
export async function alertEnded(env, hook, boss, tz, { outcome, by, at, nextSpawn }) {
  const msg = boss.alert_spawn_msg || boss.alert_soon_msg;
  if (!msg || !usable(hook)) return;
  const next = nextSpawn ? ` · next spawn ${clockIn(nextSpawn, tz)} (in ${fmtDuration(nextSpawn - Date.now())})` : '';
  const body = outcome === 'dead'
    ? embed(`☠️ ${boss.name} — killed`, `Killed${by ? ` by **${by}**` : ''} at ${clockIn(at, tz)}${next}`, COLOR.done)
    : embed(`⏱ ${boss.name} — auto-reset`, `No kill logged${boss.window_ms > 0 ? ' before the window closed' : ''}${next}`, COLOR.done);
  await webhookCall(env, hook, 'PATCH', msg, body);
}

// For the kill paths (site + /killed): look up the team's alert webhook, then edit.
export async function killAlert(env, { teamId, boss, by, at, nextSpawn }) {
  if (!boss.alert_spawn_msg && !boss.alert_soon_msg) return;
  const s = await env.DB.prepare('SELECT webhook_boss, webhook_url, timezone FROM team_settings WHERE team_id = ?').bind(teamId).first();
  await alertEnded(env, s?.webhook_boss || s?.webhook_url, boss, s?.timezone || 'Asia/Manila', { outcome: 'dead', by, at, nextSpawn });
}
