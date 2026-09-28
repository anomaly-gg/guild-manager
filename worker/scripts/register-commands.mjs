// MANUAL FALLBACK. The deployed worker registers changed commands by itself (lib/discord-commands.js,
// via the cron), so this is only needed for the instant per-server form or if that sync fails.
// Register the slash commands with Discord. Run from the worker folder:
//   $env:DISCORD_BOT_TOKEN='...'; node scripts/register-commands.mjs            (global, up to 1 h to appear)
//   $env:DISCORD_BOT_TOKEN='...'; node scripts/register-commands.mjs <guildId>  (one server, instant)
// The app id is read from wrangler.toml; the token is never written anywhere.

import { readFileSync } from 'node:fs';
import { COMMANDS } from '../src/lib/discord-commands.js';

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) { console.error('Set DISCORD_BOT_TOKEN in the environment first.'); process.exit(1); }
const appId = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(/DISCORD_APP_ID\s*=\s*"(\d+)"/)?.[1];
if (!appId) { console.error('DISCORD_APP_ID missing from wrangler.toml'); process.exit(1); }
const guildId = process.argv[2];

const commands = COMMANDS;

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;
const r = await fetch(url, { method: 'PUT', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands) });
const body = await r.text();
console.log(r.status, r.ok ? `registered ${commands.length} commands ${guildId ? 'for guild ' + guildId : 'globally'}` : body);
// Let the socket close on its own; process.exit() right after fetch trips a libuv assertion on Windows.
process.exitCode = r.ok ? 0 : 1;
