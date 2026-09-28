// Discord interactions plumbing: request signature check, response shapes, follow-up edits,
// and the text formatting used by the slash commands. No routing here (see routes/discord.js).

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

// ---- formatting

export function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function clockIn(ts, tz) {
  try { return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }); }
  catch { return new Date(ts).toISOString().slice(11, 16); }
}

function state(boss, now) {
  const remaining = boss.next_spawn - now;
  const windowMs = boss.window_ms || 0;
  if (boss.status === 'spawned' || remaining <= 0) {
    if (windowMs > 0 && now < boss.next_spawn + windowMs) return { key: 'window', remaining, windowLeft: boss.next_spawn + windowMs - now };
    return { key: 'spawned', remaining };
  }
  return { key: 'waiting', remaining };
}

export function dayIn(ts, tz) {
  try { return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }); }
  catch { return new Date(ts).toISOString().slice(0, 10); }
}

// Spawns closer together than this share a block; a wider gap gets a dashed divider (guild schedule-post style).
const BLOCK_GAP_MS = 30 * 60000;
const DIVIDER = '-'.repeat(33);
const TIME_WIDTH = 8;   // "11:30 PM"; shorter times are padded with no-break spaces so the code pills line up

// Schedule for /next: up-now bosses first, then soonest, grouped under day headers in the team clock `tz`.
export function nextSpawnsText(bosses, tz, now = Date.now(), limit = 10) {
  const rank = { spawned: 0, window: 0, waiting: 1 };
  const rows = bosses.map(b => ({ b, st: state(b, now) }))
    .sort((x, y) => (rank[x.st.key] - rank[y.st.key]) || (x.b.next_spawn - y.b.next_spawn))
    .slice(0, limit);
  if (!rows.length) return 'No boss timers yet. Add some in Guild Manager → Timers.';
  const out = [];
  let day = null, prev = null;
  for (const { b, st } of rows) {
    const up = st.key !== 'waiting';
    const d = up ? 'Up now' : dayIn(b.next_spawn, tz);
    if (d !== day) {
      if (day !== null) out.push('');
      out.push(`**${d}**`);
      day = d; prev = null;
    } else if (!up && prev !== null && b.next_spawn - prev > BLOCK_GAP_MS) {
      out.push(DIVIDER);
    }
    prev = b.next_spawn;
    const cells = [`\`${clockIn(b.next_spawn, tz).padEnd(TIME_WIDTH, ' ')}\``, b.name];
    if (b.location) cells.push(b.location);
    if (st.key === 'spawned') cells.push('🔴 UP');
    else if (st.key === 'window') cells.push(`🟠 window, ${fmtDuration(st.windowLeft)} left`);
    out.push(cells.join(' | '));
  }
  return out.join('\n');
}
