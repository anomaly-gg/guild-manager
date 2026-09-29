# Front-end layout

`index.html` is markup only. Styles: `css/tokens.css` (design tokens), `css/shell.css` (header, module
nav, Home, buttons/cards), `css/components.css` (toolbar, menus, modals, forms, rows, spinner — shared by
every module), one file per module (`timers`, `events`, `roster`, `points`), and `css/app.css` for the
remaining pre-overhaul screens (login, team list, Settings). Behaviour is one
classic script per feature under `js/`, loaded in order at the end of `<body>` with `?v=` cache-busting
(bump the version in index.html on every release).

Classic scripts (not ES modules) on purpose: the tab templates use inline `onclick="fn()"` handlers
and the features share top-level state (`currentTeamId`, `teamData`, ...). Classic scripts share one
global scope exactly like the original single inline script did, so this split is a pure move.
Migrating a feature to a module with explicit imports and state is part of the overhaul, tab by tab.

Load order matters only for code that runs at load time:

| file | runs at load |
|---|---|
| `theme-help.js` | applies the saved theme |
| `core.js` | API base, session state, `guard()` |
| `util.js` | generic helpers |
| `api.js` | `api()` + TTL cache (must precede any caller that runs at load) |
| `notifications.js` | in-tab boss alerts: one notification per team, updated in place, closed when nothing is up (off when phone alerts are on); DND toggle |
| `auth.js` | reads `?token=` from an OAuth redirect into localStorage |
| feature files | function definitions only |
| `timers.js` | starts the background `setInterval` loops |
| `home.js` | Home module (next spawns, upcoming events, roster) |
| `main.js` | `init()` — always last |

Modules (see OVERHAUL.md): `home`, `modules/timers.js` (Timers, ES module; shares `modules/timer-cards.js` with the public `timers.html`), `modules/events.js` (Events, ES module), `modules/roster.js` (Roster, ES module),, `modules/push.js` (Phone alerts dialog + this device's push subscription; the device side is `/sw.js`), `modules/maintenance-reset.js` (Timers → Maintenance reset).
`modules/points.js` (Loot & Points, ES module, optional per team; rotation or DKP mode per `team.loot_mode`), `modules/settings.js` (ES module). Shared screens: `auth`, `billing`, `account`, `teams`, `team-view`
(module nav + sub-views: `MODULES` / `SUB_VIEWS`, `openModule()`, `openSubView()`).
Cut tabs (chat, announcements, polls, files, wars, matches, performance, recruitment, analytics,
rosters) are gone from both the front end (M1) and the worker (M6). Their tables still exist in D1 with
old data; nothing reads them.

Local test harness: serve the folder on one origin and proxy `/api` + `/auth` to `wrangler dev`
(the worker only allows the GitHub Pages origin, so a plain file server cannot reach it).
