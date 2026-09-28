// Register the slash commands with Discord. Run from the worker folder:
//   $env:DISCORD_BOT_TOKEN='...'; node scripts/register-commands.mjs            (global, up to 1 h to appear)
//   $env:DISCORD_BOT_TOKEN='...'; node scripts/register-commands.mjs <guildId>  (one server, instant)
// The app id is read from wrangler.toml; the token is never written anywhere.

import { readFileSync } from 'node:fs';

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) { console.error('Set DISCORD_BOT_TOKEN in the environment first.'); process.exit(1); }
const appId = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(/DISCORD_APP_ID\s*=\s*"(\d+)"/)?.[1];
if (!appId) { console.error('DISCORD_APP_ID missing from wrangler.toml'); process.exit(1); }
const guildId = process.argv[2];

const commands = [
  { name: 'next', description: 'Next boss spawns for the team linked to this server',
    options: [{ type: 4, name: 'count', description: 'How many to show (default 10)', min_value: 1, max_value: 25 }] },
  { name: 'killed', description: 'Log a boss kill and restart its timer (team members only)',
    options: [
      { type: 3, name: 'boss', description: 'Boss name', required: true, autocomplete: true },
      { type: 4, name: 'minutes_ago', description: 'How many minutes ago it died (default 0)', min_value: 0, max_value: 1440 },
    ] },
  { name: 'assign', description: 'Hand a boss\'s next spawn to a group (leader or officer)',
    options: [
      { type: 3, name: 'boss', description: 'Boss name', required: true, autocomplete: true },
      { type: 3, name: 'group', description: 'Group, or "No group" to clear', required: true, autocomplete: true },
    ] },
  { name: 'here', description: 'Check in to a rally with a screenshot (team members)',
    options: [
      { type: 3, name: 'boss', description: 'Boss you rallied for', required: true, autocomplete: true },
      { type: 11, name: 'proof', description: 'Screenshot showing you in the rally', required: true },
      { type: 3, name: 'boss2', description: 'Second boss on the same screenshot', autocomplete: true },
      { type: 3, name: 'note', description: 'Optional note', max_length: 200 },
    ] },
  { name: 'rollcall', description: 'Log who was in the rally (leader or officer)',
    options: [
      { type: 3, name: 'boss', description: 'Boss you rallied for', required: true, autocomplete: true },
      { type: 3, name: 'members', description: 'Mention everyone who was there: @a @b @c', required: true },
      { type: 3, name: 'boss2', description: 'Second boss in the same rally', autocomplete: true },
      { type: 3, name: 'note', description: 'Optional note', max_length: 200 },
    ] },
  { name: 'link', description: 'Link this server to your team (leader or officer)',
    options: [{ type: 3, name: 'code', description: 'The team invite code from Guild Manager', required: true }] },
  { name: 'unlink', description: 'Unlink this server from its team (leader or officer)' },
];

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;
const r = await fetch(url, { method: 'PUT', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands) });
const body = await r.text();
console.log(r.status, r.ok ? `registered ${commands.length} commands ${guildId ? 'for guild ' + guildId : 'globally'}` : body);
// Let the socket close on its own; process.exit() right after fetch trips a libuv assertion on Windows.
process.exitCode = r.ok ? 0 : 1;
