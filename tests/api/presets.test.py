"""M10 game presets API test against `wrangler dev --local` (port 8788)."""
import json, sys, urllib.request, urllib.error

W = 'http://127.0.0.1:8788'
checks = []

def req(method, path, body=None, token=None):
    data = None; headers = {}
    if body is not None: data = json.dumps(body).encode(); headers['Content-Type'] = 'application/json'
    if token: headers['Authorization'] = 'Bearer ' + token
    r = urllib.request.Request(W + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp: return resp.status, json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {'raw': raw.decode(errors='replace')}

def check(name, cond, info=''):
    checks.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'   <- {info}'))

def guest(name):
    s, d = req('POST', '/auth/guest', {'username': name}); return d['token']

leader = guest('preset_leader'); member = guest('preset_member')
s, d = req('POST', '/api/teams', {'name': 'Preset Guild'}, leader); team = d.get('id') or d.get('team', {}).get('id')
check('team created', s == 200 and team, d)
s, d = req('GET', f'/api/teams/{team}', token=leader)
code = (d.get('team') or d).get('invite_code')
s, d = req('POST', f'/api/invite/{code}', {}, member)
check('member joined', s == 200 and not d.get('error'), d)
s, d = req('GET', f'/api/teams/{team}', token=member)
check('member really is in the team', s == 200 and (d.get('team') or d).get('my_role') == 'member', d)
check('team detail carries its timezone', (d.get('team') or d).get('timezone') == 'Asia/Manila', (d.get('team') or d).get('timezone'))

s, d = req('GET', '/api/presets', token=leader)
ln = next((p for p in d.get('presets', []) if p['id'] == 'lordnine'), None)
check('presets list has Lord Nine with 40+ bosses', s == 200 and ln and len(ln['bosses']) >= 40, d if not ln else len(ln['bosses']))
types = {b['type'] for b in ln['bosses']}
check('preset covers interval/weekly/biweekly/twicedaily', {'interval', 'weekly', 'biweekly', 'twicedaily'} <= types, types)

s, d = req('POST', f'/api/teams/{team}/bosses/presets', {'presetId': 'lordnine'}, member)
check('plain member cannot apply presets', s == 403, d)
s, d = req('POST', f'/api/teams/{team}/bosses/presets', {'presetId': 'nope'}, leader)
check('unknown preset -> 404', s == 404, d)

s, d = req('POST', f'/api/teams/{team}/bosses/presets', {'presetId': 'lordnine', 'names': ['Venatus', 'Roderick', 'Auraq', 'Ratan / Parto / Nedra']}, leader)
check('named subset added', s == 200 and sorted(d.get('added', [])) == sorted(['Venatus', 'Roderick', 'Auraq', 'Ratan / Parto / Nedra']), d)
s, d = req('GET', f'/api/teams/{team}/bosses', token=leader)
bosses = d.get('bosses', d if isinstance(d, list) else [])
byname = {b['name']: b for b in bosses}
check('4 bosses in the team', len(bosses) == 4, len(bosses))
import time
now = time.time() * 1000
check('interval boss next_spawn ~ +10h', abs(byname['Venatus']['next_spawn'] - (now + 10 * 3600000)) < 120000, byname.get('Venatus'))
check('weekly boss next_spawn in the future within 7 days', 0 < byname['Roderick']['next_spawn'] - now <= 7 * 86400000 + 60000, byname.get('Roderick'))
check('biweekly boss stored its days', json.loads(byname['Auraq']['biweekly_days'])[0]['day'] == 5, byname.get('Auraq'))
check('twicedaily boss next_spawn within 24h', 0 < byname['Ratan / Parto / Nedra']['next_spawn'] - now <= 86400000 + 60000, byname.get('Ratan / Parto / Nedra'))

s, d = req('POST', f'/api/teams/{team}/bosses/presets', {'presetId': 'lordnine'}, leader)
check('full apply on free team stops at the cap (15) and reports the rest', s == 200 and d.get('cap') == 15 and len(d['added']) == 11 and len(d['skippedExisting']) == 4 and len(d['skippedCap']) == len(ln['bosses']) - 15, {k: (len(v) if isinstance(v, list) else v) for k, v in d.items()})
s, d = req('GET', f'/api/teams/{team}/bosses', token=leader)
check('team now holds exactly 15 timers', len(d.get('bosses', d if isinstance(d, list) else [])) == 15, len(d.get('bosses', [])))
s, d = req('POST', f'/api/teams/{team}/bosses/presets', {'presetId': 'lordnine'}, leader)
check('re-apply adds nothing (all existing or capped)', s == 200 and d['added'] == [], d)

# plain create still works through the shared builder
s, d = req('POST', f'/api/teams/{team}/bosses', {'name': 'Manual', 'type': 'interval', 'intervalMs': 3600000}, leader)
check('manual create beyond cap is refused (cap intact)', s == 403 and d.get('premiumRequired'), d)

# --- preset sync: pulls corrected preset data into matching timers ---
s, d = req('POST', f'/api/teams/{team}/bosses/presets/sync', {'presetId': 'lordnine'}, member)
check('plain member cannot sync', s == 403, d)
s, d = req('POST', f'/api/teams/{team}/bosses/presets/sync', {'presetId': 'nope'}, leader)
check('sync with unknown preset -> 404', s == 404, d)

# drift three timers away from the preset, then sync them back
req('PUT', f"/api/teams/{team}/bosses/{byname['Venatus']['id']}", {'intervalMs': 39600000}, leader)
req('PUT', f"/api/teams/{team}/bosses/{byname['Roderick']['id']}", {'weeklyTime': '20:00'}, leader)
req('PUT', f"/api/teams/{team}/bosses/{byname['Auraq']['id']}", {'location': 'Wrong spot'}, leader)
s, d = req('POST', f'/api/teams/{team}/bosses/presets/sync', {'presetId': 'lordnine'}, leader)
check('sync reports exactly the drifted timers as updated', s == 200 and sorted(d.get('updated', [])) == ['Auraq', 'Roderick', 'Venatus'], d)
check('sync counts: 12 unchanged, none added, rest capped', d.get('unchanged') == 12 and d.get('added') == [] and len(d.get('skippedCap', [])) == len(ln['bosses']) - 15, {k: (len(v) if isinstance(v, list) else v) for k, v in d.items()})
s, d = req('GET', f'/api/teams/{team}/bosses', token=leader)
byname = {b['name']: b for b in d.get('bosses', [])}
check('sync restored the interval rule', byname['Venatus']['interval_ms'] == 36000000, byname.get('Venatus'))
check('sync restored the weekly time', byname['Roderick']['weekly_time'] == '19:00', byname.get('Roderick'))
check('sync restored the location', byname['Auraq'].get('location') in (None, ''), byname.get('Auraq'))
now = time.time() * 1000
check('synced interval boss got a fresh next_spawn (~ +10h, no kill logged)', abs(byname['Venatus']['next_spawn'] - (now + 10 * 3600000)) < 120000, byname.get('Venatus'))
s, d = req('POST', f'/api/teams/{team}/bosses/presets/sync', {'presetId': 'lordnine'}, leader)
check('second sync is a no-op (15 already current)', s == 200 and d.get('updated') == [] and d.get('unchanged') == 15, d)

n = sum(checks); print(f'\n{n}/{len(checks)} checks passed'); sys.exit(0 if n == len(checks) else 1)
