"""Boss edit must not recalculate a running timer unless the spawn rule really changed.
API checks against wrangler dev (8788) + a browser check of what the edit form sends (proxy 8790)."""
import json, os, subprocess, sys, time, urllib.request, urllib.parse
from playwright.sync_api import sync_playwright

W = 'http://127.0.0.1:8788'
WORKER = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'worker')
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

def sql(q):
    subprocess.run(f'npx wrangler d1 execute guild-manager --local --command "{q}"', cwd=WORKER, shell=True, capture_output=True)

_, g = api('POST', '/auth/guest', {'username': 'edit_lead'}); tok = g['token']
_, t = api('POST', '/api/teams', {'name': 'Edit Guild'}, tok); team = t.get('id') or t['team']['id']
H = 3600000
_, a = api('POST', f'/api/teams/{team}/bosses', {'name': 'Viorent', 'type': 'interval', 'intervalMs': 10 * H}, tok); vio = a['id']
_, a = api('POST', f'/api/teams/{team}/bosses', {'name': 'Saphirus', 'type': 'fixed', 'fixedTime': '11:30'}, tok); sap = a['id']
now = int(time.time() * 1000)
api('POST', f'/api/teams/{team}/bosses/{vio}/kill', {'deathTime': now - 3 * H}, tok)
def boss(i):
    _, d = api('GET', f'/api/teams/{team}/bosses', None, tok)
    return next(b for b in d['bosses'] if b['id'] == i)
v0 = boss(vio)

# old-client style: everything resent, only the name differs
api('PUT', f'/api/teams/{team}/bosses/{vio}', {'name': 'Viorent X', 'type': 'interval', 'intervalMs': 10 * H, 'location': 'Ancient Sanctum', 'alertMinutes': 5, 'autoResetMinutes': 5, 'windowMs': 0}, tok)
v1 = boss(vio)
check('same rule resent: name/location saved, timer untouched', v1['name'] == 'Viorent X' and v1['location'] == 'Ancient Sanctum' and v1['next_spawn'] == v0['next_spawn'], (v0['next_spawn'], v1['next_spawn']))

# a boss that is up right now keeps being up
sql(f"UPDATE bosses SET status='spawned', spawned_at={now}, auto_reset_at={now + 300000} WHERE id='{vio}'")
api('PUT', f'/api/teams/{team}/bosses/{vio}', {'name': 'Viorent', 'type': 'interval', 'intervalMs': 10 * H}, tok)
v2 = boss(vio)
check('editing a boss that is UP keeps it up', v2['status'] == 'spawned' and v2['auto_reset_at'] == now + 300000, v2['status'])

# a real rule change still recalculates from the last kill
api('PUT', f'/api/teams/{team}/bosses/{vio}', {'type': 'interval', 'intervalMs': 11 * H}, tok)
v3 = boss(vio)
check('real rule change recalculates from the last kill', v3['next_spawn'] == v3['last_death'] + 11 * H and v3['status'] == 'waiting', v3)

s0 = boss(sap)
api('PUT', f'/api/teams/{team}/bosses/{sap}', {'name': 'Saphirus', 'type': 'fixed', 'fixedTime': '11:30', 'location': 'Hall'}, tok)
check('fixed-time boss: same time resent keeps the timer', boss(sap)['next_spawn'] == s0['next_spawn'] and boss(sap)['location'] == 'Hall')
api('PUT', f'/api/teams/{team}/bosses/{sap}', {'type': 'fixed', 'fixedTime': '12:30'}, tok)
check('fixed-time boss: new time recalculates', boss(sap)['next_spawn'] != s0['next_spawn'])

# ---- browser: what the edit form actually sends
sent = []
with sync_playwright() as p:
    chrome = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
    b = p.chromium.launch(executable_path=chrome, headless=True) if os.path.exists(chrome) else p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1100, 'height': 900})
    pg.on('request', lambda r: r.method == 'PUT' and '/bosses/' in r.url and sent.append(r.post_data_json))
    pg.goto('http://127.0.0.1:8790/?token=' + urllib.parse.quote(tok, safe=''))
    pg.wait_for_timeout(1200)
    pg.evaluate(f"openTeam('{team}')"); pg.wait_for_timeout(1200)
    pg.evaluate("openModule('timers')"); pg.wait_for_timeout(1200)
    before = boss(vio)['next_spawn']
    pg.click(f'[data-action="edit"][data-id="{vio}"]'); pg.wait_for_timeout(400)
    pg.fill('#bfLocation', 'Channel 3'); pg.click('#bossForm button[type="submit"]'); pg.wait_for_timeout(1200)
    check('form: location edit sends only the location', sent and sent[-1] == {'location': 'Channel 3'}, sent)
    check('form: timer untouched after the edit', boss(vio)['next_spawn'] == before and boss(vio)['location'] == 'Channel 3')
    n = len(sent)
    pg.click(f'[data-action="edit"][data-id="{vio}"]'); pg.wait_for_timeout(400)
    pg.click('#bossForm button[type="submit"]'); pg.wait_for_timeout(800)
    check('form: saving with no changes sends nothing', len(sent) == n, sent[n:])
    pg.click(f'[data-action="edit"][data-id="{vio}"]'); pg.wait_for_timeout(400)
    pg.fill('#bfHours', '12'); pg.click('#bossForm button[type="submit"]'); pg.wait_for_timeout(1200)
    check('form: changing the respawn sends the rule', sent[-1] == {'type': 'interval', 'intervalMs': 12 * H}, sent[-1])
    b.close()
print(f'{sum(res)}/{len(res)} checks passed')
