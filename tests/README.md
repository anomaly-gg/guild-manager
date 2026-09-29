# Guild Manager tests

One command runs everything against a **local** worker (never the live database):

```
node tests/run_all.mjs
```

Run a few suites by name: `node tests/run_all.mjs discord schedule`. Logs and screenshots land in
`tests/.out/` (git-ignored). Takes about 4 minutes in full; `schedule` is the slow one (it drives the
cron). Needs Node, Python with `playwright`, and internet for `npx wrangler` and the OCR reader
(jsdelivr) used by the import test.

| Suite | What it covers |
|---|---|
| `schedule-parse` (unit) | Screenshot import parser: dates, AM/PM (incl. OCR misreads), levels, @groups, name matching, which line sets the timer |
| `schedule-format` (unit) | Daily post fits Discord's 4096-character embed: oldest finished lines cut first, then the latest upcoming, bosses up now always kept |
| `billing` | Gumroad checkout links, ping, license activation, cron recheck/revoke (mock Gumroad on 8799) |
| `presets` | Game preset list and adding a preset to a team |
| `account` | Account export and deletion |
| `discord` | Slash commands (signed with a key generated per run), server links, autocomplete, /here + /rollcall, reply auto-delete, private errors |
| `schedule` | Daily schedule post (post, edit, rollover, retries), spawn groups, repeat spawns, per-spawn groups + alternation, boss alerts edited in place, command auto-registration, screenshot import route |
| `import-e2e` (browser) | Draws a Discord-style schedule image, imports it through the real page (OCR -> review -> apply), groups dialog |
| `boss-edit-e2e` (browser) | Editing a boss's name/location does not reset its timer; the form sends only what changed |

How it works: `run_all.mjs` wipes only the local test database (`worker/.wrangler/state/v3/d1`),
starts `wrangler dev --local --test-scheduled` with test settings passed as `--var` (so
`.dev.vars` is not needed), and gives each group of suites a fresh database. The Discord suites
give users fixed Discord ids, which must be unique, hence the fresh databases. It refuses to start
if ports 8788/8790/8797/8799 are in use, so it never fights a dev server you are running.
Browser suites go through `lib/local_site.py`, which serves the site with its API pointed at the
local worker.
