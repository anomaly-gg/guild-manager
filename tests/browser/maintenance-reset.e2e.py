"""Timers -> Maintenance reset: the dialog counts the right bosses and moves only the respawn timers.
Browser against the site proxy (8790) + wrangler dev (8788). Screenshot: tests/.out/maintenance_dialog.png"""
import json, os, sys, time, urllib.request, urllib.parse
from playwright.sync_api import sync_playwright

W = 'http://127.0.0.1:8788'
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.out')
res = []
def check(name, ok, info=''):
    res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'   <- {info}'))

def api(method, path, body=None, token=None):
    req = urllib.request.Request(W + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        r = urllib.request.urlopen(req); return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')

_, g = api('POST', '/auth/guest', {'username': 'maint_lead'}); tok = g['token']
_, t = api('POST', '/api/teams', {'name': 'Maint Guild'}, tok); team = t.get('id') or t['team']['id']
H = 3600000
ids = {}
for name, rule in [('Venatus', {'type': 'interval', 'intervalMs': 10 * H}), ('Viorent', {'type': 'interval', 'intervalMs': 10 * H}),
                   ('Ego', {'type': 'interval', 'intervalMs': 21 * H}), ('Saphirus', {'type': 'fixed', 'fixedTime': '11:30'})]:
    _, a = api('POST', f'/api/teams/{team}/bosses', {'name': name, **rule}, tok); ids[name] = a['id']
def bosses():
    _, d = api('GET', f'/api/teams/{team}/bosses', None, tok)
    return {b['name']: b for b in d['bosses']}
sap_before = bosses()['Saphirus']['next_spawn']

with sync_playwright() as p:
    chrome = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
    b = p.chromium.launch(executable_path=chrome, headless=True) if os.path.exists(chrome) else p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1100, 'height': 900})
    pg.goto('http://127.0.0.1:8790/?token=' + urllib.parse.quote(tok, safe=''))
    pg.wait_for_timeout(1200)
    pg.evaluate(f"openTeam('{team}')"); pg.wait_for_timeout(1200)
    pg.evaluate("openModule('timers')"); pg.wait_for_timeout(1200)
    pg.click('[data-role="menu"] summary'); pg.wait_for_timeout(200)
    pg.click('[data-action="maintenance"]'); pg.wait_for_timeout(600)
    text = pg.inner_text('.modal-card')
    check('dialog: counts 3 respawn timers and 1 fixed boss', '<b>' not in text and 'all 3 of them' in text and '1 fixed-schedule boss keeps its time' in text, text)
    check('dialog: button says what it does', pg.inner_text('[data-act="apply"]') == 'Reset 3 timers', pg.inner_text('[data-act="apply"]'))
    os.makedirs(OUT, exist_ok=True)
    pg.locator('.modal-card').screenshot(path=os.path.join(OUT, 'maintenance_dialog.png'))
    t0 = int(time.time() * 1000)
    pg.click('[data-act="apply"]'); pg.wait_for_timeout(1500)
    after = bosses()
    opened = [after[n]['next_spawn'] for n in ('Venatus', 'Viorent', 'Ego')]
    check('apply: all respawn timers at the same open time (now, to the minute)', len(set(opened)) == 1 and abs(opened[0] - t0) < 90000, opened)
    check('apply: fixed boss untouched', after['Saphirus']['next_spawn'] == sap_before)
    check('apply: dialog closed', pg.locator('.modal-card').count() == 0)
    b.close()

print(f'{sum(res)}/{len(res)} checks passed')
sys.exit(0 if all(res) else 1)
