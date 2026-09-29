"""Screenshot import reads EVERY time right: two 60-line schedules (each minute 00-59, AM and PM, two
Discord-like layouts) through the real Import dialog. Guards the 2026-09-30 fix (js/modules/ocr-image.js):
before it, a plain 1x Discord crop read "4:29" as "4:20" and PM as AM on 3-9 lines out of 60.
Site proxy 8790 + wrangler dev 8788."""
import json, os, sys, time, urllib.request, urllib.parse
from playwright.sync_api import sync_playwright

W = 'http://127.0.0.1:8788'
SITE = 'http://127.0.0.1:8790'
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.out')
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
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

NAMES = ['Lady Dalia', 'Araneo', 'Livera', 'Wannitas', 'Metus', 'Duplican', 'Undomiel', 'Titore', 'Baron Braudmore', 'Gareth',
         'Neutro', 'Icaruthia', 'Rakajeth', 'Catena', 'Shuliar', 'Larba', 'Venatus', 'Viorent', 'Ego', 'Saphirus']
TAGS = ['Kongreso', 'Senado', None]
# (hour for minute m, AM/PM for m, background, code font size)
LAYOUTS = {
    'layout A': (lambda m: (m * 7) % 12 + 1, lambda m: 'AM' if m % 2 == 0 else 'PM', '#2b2724', '14px'),
    'layout B': (lambda m: (m * 5 + 3) % 12 + 1, lambda m: 'PM' if m % 3 == 0 else 'AM', '#313338', '13.6px'),
}

def image_html(times, bg, size):
    pill = lambda t: '<code>' + t.ljust(8).replace(' ', '&nbsp;') + '</code>'
    rows = ''.join(f'<div>{pill(t)} | {NAMES[i % 20]} ({70 + i}){f" | <span class=tag>@{TAGS[i % 3]}</span>" if TAGS[i % 3] else ""}</div>' for i, t in enumerate(times))
    return f"""<html><body style="margin:0;background:{bg};color:#dbdee1;font:16px 'gg sans','Segoe UI',sans-serif;padding:16px;width:460px">
<style>code{{background:#1e1f22;border:1px solid #3f4147;border-radius:4px;padding:1px 4px;font-family:Consolas,monospace;font-size:{size}}}
div{{line-height:1.9}} .tag{{background:#4b3a26;color:#f0b232;border-radius:3px;padding:0 2px}}</style>{rows}</body></html>"""

_, g = api('POST', '/auth/guest', {'username': 'OCR Lead'}); tok = g['token']
_, t = api('POST', '/api/teams', {'name': 'OCR Guild'}, tok); team = t.get('id') or t['team']['id']
api('PUT', f'/api/teams/{team}/settings', {'timezone': 'Asia/Manila'}, tok)

with sync_playwright() as p:
    br = p.chromium.launch(executable_path=CHROME, headless=True) if os.path.exists(CHROME) else p.chromium.launch(headless=True)
    pg = br.new_page(viewport={'width': 1100, 'height': 1000}, color_scheme='dark', timezone_id='Asia/Manila')
    pg.goto(SITE + '/?token=' + urllib.parse.quote(tok, safe=''))
    pg.wait_for_timeout(1200)
    pg.evaluate(f"openTeam('{team}')"); pg.wait_for_timeout(1200)
    pg.evaluate("openModule('timers')"); pg.wait_for_timeout(1200)
    for name, (hour, ampm, bg, size) in LAYOUTS.items():
        times = [f'{hour(m)}:{m:02d} {ampm(m)}' for m in range(60)]
        img = br.new_page(viewport={'width': 492, 'height': 60 + 32 * len(times)})
        img.set_content(image_html(times, bg, size))
        shot = os.path.join(OUT, f'ocr_{name[-1]}.png'); img.screenshot(path=shot); img.close()

        pg.click('[data-role="menu"] summary'); pg.click('[data-action="import-shot"]')
        pg.wait_for_selector('.si-drop')
        pg.set_input_files('[data-role="file"]', shot)
        t0 = time.time()
        pg.wait_for_selector('.si-row', timeout=120000)
        secs = time.time() - t0
        read = pg.eval_on_selector_all('.si-row .si-time', "els => els.map(e => e.firstChild.textContent.replace(/\\s+/g, ' ').trim())")
        want = list(times)
        wrong = []
        for r in read:
            if r in want: want.remove(r)
            else: wrong.append(r)
        check(f'{name}: all 60 times read right, none wrong ({secs:.1f}s)', not wrong and not want, {'wrong': wrong, 'missing': want})
        pg.click('[data-act="close"]'); pg.wait_for_timeout(300)
    br.close()

print(f'{sum(res)}/{len(res)} checks passed')
sys.exit(0 if all(res) else 1)
