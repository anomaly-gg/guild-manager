# Guild Manager overhaul — plan of record

Decided 2026-09-22. Direction: **fewer, stronger features**, built around **boss timers and events**,
useful across MMOs without being game-specific, with a **visual redesign** on top. This file is the
lock; reopen a decision here only with a new reason, not a new mood.

## Thesis

An MMO guild has three recurring coordination problems that Discord alone does badly:

1. **When does the boss spawn?** Shared timers with kill logging, alerts, and a Discord ping.
2. **When is the raid, and who is coming?** Events with RSVP by role, recurrence, reminders, attendance.
3. **Who do we have?** A roster with game roles and weekly availability.

Everything else a guild does (chat, announcements, polls, files) Discord already does better.
Guild Manager wins by being the best at these three, not by having seventeen tabs.

## Modules after the overhaul

| Module | Keeps | Adds |
|---|---|---|
| **Home** | today's dashboard | next spawns, next events, who's online, at a glance; mobile-first |
| **Timers** | interval / fixed / weekly / biweekly / twice-daily bosses, kill logging, alerts, DND, webhooks, import/export, templates, kill history | spawn **windows** (min–max respawn), per-boss location/channel note, "next up" ordering, a **public read-only timer page** to pin in Discord, per-member timezone display |
| **Events** | create, RSVP, attendance, recurrence, reminders, start/end notices, event templates, attendance report | **RSVP by role** (tank / healer / DPS / support, editable labels), sign-up caps, week view, iCal export |
| **Roster** | members, roles, kick/leave/transfer, notes, availability grid, join requests, invite settings | **game role / class field** per member, availability shown next to events |
| **Loot & Points** (optional, off by default) | loot log, DKP ledger, awards, decay, wishlist, auctions | nothing new; toggled per team in Settings so guilds that don't run DKP never see it |
| **Settings** | webhooks, notifications, rules, cleanup, customization | module toggles, loot mode; dead fields cut (M8) |

## Cut

Removed from the front end first; worker routes deleted in the cleanup milestone.

| Tab | Why |
|---|---|
| Chat | Discord. Also the only endpoint polled every few seconds. |
| Announcements | Discord. |
| Polls | Discord has native polls. |
| Files | Discord attachments; R2 cost and abuse surface for near-zero use. |
| Wars | Game-specific (GvG log). If wanted later it is an event type with a result field. |
| Matches | Inter-team challenges need both guilds on the platform; no network to make it useful. |
| Performance | Niche stat logging; guilds that want it use spreadsheets or game addons. |
| Recruitment | Niche; recruiting happens on Discord servers and game forums. |
| Analytics | Charts over the cut features. Kill history and attendance report stay inside Timers and Events. |
| Rosters (lineup builder) | Returns in M3 as a per-event lineup inside Events, where a raid lineup actually belongs. |

Data in cut tables is left in D1 untouched until the cleanup milestone; nothing is deleted on the
first pass, the tabs just disappear.

## Premium (decided in M5, 2026-09-23; numbers live in `worker/src/lib/limits.js`)

| | Free | Premium |
|---|---|---|
| Teams | 1 | unlimited |
| Members per team | 10 | 100 |
| Boss timers | 15 | unlimited |
| Discord alert channels | 1 per alert (main + schedule post) | up to 3 per alert, plus boss and event alerts in channels of their own (M17) |
| Loot & Points module | included | included, plus wishlist, auctions, decay |
| Boss templates, kill history | – | ✓ |
| Public timer page | – | ✓ |
| Event templates, attendance report, calendar feed | – | ✓ |
| Team icon, no watermark | – | ✓ |

Loot & Points stays free so no existing team loses access to its data. Premium is $2/month or $10
lifetime with a 7-day trial (unchanged). Billing is Gumroad since M9 (2026-09-23); see `worker/GUMROAD_SETUP.md`.

## Visual direction

- **Mobile-first.** The main use is checking a timer on a phone mid-raid. Everything must work
  at 360px wide before it is styled for desktop.
- **Top nav with 4–5 modules**, not a 17-item sidebar. Team switcher in the header.
- **Timer cards with a countdown ring/bar** and a clear state (waiting / window open / spawned).
- **Dark by default**, light theme kept. One token set in `css/tokens.css`, components in
  `css/components.css`, one stylesheet per module.
- Readable type scale, 8px spacing grid, consistent buttons/inputs/cards/modals/toasts.
- The visuals are designed in the browser and reviewed by screenshot, not described in prose.

## Architecture during the overhaul

- Each rebuilt module becomes a real **ES module** (`js/modules/<name>.js`) with its own state and
  explicit imports; inline `onclick` handlers are replaced by event delegation inside the module.
  The classic-script files from the 2026-09-22 split are deleted module by module as they are replaced.
