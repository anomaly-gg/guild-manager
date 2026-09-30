// One-time upkeep when Settings opens (GET settings), for data saved before roles were per server:
//   - channels saved without their server (and name) are looked up once (lib/webhooks.js)
//   - spawn-group roles saved without their server are filed under the linked server that has them
//     (lib/spawn-groups.js fileLegacyRoles)
// Each write only lands if the column still holds what was read, so a save made meanwhile wins.
// Nothing to do = no Discord calls.

import { webhookInfo } from './discord.js';
import { KINDS, parseHooks, storeHooks } from './webhooks.js';
import { parseGroups, fileLegacyRoles } from './spawn-groups.js';
import { guildRoles } from './discord-interactions.js';

// -> the settings row with any filled-in columns
export async function backfillSettings(env, teamId, settings) {
  if (!settings) return settings;
  const out = { ...settings };
  const writes = [];

  await Promise.all(Object.values(KINDS).map(async (col) => {
    const list = parseHooks(settings[col]);
    const missing = list.filter(h => !h.g);
    if (!missing.length) return;
    let found = false;
    await Promise.all(missing.map(async (h) => {
      const info = await webhookInfo(env, h.u);
      if (!info.ok || !info.guildId) return;
      h.g = info.guildId; h.n = h.n || info.name; found = true;
    }));
    if (!found) return;
    out[col] = storeHooks(list);
    writes.push(env.DB.prepare(`UPDATE team_settings SET ${col} = ? WHERE team_id = ? AND ${col} IS ?`).bind(out[col], teamId, settings[col]));
  }));

  const groups = parseGroups(settings.spawn_groups);
  if (groups.some(g => g.roleId)) {
    const linked = (await env.DB.prepare('SELECT guild_id FROM discord_guilds WHERE team_id = ?').bind(teamId).all()).results;
    const servers = await Promise.all(linked.map(async (g) => ({ guildId: g.guild_id, roles: await guildRoles(env, g.guild_id) })));
    const filed = fileLegacyRoles(groups, servers);
    if (filed.changed) {
      out.spawn_groups = JSON.stringify(filed.groups);
      writes.push(env.DB.prepare('UPDATE team_settings SET spawn_groups = ? WHERE team_id = ? AND spawn_groups IS ?').bind(out.spawn_groups, teamId, settings.spawn_groups));
    }
  }

  if (writes.length) await env.DB.batch(writes);
  return out;
}
