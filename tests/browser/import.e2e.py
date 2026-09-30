"""Screenshot timer import, end to end through the real page: draw a Discord-style schedule image,
then Timers -> ... -> Import from screenshot -> OCR -> review -> Apply, and check the timers.
Also opens the groups dialog from a timer row chip. Needs the worker (8788) + tests/lib/local_site.py (8790).
Run through tests/run_all.mjs; argv[1] = worker dir (unused here), OUT env = where screenshots go."""
import json, os, sys, tempfile, time, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright

W = 'http://127.0.0.1:8788'
SITE = 'http://127.0.0.1:8790'
OUT = os.environ.get('OUT') or tempfile.gettempdir()
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
MANILA = timezone(timedelta(hours=8))
res = []
def check(name, ok, info=''):
    res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'   <- {info}'), flush=True)
def api(method, path, body=None, token=None):
    req = urllib.request.Request(W + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        r = urllib.request.urlopen(req); return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')
def launch(p):
    return p.chromium.launch(executable_path=CHROME, headless=True) if os.path.exists(CHROME) else p.chromium.launch(headless=True)

# ---- the schedule image: undated lines, so each time means "the next time the clock shows this"
now = datetime.now(MANILA).replace(second=0, microsecond=0)
def hm(dt): return dt.strftime('%I:%M %p').lstrip('0')
LINES = [  # (time, name, level, tag)
    (now + timedelta(minutes=60), 'Lady Dalia', 85, 'Kongreso'),
    (now + timedelta(minutes=75), 'Araneo', 75, 'Kongreso'),
    (now + timedelta(minutes=90), 'Gareth', 98, 'Senado'),
    (now + timedelta(minutes=105), 'Icaruthia', 135, None),
    (now + timedelta(minutes=60, hours=18), 'Lady Dalia', 85, 'Senado'),
]
LINES.sort(key=lambda l: l[0].hour * 60 + l[0].minute if l[0].date() == now.date() else 10000 + l[0].hour * 60 + l[0].minute)
def pill(t): return f'<code>{hm(t).ljust(8).replace(" ", "&nbsp;")}</code>'
rows_html = ''.join(f'<div>{pill(t)} | {n} ({lv}){f" | <span class=tag>@{tag}</span>" if tag else ""}</div>' for t, n, lv, tag in LINES)
IMAGE_HTML = f"""<html><body style="margin:0;background:#2b2724;color:#dbdee1;font:16px 'gg sans','Segoe UI',sans-serif;padding:16px;width:460px">
<style>code{{background:#1e1f22;border:1px solid #3f4147;border-radius:4px;padding:1px 4px;font-family:Consolas,monospace;font-size:14px}}
div{{line-height:1.9}} .tag{{background:#4b3a26;color:#f0b232;border-radius:3px;padding:0 2px}}</style>{rows_html}</body></html>"""

# ---- team: 2 timers already there, 2 groups
_, g = api('POST', '/auth/guest', {'username': 'Import Lead'}); tok = g['token']
_, t = api('POST', '/api/teams', {'name': 'Import Guild'}, tok); team = t.get('id') or t['team']['id']
api('POST', f'/api/teams/{team}/bosses/presets', {'presetId': 'lordnine', 'names': ['Lady Dalia', 'Araneo']}, tok)
api('PUT', f'/api/teams/{team}/settings', {'timezone': 'Asia/Manila', 'spawnGroups': [{'name': 'Kongreso'}, {'name': 'Senado'}]}, tok)
_, st = api('GET', f'/api/teams/{team}/settings', None, tok)
gid = {x['name']: x['id'] for x in st['spawnGroups']}
_, b0 = api('GET', f'/api/teams/{team}/bosses', None, tok)
before = {b['name']: b for b in b0['bosses']}

with sync_playwright() as p:
    br = launch(p)
    shot = os.path.join(OUT, 'import_source.png')
    img = br.new_page(viewport={'width': 492, 'height': 60 + 32 * len(LINES)})
    img.set_content(IMAGE_HTML); img.screenshot(path=shot); img.close()

    pg = br.new_page(viewport={'width': 1100, 'height': 1000}, color_scheme='dark')
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(SITE + '/?token=' + urllib.parse.quote(tok, safe=''))
    pg.wait_for_timeout(1200)
    pg.evaluate(f"openTeam('{team}')"); pg.wait_for_timeout(1200)
    pg.evaluate("openModule('timers')"); pg.wait_for_timeout(1200)
    pg.click('[data-role="menu"] summary'); pg.click('[data-action="import-shot"]')
    pg.wait_for_selector('.si-drop')
    pg.set_input_files('[data-role="file"]', shot)
    t0 = time.time()
    pg.wait_for_selector('.si-row', timeout=120000)
    print(f'   OCR + review ready in {time.time() - t0:.1f}s', flush=True)
    pg.wait_for_timeout(300)
    pg.screenshot(path=os.path.join(OUT, 'import_review.png'), full_page=True)
    rows = pg.eval_on_selector_all('.si-row', "els => els.map(e => ({ read: e.querySelector('.si-name').textContent, act: e.querySelector('.si-act').textContent, on: e.querySelector('input[type=checkbox]').checked, target: e.querySelector('.si-target').selectedOptions[0].textContent }))")
    # OCR noise at the start of a name depends on the times drawn (a stray "]" from the time box,
    # "lcaruthia" for "Icaruthia"); the app's fuzzy match absorbs it, so look rows up the same way
    by = lambda n: [r for r in rows if n[1:].lower() in r['read'].lower()]
    check(f'review lists all {len(LINES)} lines', len(rows) == len(LINES), rows)
    check('Araneo -> Update the existing timer', by('Araneo') and by('Araneo')[0]['act'] == 'Update' and by('Araneo')[0]['target'] == 'Araneo', by('Araneo'))
    check('Gareth + Icaruthia -> Add from the game preset', all(by(n) and by(n)[0]['act'] == 'Add' and by(n)[0]['target'] == 'New: ' + n for n in ('Gareth', 'Icaruthia')), [by('Gareth'), by('Icaruthia')])
    ld = by('Lady Dalia')
    check('Lady Dalia twice: first updates the timer, second is "Later" (sets the 2nd spawn group)', len(ld) == 2 and ld[0]['act'] == 'Update' and ld[1]['act'] == 'Later' and ld[1]['on'], ld)
    pg.click('[data-act="apply"]'); pg.wait_for_timeout(2000)
    check('no page errors', not errors, errors)

    _, b1 = api('GET', f'/api/teams/{team}/bosses', None, tok)
    after = {b['name']: b for b in b1['bosses']}
    check('no duplicate timers; 2 added', sorted(after) == ['Araneo', 'Gareth', 'Icaruthia', 'Lady Dalia'], sorted(after))
    exp = int((LINES[[n for _, n, _, _ in LINES].index('Araneo')][0]).timestamp() * 1000)
    check('Araneo moved to the screenshot time with @Kongreso', after['Araneo']['next_spawn'] == exp and after['Araneo']['spawn_group'] == gid['Kongreso'], [after['Araneo']['next_spawn'], exp])
    check('Lady Dalia: @Kongreso next, @Senado for her 2nd spawn', after['Lady Dalia']['spawn_group'] == gid['Kongreso'] and json.loads(after['Lady Dalia']['later_groups'] or '[]') == [gid['Senado']], after['Lady Dalia'])

    # ---- groups dialog from the row chip
    pg.evaluate("openModule('timers')"); pg.wait_for_timeout(1500)
    gar = after['Gareth']['id']
    pg.click(f'[data-action="groups"][data-id="{gar}"]'); pg.wait_for_selector('#sgForm')
    pg.select_option('[data-slot="1"]', gid['Kongreso']); pg.check('#sgAlt')
    pg.screenshot(path=os.path.join(OUT, 'groups_dialog.png'))
    pg.click('#sgForm button[type="submit"]'); pg.wait_for_timeout(1200)
    chip = pg.text_content(f'[data-action="groups"][data-id="{gar}"]')

    # ---- after a maintenance reset, the same (now old) screenshot must not undo it
    open_at = int((now + timedelta(hours=2)).timestamp() * 1000)
    rs, rr = api('POST', f'/api/teams/{team}/bosses/maintenance-reset', {'openAt': open_at, 'from': open_at - 3 * 3600000}, tok)
    check('maintenance reset for the second import', rs == 200, rr)
    pg.evaluate("openModule('timers')"); pg.wait_for_timeout(1200)
    pg.click('[data-role="menu"] summary'); pg.click('[data-action="import-shot"]')
    pg.wait_for_selector('.si-drop')
    pg.set_input_files('[data-role="file"]', shot)
    pg.wait_for_selector('.si-row', timeout=120000); pg.wait_for_timeout(300)
    pg.screenshot(path=os.path.join(OUT, 'import_after_reset.png'), full_page=True)
    rows = pg.eval_on_selector_all('.si-row', "els => els.map(e => ({ read: e.querySelector('.si-name').textContent, on: e.querySelector('input[type=checkbox]').checked, note: (e.querySelector('.si-note') || {}).textContent || '' }))")
    stale = [r for r in rows if 'before the maintenance reset' in r['note']]
    banner = pg.text_content('.si-banner') if pg.locator('.si-banner').count() else ''
    names = sorted(n for n in ('Araneo', 'Gareth', 'Lady Dalia') if any(n[1:].lower() in r['read'].lower() for r in stale))
    check('lines from before the reset: Araneo, Gareth, Lady Dalia unticked and noted', names == ['Araneo', 'Gareth', 'Lady Dalia'] and not any(r['on'] for r in stale), rows)
    check('banner explains why they are unticked', 'maintenance reset' in banner and 'unticked' in banner, banner)
    if pg.is_enabled('[data-act="apply"]'): pg.click('[data-act="apply"]'); pg.wait_for_timeout(1500)
    else: pg.click('[data-act="close"]')
    _, b3 = api('GET', f'/api/teams/{team}/bosses', None, tok)
    kept = {b['name']: b['next_spawn'] for b in b3['bosses'] if b['name'] in ('Araneo', 'Gareth', 'Lady Dalia')}
    check('the reset holds: they still spawn at server open', set(kept.values()) == {open_at}, kept)
    check('no page errors (second import)', not errors, errors)
    br.close()
_, b2 = api('GET', f'/api/teams/{team}/bosses', None, tok)
g2 = next(b for b in b2['bosses'] if b['name'] == 'Gareth')
check('groups dialog saves the 2nd spawn + alternate; chip shows "+1 ⇄"', json.loads(g2['later_groups'] or '[]') == [gid['Kongreso']] and g2['alternate_groups'] == 1 and '+1' in chip and '⇄' in chip, [g2['later_groups'], g2['alternate_groups'], chip])
print(f'{sum(res)}/{len(res)} checks passed', flush=True)
sys.exit(0 if all(res) else 1)
