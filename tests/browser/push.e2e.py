"""Phone alerts in a real browser: the Phone alerts dialog turns a device on, and sw.js keeps ONE
notification per team in step with the bosses (soon -> up -> killed = closed). Pushes are delivered
with Chrome DevTools (ServiceWorker.deliverPushMessage), so the service worker runs for real.
Site proxy 8790 + wrangler dev 8788. Screenshots: tests/.out/push_dialog_*.png"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request, urllib.parse
from playwright.sync_api import sync_playwright

W = 'http://127.0.0.1:8788'
SITE = 'http://127.0.0.1:8790'
WORKER = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'worker')
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

def sql(q):
    subprocess.run(f'npx wrangler d1 execute guild-manager --local --command "{q}"', cwd=WORKER, shell=True, capture_output=True)
def cron():
    urllib.request.urlopen(W + '/__scheduled?cron=*+*+*+*+*').read(); time.sleep(1.5)

_, g = api('POST', '/auth/guest', {'username': 'push_e2e'}); tok = g['token']
_, t = api('POST', '/api/teams', {'name': 'Bubble Guild'}, tok); team = t.get('id') or t['team']['id']
api('PUT', f'/api/teams/{team}/settings', {'spawnGroups': [{'name': 'Kongreso'}, {'name': 'Senado'}]}, tok)
H = 3600000
now = int(time.time() * 1000)
_, a = api('POST', f'/api/teams/{team}/bosses', {'name': 'Venatus', 'type': 'interval', 'intervalMs': 10 * H}, tok); ven = a['id']
_, a = api('POST', f'/api/teams/{team}/bosses', {'name': 'Ego', 'type': 'interval', 'intervalMs': 10 * H}, tok); ego = a['id']
sql(f"UPDATE bosses SET next_spawn={now + 5 * H} WHERE team_id='{team}'")
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    chrome = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
    # Playwright's --disable-background-networking also switches off Chrome's push service connection
    # and push is refused in incognito-style profiles, so this uses a real (throwaway) profile
    opts = {'headless': True, 'ignore_default_args': ['--disable-background-networking', '--disable-component-update'], 'viewport': {'width': 1100, 'height': 900}}
    if os.path.exists(chrome): opts['executable_path'] = chrome
    profile = tempfile.mkdtemp(prefix='gm-push-')
    ctx = p.chromium.launch_persistent_context(profile, **opts)
    b = ctx
    ctx.grant_permissions(['notifications'], origin=SITE)
    pg = ctx.new_page()
    pg.goto(SITE + '/?token=' + urllib.parse.quote(tok, safe=''))
    pg.wait_for_timeout(1500)
    pg.evaluate(f"openTeam('{team}')"); pg.wait_for_timeout(1000)

    # ---- dialog
    pg.click('#userInfo summary'); pg.wait_for_timeout(200)
    pg.click('text=Phone alerts'); pg.wait_for_timeout(1200)
    text = pg.inner_text('.pa-card')
    check('dialog: device off, one team with both kinds and its groups + "No group"', 'Off for this device' in text and 'Bubble Guild' in text
          and pg.locator('.pa-chip').count() == 3 and pg.locator('[data-role="soon"]').is_checked() and pg.locator('[data-role="spawned"]').is_checked(), text)
    pg.locator('.pa-card').screenshot(path=os.path.join(OUT, 'push_dialog_off.png'))

    pg.click('[data-act="on"]'); pg.wait_for_timeout(6000)
    text = pg.inner_text('.pa-card')
    endpoint = pg.evaluate("navigator.serviceWorker.getRegistration().then(r => r && r.pushManager.getSubscription()).then(s => s && s.endpoint)")
    check('turn on: the browser subscribed and the dialog says On', 'On for this device' in text and bool(endpoint), [text[:200], endpoint])
    pg.locator('.pa-card').screenshot(path=os.path.join(OUT, 'push_dialog_on.png'))
    _, pr = api('GET', '/api/push/prefs?endpoint=' + urllib.parse.quote(endpoint or '', safe=''), None, tok)
    check('turn on: the worker has this device', pr.get('device') is True, pr)

    # untick Senado: saved as a group filter
    pg.locator('.pa-chip', has_text='Senado').click(); pg.wait_for_timeout(1200)
    _, pr = api('GET', '/api/push/prefs', None, tok)
    groups = next(x for x in pr['teams'] if x['id'] == team)['groups']
    check('group chip: unticking Senado saves "Kongreso + No group"', groups is not None and len(groups) == 2, groups)
    pg.locator('.pa-chip', has_text='Senado').click(); pg.wait_for_timeout(1200)   # back to all
    pg.click('[data-close]')

    # ---- service worker, pushes delivered through DevTools
    cdp = ctx.new_cdp_session(pg)
    regs = []
    cdp.on('ServiceWorker.workerRegistrationUpdated', lambda e: regs.extend(e['registrations']))
    cdp.send('ServiceWorker.enable'); pg.wait_for_timeout(800)
    reg_id = next((r['registrationId'] for r in regs if r['scopeURL'].startswith(SITE)), None)
    check('service worker registered for the site', bool(reg_id), regs)

    def push():
        cdp.send('ServiceWorker.deliverPushMessage', {'origin': SITE + '/', 'registrationId': reg_id, 'data': ''})
        pg.wait_for_timeout(2500)
    def shown():
        return pg.evaluate("navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.map(n => ({ tag: n.tag, title: n.title, body: n.body, sticky: n.requireInteraction, silent: n.silent })))")

    sql(f"UPDATE bosses SET status='waiting', warned=1, next_spawn={int(time.time() * 1000) + 180000} WHERE id='{ven}'")
    push()
    n = shown()
    check('soon: one notification for the team, titled with Venatus spawning, with sound', len(n) == 1 and n[0]['tag'] == f'team-{team}' and 'Venatus spawns in' in n[0]['title'] and not n[0]['silent'], n)

    sql(f"UPDATE bosses SET status='waiting', warned=1, next_spawn={int(time.time() * 1000) + 240000} WHERE id='{ego}'")
    push()
    n = shown()
    check('second boss: still ONE notification, now titled Ego, both listed', len(n) == 1 and 'Ego spawns in' in n[0]['title'] and 'Venatus' in n[0]['body'] and 'Ego' in n[0]['body'], n)

    sql(f"UPDATE bosses SET status='spawned', next_spawn={int(time.time() * 1000) - 1000} WHERE id='{ven}'")
    push()
    n = shown()
    check('spawned: same notification, "Venatus is up", stays on screen while up', len(n) == 1 and 'Venatus is up' in n[0]['title'] and n[0]['sticky'], n)

    push()
    n = shown()
    check('a wake-up with nothing new: no extra notification', len(n) == 1 and 'Venatus is up' in n[0]['title'], n)

    api('POST', f'/api/teams/{team}/bosses/{ven}/kill', {}, tok)
    push()
    n = shown()
    check('Venatus killed: quiet update, only Ego left', len(n) == 1 and 'Venatus' not in n[0]['body'] and 'Ego' in n[0]['body'] and n[0]['silent'], n)

    sql(f"UPDATE bosses SET status='waiting', warned=0, next_spawn={int(time.time() * 1000) + 5 * H} WHERE id='{ego}'")
    push()
    pg.wait_for_timeout(3000)
    check('all clear: the notification goes away by itself', shown() == [], shown())

    # swiped away, then a wake-up without anything new: it must not come back ringing
    sql(f"UPDATE bosses SET status='waiting', warned=1, next_spawn={int(time.time() * 1000) + 180000} WHERE id='{ego}'")
    push()
    pg.evaluate("navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.forEach(n => n.close()))")
    push()
    pg.wait_for_timeout(3000)
    check('swiped away: a wake-up with nothing new does not bring it back', all(x['tag'] != f'team-{team}' for x in shown()), shown())

    # test alert
    r = pg.evaluate("navigator.serviceWorker.ready.then(r => r.pushManager.getSubscription()).then(s => s.endpoint)")
    api('POST', '/api/push/test', {'endpoint': r}, tok)   # the real push service may or may not reach headless Chrome; deliver it ourselves
    push()
    check('test alert shows', any(x['title'] == 'Test alert' for x in shown()), shown())
    ctx.close()
    shutil.rmtree(profile, ignore_errors=True)

print(f'{sum(res)}/{len(res)} checks passed')
sys.exit(0 if all(res) else 1)
