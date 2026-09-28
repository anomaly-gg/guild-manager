// Discord interactions plumbing: request signature check, response shapes, follow-up edits,
// server links and bot lookups. No routing here (see routes/discord.js); schedule text lives in
// lib/schedule-format.js.

const API = 'https://discord.com/api/v10';

export const InteractionType = { PING: 1, COMMAND: 2, AUTOCOMPLETE: 4 };
export const EPHEMERAL = 64;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Discord signs `timestamp + rawBody` with the app's Ed25519 key; reject anything else.
export async function verifyDiscordRequest(request, rawBody, publicKeyHex) {
  const sig = request.headers.get('x-signature-ed25519');
  const ts = request.headers.get('x-signature-timestamp');
  if (!sig || !ts || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hexToBytes(sig), new TextEncoder().encode(ts + rawBody));
  } catch (e) {
    console.error('discord signature check failed to run:', e);
    return false;
  }
}

const respond = (obj) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
export const pong = () => respond({ type: 1 });
export const message = (content, ephemeral = false) => respond({ type: 4, data: { content, flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: { parse: [] } } });
export const deferred = (ephemeral = false) => respond({ type: 5, data: { flags: ephemeral ? EPHEMERAL : 0 } });
export const choices = (list) => respond({ type: 8, data: { choices: list.slice(0, 25) } });

// Replace the "thinking…" placeholder of a deferred response. Uses the interaction token, no bot token needed.
export async function editOriginal(env, interactionToken, content) {
  const r = await fetch(`${env.DISCORD_API || API}/webhooks/${env.DISCORD_APP_ID}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: String(content).slice(0, 2000), allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) console.error('discord editOriginal failed:', r.status, await r.text().catch(() => ''));
}

// ---- server links (discord_guilds): a server belongs to one team; a team may have many servers.

export async function guildName(env, guildId) {
  if (!env.DISCORD_BOT_TOKEN) return null;
  try {
    const r = await fetch(`${env.DISCORD_API || API}/guilds/${guildId}`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
    if (!r.ok) return null;
    return (await r.json()).name || null;
  } catch { return null; }
}

// Roles a spawn group can be tagged with: everything but @everyone and bot-managed roles.
export async function guildRoles(env, guildId) {
  if (!env.DISCORD_BOT_TOKEN) return [];
  try {
    const r = await fetch(`${env.DISCORD_API || API}/guilds/${guildId}/roles`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
    if (!r.ok) return [];
    return (await r.json()).filter(x => x.id !== guildId && !x.managed)
      .sort((a, b) => b.position - a.position)
      .map(x => ({ id: x.id, name: x.name, color: x.color || 0 }));
  } catch { return []; }
}

export async function linkGuild(env, { guildId, teamId, userId }) {
  const name = await guildName(env, guildId);
  await env.DB.prepare('INSERT INTO discord_guilds (guild_id, team_id, guild_name, linked_by) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET team_id = excluded.team_id, guild_name = COALESCE(excluded.guild_name, discord_guilds.guild_name), linked_by = excluded.linked_by, linked_at = unixepoch()')
    .bind(guildId, teamId, name, userId || null).run();
  return name;
}

export async function unlinkGuild(env, guildId) {
  await env.DB.prepare('DELETE FROM discord_guilds WHERE guild_id = ?').bind(guildId).run();
}

export function optionValue(interaction, name) {
  return (interaction.data?.options || []).find(o => o.name === name)?.value;
}
export function focusedOption(interaction) {
  return (interaction.data?.options || []).find(o => o.focused);
}
export function invoker(interaction) {
  const u = interaction.member?.user || interaction.user || {};
  return { id: u.id, name: interaction.member?.nick || u.global_name || u.username || 'someone' };
}