- No framework, no build step (GitHub Pages serves files as-is). Template literals + a tiny
  `html` helper for escaping.
- `index.html` gets `?v=` cache-busting on its script and style tags, bumped per release.
- Worker: unchanged API shapes for kept features. New endpoints (public timer page, RSVP roles,
  spawn windows) are added to the existing route modules. Cut routes are deleted in M6.
- Every milestone is verified in Chrome on the same-origin local harness (page + `wrangler dev`)
  before it is pushed. The replay harness covers worker changes.

## Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Plan locked (this file), cut list confirmed | committed |
| M1 | **Shell + design system**: tokens, components, top nav, team switcher, Home; cut tabs hidden | DONE 2026-09-22: new shell renders every kept tab; verified desktop + 390/360px |
| M2 | **Timers rebuild**: module, new cards, spawn windows, next-up ordering, public timer page | DONE 2026-09-22: `js/modules/timers.js` (ES module), dense rows w/ countdown ring, location, spawn windows, edit endpoint, `timers.html` public page; verified desktop + phone with 20 bosses |
| M3 | **Events rebuild**: module, RSVP by role, caps, week view, iCal | DONE 2026-09-22: `js/modules/events.js`, dense rows, RSVP roles (team-editable), caps w/ 409, week view, per-event lineup (replaces Rosters), attendance modal, iCal feed, edit endpoint |
| M4 | **Roster rebuild**: members + game role + availability; Settings with module toggles | DONE 2026-09-23: `js/modules/roster.js` (Members / Availability / Requests), game_role per membership, Loot & Points toggle (off by default, auto-on for teams with data), availability hint in event details |
| M5 | **Loot & Points** as an optional module; premium redefinition | DONE 2026-09-23: `js/modules/points.js` (Loot / Points sub-views, wishlist + auctions premium), `worker/src/lib/limits.js` (Free 1 team / 10 members / 15 timers; Premium unlimited / 100 / unlimited), premium gates on public timer page + calendar feed, upgrade/pricing/help copy updated |
| M6 | **Cleanup**: delete cut front-end files and worker routes, drop cut tables' data export path, final polish | DONE 2026-09-23: 9 route files deleted, chat auto-delete out of the cron, cut fields out of Settings, 93 dead CSS rules removed, shared styles in `css/components.css`, spinner finally styled |
| M6.5 | **Shell polish** (user request 2026-09-23): login screen, Your Teams list, header strip, help modal, logo | DONE 2026-09-23: login = hero + sign-in card (card first on phones); teams = dense rows + inline Join/New + empty state; header = brand, help/theme icon buttons, account chip menu (plan chip, Upgrade, Pricing, Log out); Create/Join/Help modals on components.css; help text rewritten (8 sections, stale Dashboard entry gone); new flat logo; dropdowns close on outside click/Esc; join now refreshes the list |
| M7 | **Loot rotation** (decided 2026-09-23): an ordered member list, take a drop → move to the bottom; officers can bump for attendance. Default loot mode for new teams; DKP stays as the alternative mode | DONE 2026-09-23: `team_settings.loot_mode` (rotation default; teams with a DKP ledger stay on dkp) + `team_members.loot_pos`; `lib/rotation.js` + `routes/rotation.js` (GET order, officer move top/bottom/up/down, leader reset); logging loot moves the recipient down unless keepPosition; Rotation sub-view in points.js (Next chip, last drop, Took loot prefilled, ⋯ menu); mode switch in Settings → Modules; 28-check API test + Chrome desktop/phone walkthrough |
| M8 | **Post-overhaul candidates** (user: "keep going through the candidates") | (a) DONE 2026-09-23: Discord ping when loot is logged (`on_loot`, general webhook, names the next in rotation). (b) DONE 2026-09-23: Settings rebuilt as `js/modules/settings.js` on the shared form classes; dead fields cut (starting DKP, default event duration, inactive days, accent color, custom role names — none had a consumer); points name now really stored (`points_name`); the garbled transfer-leadership select fixed. (c) CODE DONE 2026-09-23: the 16 cut tables are no longer created or touched by the worker; the actual DROP on production is a manual, irreversible step — procedure + one-line commands in `worker/DROP_TABLES.md` |
| M9 | **Pricing page + payment method** (user request 2026-09-23: "we forgot the pricing page and the payment method"; Paddle and Lemon Squeezy both refused seller verification) | CODE DONE 2026-09-23: `pricing.html` rebuilt on the design system (`css/pricing.css`, deep-links `./?upgrade=`); billing moved to **Gumroad** (no seller review; PayPal/bank payout in PH): `worker/src/lib/gumroad.js` + `routes/billing.js` (unsigned Ping verified via the license API, manual key activation, checkout link with `uid`, cron recheck every ~20 h revokes ended/refunded), upgrade modal rebuilt in `js/billing.js`/`css/billing.css` (new-tab checkout + activation poll + key entry), Paddle removed, legal pages updated. 26-check API test green on the local harness with a mock Gumroad. PENDING: user creates the two Gumroad products, fills `wrangler.toml` `[vars]` (see `worker/GUMROAD_SETUP.md`), then one worker deploy + one page push together; Chrome walkthrough of the modal not done (extension was disconnected) |

