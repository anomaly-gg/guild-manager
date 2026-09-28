// Auto-delete of slash-command replies, so a busy channel is not flooded with "/killed" and "/next"
// answers. After a public reply lands, its interaction token is queued with a delete time from the
// team's settings (Settings → Discord slash commands); the cron deletes due replies each minute.
// Interaction tokens live 15 minutes, which caps the delay at 14.

import { deleteOriginal } from './discord-interactions.js';

// Which delay a command's reply uses. Commands not listed here are never auto-deleted.
const KIND = { killed: 'action', assign: 'action', rollcall: 'action', next: 'next' };
export const DEFAULT_MINUTES = { action: 1, next: 5 };
export const clampMinutes = (v, fallback) => Math.max(1, Math.min(14, parseInt(v) || fallback));

// One statement: looks up the linked team's settings and queues the reply only when auto-delete is on.
export async function queueReplyCleanup(env, { command, guildId, token }) {
  const kind = KIND[command];
  if (!kind || !guildId || !token) return;
  const col = kind === 'next' ? 'discord_delete_next_min' : 'discord_delete_action_min';
  await env.DB.prepare(`INSERT OR REPLACE INTO discord_cleanup (token, delete_at)
      SELECT ?, ? + COALESCE(ts.${col}, ?) * 60000 FROM discord_guilds g LEFT JOIN team_settings ts ON ts.team_id = g.team_id
      WHERE g.guild_id = ? AND COALESCE(ts.discord_autodelete, 1) = 1`)
    .bind(token, Date.now(), DEFAULT_MINUTES[kind], guildId).run();
}

// Cron: delete every reply that is due. Rows go either way; a token past 15 minutes is useless.
export async function runReplyCleanup(env) {
  const now = Date.now();
  const due = (await env.DB.prepare('SELECT token FROM discord_cleanup WHERE delete_at <= ?').bind(now).all()).results;
  if (!due.length) return;
  await Promise.allSettled(due.map(r => deleteOriginal(env, r.token)));
  await env.DB.prepare('DELETE FROM discord_cleanup WHERE delete_at <= ?').bind(now).run();
}
