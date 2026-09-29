# Discord slash commands — setup and how it works

Built 2026-09-23 (M13). Same Discord application as the "Continue with Discord" login
(app id `1488742496660881528`, in `wrangler.toml` as `DISCORD_APP_ID`; public key `DISCORD_PUBLIC_KEY`).
The bot token is the secret `DISCORD_BOT_TOKEN` (`npx wrangler secret put DISCORD_BOT_TOKEN`); the
worker itself never needs it — only `scripts/register-commands.mjs` does.

## Commands

| Command | Who | Does |
|---|---|---|
| `/link <code>` | leader/officer of the team, signed in to Guild Manager with Discord | ties this Discord server to the team with that invite code (a server belongs to one team; a team may link many servers — `discord_guilds`) |
| `/unlink` | leader/officer | removes the tie (also possible from Settings → Discord slash commands) |
| `/here <boss> <proof> [boss2] [note]` | team members (if self check-in is on) | rally check-in with a screenshot; stored in R2, hashed; flagged when no kill of that boss was logged that day, sent >3 h after the kill, or the image was seen before; pending review unless trust mode is on |
| `/rollcall <boss> <@members…> [boss2] [note]` | leader/officer | logs everyone mentioned as attended, approved immediately, points awarded |
| `/next [count]` | **anyone** in the linked server | next spawns, up-now first, team time, with a link to the timer page / app |
| `/killed <boss> [minutes_ago]` | team members only | logs the kill and restarts the timer; boss name autocompletes; ambiguous names ask "which one?" |
| `/assign <boss> <group> [spawn]` | leader/officer | tags one of the boss's coming spawns (next / 2nd / 3rd) with a spawn group; "No group" clears it. When a spawn ends, the 2nd pick becomes the next, and so on; bosses with "Alternate groups" on (Timers → group chip) hand an unpicked next spawn to the next group in the list |

`/next` is deliberately open: it is the discovery surface (every reply carries the Guild Manager
link). `/killed` is not, because a stranger in a public server could reset a guild's timers.

## Daily schedule post (`lib/schedule-post.js`, `lib/schedule-format.js`)

Not a slash command: a webhook message. With Settings → Daily schedule post → webhook set, the
cron posts one embed per team-clock day at 00:00 and edits that same message (never a new one)
when a spawn comes up (`🔴 up <t:…:R>`), is killed (grey `-# ~~line~~ ✓`, packed at the top),
auto-resets (`↺ auto-reset`), or a timer/group changes. A summary line (`✅ done · 🔴 up · ⏳ to go`)
heads the post, the soonest spawn carries `⏳ next, <t:…:R>`, and blocks are split by blank lines.
Relative `<t:…:R>` timestamps count down in each reader's Discord, so they stay right between edits;
the embed timestamp shows when the post was last edited. Short-timer bosses appear once per spawn that day: the later ones are projected
(next spawn + respawn, or the next calendar time; lib/spawn-projection.js) and move by themselves
when the real kill is logged. `/next` lists spawns the same way (repeats within 24 h). Finished spawns are kept in `schedule_spawns` (pruned after 3 days) so the
day's post keeps them crossed out. A kill after midnight of last night's spawn also edits
yesterday's message. If someone deletes the message, the next change posts a fresh one; if
Discord fails at midnight, the next cron minute retries. Role mentions render coloured but never
ping (`allowed_mentions: { parse: [] }`).

Maintenance reset (Timers → ⋯ → Maintenance reset, `routes/maintenance-reset.js`): every interval
timer moves to the server-open time; fixed-schedule bosses keep theirs. The rows are marked already
warned/notified, so the alert channel gets ONE "🔧 Maintenance reset" message instead of a ping per
boss; the cron still brings them up and auto-resets them as usual.

## One-time setup (portal + terminal)

1. **Interactions Endpoint URL** — Developer Portal → the app → General Information →
   `https://guild-manager.xpropics.workers.dev/discord/interactions` → Save. Discord sends a signed
   PING; the worker must answer PONG or the save is refused (that is the signature check working).
2. **Register the commands** (from the worker folder, token in the environment, never in a file):
   ```
   $env:DISCORD_BOT_TOKEN='<token>'; node scripts/register-commands.mjs
   ```
   Global registration can take up to an hour to show in clients. For instant testing on one server:
   `node scripts/register-commands.mjs <server id>` (Developer Mode → right-click the server → Copy ID).
3. **Redirect URI** (one-time, so the one-click link works) — Developer Portal → OAuth2 → Redirects → add
   `https://guild-manager.xpropics.workers.dev/discord/added` → Save.

## What a guild leader does (every guild)

Settings → Discord slash commands → **Add to Discord**. Discord asks which server; on Authorize it
sends the leader to `/discord/added?guild_id=…&state=…` where `state` is our signed token naming the
team and the user (issued by `GET /api/teams/:id/discord-link`, officer+). The worker links the server
and redirects back to the app with `?discord=linked`. Scopes: `applications.commands bot` with
permissions 0 — the `bot` scope is what makes Discord include `guild_id` in the redirect; the bot
user reads nothing and has no permissions. Fallback: `/link <invite code>` in the server.

## How a command is handled (`routes/discord.js`, `lib/discord-interactions.js`)

- Discord signs `timestamp + body` with the app's Ed25519 key. `verifyDiscordRequest` checks it with
  WebCrypto; anything unsigned or mis-signed gets 401 (tested).
- Discord requires an answer within 3 s and this worker's D1 sits in Hong Kong, far from Discord's
  servers. So commands are acknowledged with a **deferred** response immediately and completed in
  `ctx.waitUntil`, which then PATCHes the placeholder via the interaction token (`editOriginal`).
  Autocomplete cannot be deferred: it does one query and answers directly.
- `/link` and `/unlink` replies are ephemeral (only the invoker sees them).
- Membership = `users.discord_id` (from Discord login) joined to `team_members`. Google-only accounts
  cannot use `/killed` until they sign in with Discord once (Discord login on the same account is not
  supported yet — separate accounts).

## Local test

`.dev.vars` holds a TEST public key (`DISCORD_PUBLIC_KEY`) and `DISCORD_API = http://127.0.0.1:8797`;
the scratchpad's `m13_discord_test.mjs` signs requests with the matching private key and runs a mock
Discord API that records the follow-up edits. 24 checks. Production uses the real key from `wrangler.toml`.