Each milestone is one push (page) and, when needed, one `wrangler deploy` (worker).

## After M9 — product stage (agreed 2026-09-23)

The thesis is embodied; the product is not yet real: 7 non-guest sign-ins, 3 teams with timers, 1 event,
nearly all the author's. The next test is distribution, not features. Agreed queue, in order, each
small enough to ship between real-guild feedback rounds:

| # | Item | Why |
|---|---|---|
| M10 | **Game presets**: built-in boss lists per game, free, one click | DONE 2026-09-23: presets live in code, not the DB (`worker/src/presets/<game>.js`, `GET /api/presets`, `POST /api/teams/:id/bosses/presets` — officer+, skips names the team has, stops at the free cap, one D1 batch); Lord Nine = 41 bosses merged from the two live guilds; shared `lib/boss-create.js` now builds rows for create, template import (which previously mis-timed every non-interval boss) and presets; Timers empty state leads with "Start from a game preset", ⋯ menu has it too; 17-check API test |
| M11 | **Account deletion + data export** | DONE 2026-09-23: `routes/account.js` — `GET /api/me/export` (profile, memberships, full dump of teams you lead; JSON download) and `DELETE /api/me` (refused with 409 while you lead a team that has other members; teams you lead alone are deleted via the shared `lib/team-delete.js`; personal rows removed; users row anonymised to "Deleted user" so team histories keep their FK'd entries; stale tokens get 401 on /auth/me, create-team and join). Account & data modal from the account menu (`js/account.js`), privacy page rewritten to match, help entry. 14-check API test |
| M12 | **Per-member timezone** display | DONE 2026-09-23: finding — displays were already device-local; the real gap was boss schedules being ENTERED in team time with no label, and no way to view in team time. Now: per-device preference (Account & data → Times: my device / team time, `gm_tz_mode`) applied through `tzOpts()` in util.js to timers, events, home, kill history; boss form states the team zone and the offset from the device; schedule text and event rows carry a "team time" note when the viewer's clock differs (public page too); team detail exposes `timezone` |
| M13 | **Discord slash commands** | CODE DONE 2026-09-23: `routes/discord.js` + `lib/discord-interactions.js` (Ed25519-signed `/discord/interactions`; deferred ack + `ctx.waitUntil` edit because Discord's 3 s limit vs far D1; autocomplete answers directly), `/link <code>` `/unlink` (officer+), `/next` (anyone in the server — the discovery surface), `/killed <boss> [minutes_ago]` (team members via `users.discord_id`; shared `lib/boss-kill.js`), `team_settings.discord_guild_id`, Settings card with invite link + status + unlink, `scripts/register-commands.mjs`. 24-check signed test with a mock Discord API. Setup + rationale in `worker/DISCORD_BOT.md`. PENDING (user): set the Interactions Endpoint URL in the portal, run the register script with the bot token, add the bot to a server, `/link` LIVE-VERIFIED 2026-09-23 (/next + /killed from the Viserion server). User: "pretty complicated to link" → one-click link the same day: Settings → Add to Discord → Discord's authorize page → `/discord/added` callback links the chosen server via a signed state (`GET /api/teams/:id/discord-link`); `/link` kept as fallback; 31-check suite |
| M14 | **Web push** for spawn alerts to phones | the other half of "alert me", beyond the Discord channel. DECIDED 2026-09-30 (user): **free** (not Premium); per-member **spawn-group filter in v1** (follow some groups per team, default all). Design: VAPID keys made + kept by the worker itself (app_state, no secret step); pushes ride the cron's existing soon/spawned moments (independent of Discord webhooks); maintenance reset = one push; per-member prefs per team (soon / spawned / groups) in an account-menu "Phone alerts" dialog; iPhone needs Add to Home Screen first. CODE DONE 2026-09-30: pushes are EMPTY wake-ups (payload encryption measured ~0.5-0.75 ms CPU per device, over the free cron's 10 ms); the device then POSTs `/public/push/sync` and `sw.js` shows ONE notification per team (user: no flooding), ringing only for a boss newly soon/up, updated silently on kill/auto-reset, closed when nothing is left; the in-tab alerts follow the same rules. ≤30 wake-ups per run, rest next minute (free plan subrequest cap). Files: `lib/webpush.js`, `push-keys.js`, `push-prefs.js`, `push-send.js`, `push-state.js`, `routes/push.js`, `/sw.js`, `js/modules/push.js`, `css/push.css`. Suites push-unit 21, push 34, push-e2e 13 (real Chrome subscription; pushes delivered via DevTools). PENDING: live check on his Chrome + phone |

Not doing: adding features to win an argument nobody has had. Post in 2–3 guild communities, watch
three real guilds for a week, let their questions reorder this list.

| M15 | **Rally attendance** (from the user's guild 2026-09-24: daily Discord threads of screenshots, admins verify by eye and re-type into a doc, points computed by hand) | CODE DONE 2026-09-24: `/here <boss> <proof> [boss2] [note]` (member self check-in, screenshot copied to R2 + SHA-256), `/rollcall <boss> <@members>` (officer, approved on the spot); `attendance_claims` with fraud flags — no kill of that boss logged that day, sent >3 h after the kill, duplicate image, many claims today; one claim per member per boss per day; Events → **Attendance** view = review queue (thumbnails, flags, approve/reject, "approve all unflagged") + points summary 7/30/90 d; approval writes `dkp_ledger` lines "Rally: …"; Settings → Rally attendance: points per boss, self check-in on/off, trust mode (auto-approve unflagged). `lib/attendance.js`, `routes/attendance.js`, `js/modules/attendance.js`. Suite 54/54. PENDING: re-run the register script (2 new commands), live try from the guild |
| M17 | **Alerts in several Discord channels** (user 2026-09-30: "each alert can only take 1 webhook… more is better") | CODE DONE 2026-09-30: every webhook field (main, boss, events, schedule) is a list — Free 1, Premium 3 (`PLANS.*.webhooks` in `lib/limits.js`; 3 = what the free plan's 50 subrequests/cron run can carry: 3 bosses up in one minute × 2 calls × 3 channels). Stored in the same columns as JSON `[{u, n}]`, a bare URL from before reads as a one-channel list (no migration). Edited messages (boss alerts, schedule post) keep ids per channel `{webhookId: msgId}`; a bare id from before = first channel. Schedule post claims missing channels with `''` (no double post), a hiccup frees the channel for the next minute (no more "hand the day back"), a 4xx keeps `''` until the channel is added again. Adding asks Discord first (typo/deleted webhook refused, webhook name shown). Cron counts Discord calls; phone pushes get what is left of the 50 (min 5, max 30, rest next minute). `lib/webhooks.js`, `routes/webhooks.js` (add / remove / test), `js/modules/webhook-list.js`; the PUT settings webhook fields and `/settings/test` are gone. Suites webhooks-unit 17, schedule 81 |
| M18 | **Spawn-group roles per Discord server** (user 2026-09-30: schedule posted to channels in several servers, roles differ per server) | DONE 2026-09-30: role ids are per server, so copying roles by name cannot work. Groups store `roles: {guildId: roleId}`; each channel remembers its server (`g`, from the webhook lookup); the schedule post renders per server (channels whose servers see the same roles share one render), `/next` + `/assign` use the server they are typed in; a server where a group has no role shows plain `@Name`. Old single `roleId` keeps working everywhere until Settings opens, which files it under the linked server that has it and looks up the server (and missing name) of older channels once (`lib/settings-backfill.js`). Settings: one role picker per linked server; channel rows show their server. Deploy order: worker BEFORE page (an old worker drops the new `roles` field on save). Suites groups-unit 14, schedule 94 |
| M19 | **Maintenance reset with a time window** (user 2026-09-30: fixed/day bosses due during maintenance are up in game when the server opens; reset should take a window, e.g. 9:00-14:00) | DONE 2026-09-30: dialog = day + from + server-opens times, pre-filled with the last window (`team_settings.maintenance_from`), live summary from the worker (`preview: true`). `lib/maintenance.js planReset`: every interval boss + any fixed-schedule boss whose spawn fell in [from, open) (still waiting, shown up, or auto-reset by us during the window) goes up at open with the 30-min wait; a boss with a kill logged after open is left alone (reset pressed late); our in-window auto-reset rows leave the schedule post. After the kill fixed bosses return to their own rule. Same day (2026-09-30) the 5-min auto-reset fix (fd1d4e9) and a live repair of 7 bosses an import had moved back to pre-maintenance times. Deploy order: worker BEFORE page (an old worker ignores `preview` and would APPLY the reset when the dialog opens). Suites maintenance-unit 7, schedule 103, maintenance-e2e 7 |
