// Slash command definitions + automatic registration. The cron calls syncCommands() once per
// isolate: when this list differs from the last one Discord accepted (app_state 'discord_commands'),
// it PUTs the list with the bot token the worker already holds. So a deploy that changes commands
// registers them by itself within a minute; scripts/register-commands.mjs is only the manual fallback.

const API = 'https://discord.com/api/v10';

export const COMMANDS = [
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
      { type: 4, name: 'spawn', description: 'Which spawn (default: the next one)', choices: [{ name: 'Next spawn', value: 1 }, { name: '2nd spawn', value: 2 }, { name: '3rd spawn', value: 3 }] },
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

let synced = false;   // per isolate: one D1 read, then nothing until the next deploy/isolate

export async function syncCommands(env) {
  if (synced || !env.DISCORD_BOT_TOKEN || !env.DISCORD_APP_ID) return;
  const wanted = JSON.stringify(COMMANDS);
  const row = await env.DB.prepare("SELECT value FROM app_state WHERE key = 'discord_commands'").first();
  if (row?.value === wanted) { synced = true; return; }
  const r = await fetch(`${env.DISCORD_API || API}/applications/${env.DISCORD_APP_ID}/commands`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: wanted,
  });
  if (!r.ok) { console.error('discord command sync failed:', r.status, (await r.text().catch(() => '')).slice(0, 300)); return; }   // retried next tick
  await env.DB.prepare("INSERT INTO app_state (key, value) VALUES ('discord_commands', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(wanted).run();
  console.log(`discord commands registered (${COMMANDS.length})`);
  synced = true;
}
