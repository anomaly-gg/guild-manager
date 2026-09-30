// Boss alerts in the Discord alert channels: at most two messages per spawn in each channel, updated
// in place so the channel shows what is true now (and Discord only pings for the two that matter).
//   spawning soon  (new message, pings)
//   spawned        (new message, pings; the "soon" message shrinks to one grey line)
//   killed / auto-reset  -> the spawned message is edited, no ping. Killed before it spawned ->
//                           the "soon" message is edited instead.
// `hooks` = the team's boss alert webhook URLs (lib/webhooks.js alertHooks). Message ids live on the
// boss row per channel: alert_soon_msg, alert_spawn_msg (cleared when the spawn ends).

import { webhookCall } from './discord.js';
import { hookId, parseMsgs, storeMsgs, alertHooks } from './webhooks.js';
import { clockIn, fmtDuration } from './schedule-format.js';

const COLOR = { soon: 16760576, up: 15548997, done: 0x4f545c };
const where = (b) => b.location ? ` · ${b.location}` : '';
const embed = (title, description, color) => ({ embeds: [{ title: String(title).slice(0, 256), description: String(description).slice(0, 2048), color, footer: { text: 'Guild Manager' } }], allowed_mentions: { parse: [] } });

// -> stored message ids, or null
export async function alertSoon(env, hooks, boss, tz, now = Date.now()) {
  const min = Math.max(1, Math.round((boss.next_spawn - now) / 60000));
  const body = embed(`${boss.name} — spawning soon`,
    `Spawns in **${min} minute${min !== 1 ? 's' : ''}** (${clockIn(boss.next_spawn, tz)})${where(boss)}`, COLOR.soon);
  const ids = {};
  await Promise.all(hooks.map(async (hook) => {
    const r = await webhookCall(env, hook, 'POST', null, body);
    if (r.ok && r.id) ids[hookId(hook)] = r.id;
  }));
  return storeMsgs(ids);
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
export async function alertSpawned(env, hooks, boss, tz, { post }) {
  const soon = parseMsgs(boss.alert_soon_msg, hooks);
  const spawn = {};
  await Promise.all(hooks.map(async (hook) => {
    const id = hookId(hook), soonMsg = soon[id];
    if (post) {
      const r = await webhookCall(env, hook, 'POST', null, spawnedBody(boss, tz));
      if (r.ok && r.id) spawn[id] = r.id;
      if (soonMsg) {
        await webhookCall(env, hook, 'PATCH', soonMsg, { content: `-# ⏰ ${boss.name} spawned at ${clockIn(boss.next_spawn, tz)}`, embeds: [], allowed_mentions: { parse: [] } });
      }
    } else if (soonMsg) {
      await webhookCall(env, hook, 'PATCH', soonMsg, spawnedBody(boss, tz));
      spawn[id] = soonMsg;
    }
  }));
  return { soon: null, spawn: storeMsgs(spawn) };
}

// The spawn ended. outcome 'dead' (by = who logged it, at = death time) or 'reset' (at = now).
// Edits whichever alert message the spawn has in each channel; nothing to do when it has none.
export async function alertEnded(env, hooks, boss, tz, { outcome, by, at, nextSpawn }) {
  const msgs = parseMsgs(boss.alert_spawn_msg || boss.alert_soon_msg, hooks);
  if (!Object.keys(msgs).length) return;
  const next = nextSpawn ? ` · next spawn ${clockIn(nextSpawn, tz)} (in ${fmtDuration(nextSpawn - Date.now())})` : '';
  const body = outcome === 'dead'
    ? embed(`☠️ ${boss.name} — killed`, `Killed${by ? ` by **${by}**` : ''} at ${clockIn(at, tz)}${next}`, COLOR.done)
    : embed(`⏱ ${boss.name} — auto-reset`, `No kill logged${boss.window_ms > 0 ? ' before the window closed' : ''}${next}`, COLOR.done);
  await Promise.all(hooks.map(hook => msgs[hookId(hook)] && webhookCall(env, hook, 'PATCH', msgs[hookId(hook)], body)));
}

// For the kill paths (site + /killed): look up the team's alert channels, then edit.
export async function killAlert(env, { teamId, boss, by, at, nextSpawn }) {
  if (!boss.alert_spawn_msg && !boss.alert_soon_msg) return;
  const s = await env.DB.prepare('SELECT webhook_boss, webhook_url, timezone FROM team_settings WHERE team_id = ?').bind(teamId).first();
  await alertEnded(env, alertHooks(s, 'boss'), boss, s?.timezone || 'Asia/Manila', { outcome: 'dead', by, at, nextSpawn });
}
